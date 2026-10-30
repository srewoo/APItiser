import type { ApiEndpoint, RepoFile } from '@shared/types';
import { maskComments } from './maskComments';
import { buildEndpoint, joinPath, makeEvidence } from '../endpointBuilder';

/**
 * Ruby on Rails route detection. Parses `config/routes.rb` (and any `.rb` file that uses the
 * Rails router DSL) into concrete HTTP endpoints. Handles:
 *  - explicit verbs: `get/post/put/patch/delete '/path'`
 *  - `resources :things` / `resource :thing` (expanded to the API-relevant REST routes)
 *  - `namespace :admin do … end` and `scope '/api' do … end` path prefixing
 *  - `member do … end` (adds `/:id`) and `collection do … end` blocks
 *  - nested resources (`resources :users do resources :posts end`)
 *
 * This is a pragmatic line scanner, not a Ruby interpreter: it tracks a stack of ABSOLUTE
 * path-prefix frames opened by `do` and closed by `end`.
 */

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);

interface Frame {
  /** Absolute path prefix in effect inside this block. */
  full: string;
  /** For a resources block: absolute base for member routes (`…/:id`). */
  memberBase?: string;
  /** For a resources block: absolute base for collection routes (`…`). */
  collectionBase?: string;
}

const looksLikeRailsRoutes = (file: RepoFile): boolean =>
  /\.rb$/i.test(file.path) &&
  (/(^|\/)config\/routes\.rb$/i.test(file.path) ||
    /\bRails\.application\.routes\.draw\b/.test(file.content) ||
    /\b(resources?|namespace|scope)\b\s*[:'"]/.test(file.content));

const singularize = (word: string): string => {
  if (/ies$/.test(word)) return word.replace(/ies$/, 'y');
  if (/ses$/.test(word)) return word.replace(/es$/, '');
  if (/s$/.test(word)) return word.replace(/s$/, '');
  return word;
};

/** First quoted string OR leading symbol argument on a DSL line. */
const firstStringArg = (rest: string): string | null => {
  const quoted = /['"]([^'"]+)['"]/.exec(rest);
  if (quoted) return quoted[1];
  const symbol = /^\s*:([A-Za-z0-9_/]+)/.exec(rest);
  return symbol ? symbol[1] : null;
};

const openScopePrefix = (rest: string): string => {
  // scope '/api' | scope path: '/api' | scope '/api', module: 'x'
  const pathKw = /path:\s*['"]([^'"]+)['"]/.exec(rest);
  if (pathKw) return pathKw[1];
  const bare = /^\s*['"]([^'"]+)['"]/.exec(rest);
  return bare ? bare[1] : '';
};

export const parseRailsRoutes = (files: RepoFile[]): ApiEndpoint[] => {
  const endpoints: ApiEndpoint[] = [];

  for (const rawFile of files) {
    // Commented-out routes (`# get '/old'`) are not real routes.
    const file = { ...rawFile, content: maskComments(rawFile.content, 'ruby') };
    if (!looksLikeRailsRoutes(file)) continue;

    const stack: Frame[] = [];
    const currentFull = (): string => (stack.length ? stack[stack.length - 1].full : '');
    const seen = new Set<string>();

    const emit = (method: string, path: string, note: string): void => {
      const normalized = path || '/';
      const key = `${method} ${normalized}`;
      if (seen.has(key)) return;
      seen.add(key);
      endpoints.push(
        buildEndpoint({
          method,
          path: normalized,
          source: 'rails',
          file,
          summary: `${method} ${normalized}`,
          description: `Rails route (${note})`,
          confidence: 0.8,
          evidence: [makeEvidence(file, `Rails ${note}`, file.content.indexOf(note.split(' ')[0]))]
        })
      );
    };

    const emitResource = (name: string, base: string, singular: boolean): void => {
      if (singular) {
        emit('GET', base, `resource :${name}`);
        emit('POST', base, `resource :${name}`);
        emit('PATCH', base, `resource :${name}`);
        emit('DELETE', base, `resource :${name}`);
        return;
      }
      emit('GET', base, `resources :${name}`);
      emit('POST', base, `resources :${name}`);
      emit('GET', joinPath(base, ':id'), `resources :${name}`);
      emit('PATCH', joinPath(base, ':id'), `resources :${name}`);
      emit('DELETE', joinPath(base, ':id'), `resources :${name}`);
    };

    for (const rawLine of file.content.split('\n')) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) continue;

      if (/^end\b/.test(line)) {
        stack.pop();
        continue;
      }

      const opensBlock = /\bdo\b\s*(\|[^|]*\|)?\s*$/.test(line);
      const parentFull = currentFull();

      if (/routes\.draw\s+do/.test(line)) {
        stack.push({ full: '' });
        continue;
      }

      const namespaceMatch = /^namespace\s+/.exec(line);
      if (namespaceMatch) {
        const name = firstStringArg(line.slice(namespaceMatch[0].length)) ?? '';
        if (opensBlock) stack.push({ full: name ? joinPath(parentFull, name) : parentFull });
        continue;
      }

      const scopeMatch = /^scope\b/.exec(line);
      if (scopeMatch) {
        const prefix = openScopePrefix(line.slice(scopeMatch[0].length));
        if (opensBlock) stack.push({ full: prefix ? joinPath(parentFull, prefix) : parentFull });
        continue;
      }

      if (/^member\b/.test(line) && opensBlock) {
        const top = stack[stack.length - 1];
        stack.push({ full: top?.memberBase ?? parentFull });
        continue;
      }
      if (/^collection\b/.test(line) && opensBlock) {
        const top = stack[stack.length - 1];
        stack.push({ full: top?.collectionBase ?? parentFull });
        continue;
      }

      const resourcesMatch = /^(resources|resource)\s+/.exec(line);
      if (resourcesMatch) {
        const singular = resourcesMatch[1] === 'resource';
        const name = firstStringArg(line.slice(resourcesMatch[0].length));
        if (name) {
          const base = joinPath(parentFull, name);
          emitResource(name, base, singular);
          if (opensBlock) {
            const nestedFull = singular ? base : joinPath(base, `:${singularize(name)}_id`);
            stack.push({ full: nestedFull, memberBase: joinPath(base, ':id'), collectionBase: base });
          }
        }
        continue;
      }

      const verbMatch = /^([a-z]+)\s+(.*)$/.exec(line);
      if (verbMatch && HTTP_VERBS.has(verbMatch[1])) {
        const arg = firstStringArg(verbMatch[2]);
        if (arg !== null) {
          emit(verbMatch[1].toUpperCase(), joinPath(parentFull, arg), `${verbMatch[1]} '${arg}'`);
        }
        continue;
      }
    }
  }

  return endpoints;
};
