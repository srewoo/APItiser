/**
 * FastAPI apps usually define routes on a module's `router` and mount it elsewhere:
 *
 *   # server.py
 *   api_router = APIRouter(prefix="/api")
 *   from api.routes import users as _users
 *   api_router.include_router(_users.router)          # users' routes live under /api
 *   app.include_router(api_router)
 *
 * Without following those mounts across files, every route in `api/routes/users.py` is detected
 * without its `/api` prefix and every test 404s. This resolves, for each (file, router variable),
 * the prefix contributed by the routers it is mounted into (its own APIRouter prefix is applied
 * separately by the caller).
 */
import type { RepoFile } from '@shared/types';

type Ref = { file: string; name: string };

const key = (ref: Ref) => `${ref.file}::${ref.name}`;

/** `router = APIRouter(prefix="/v1")` (and Flask blueprints) per file. */
const ownPrefixes = (content: string): Map<string, string> => {
  const prefixes = new Map<string, string>();
  for (const m of content.matchAll(/(\w+)\s*=\s*APIRouter\s*\(([^)]*?)prefix\s*=\s*["']([^"']*)["']/g)) prefixes.set(m[1], m[3]);
  return prefixes;
};

/** Find the repo file for a dotted module, absolute or relative (leading dots) to `fromFile`. */
const moduleFile = (module: string, fromFile: string, paths: string[]): string | undefined => {
  const dots = /^\.+/.exec(module)?.[0].length ?? 0;
  const rest = module.slice(dots).replace(/\./g, '/');
  const candidates: string[] = [];
  if (dots) {
    const base = fromFile.split('/').slice(0, -dots).join('/');
    const stem = [base, rest].filter(Boolean).join('/');
    candidates.push(`${stem}.py`, `${stem}/__init__.py`);
    return candidates.find((c) => paths.includes(c));
  }
  // Absolute: the package root is unknown (backend/, src/, …) — match by path suffix.
  return paths.find((p) => p === `${rest}.py` || p.endsWith(`/${rest}.py`)) ??
    paths.find((p) => p === `${rest}/__init__.py` || p.endsWith(`/${rest}/__init__.py`));
};

/** alias → what it names: a module file, or a variable inside one. */
const importsOf = (file: RepoFile, paths: string[]): Map<string, { file: string; name?: string }> => {
  const out = new Map<string, { file: string; name?: string }>();
  // from pkg import a as b, c   (a may be a submodule OR a variable of pkg)
  for (const m of file.content.matchAll(/^\s*from\s+([.\w]+)\s+import\s+\(?([^)\n]+)\)?/gm)) {
    for (const part of m[2].split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/).map((s) => s.trim());
      if (!name || !/^\w+$/.test(name)) continue;
      const asModule = moduleFile(`${m[1]}${m[1].endsWith('.') ? '' : '.'}${name}`, file.path, paths);
      const parent = moduleFile(m[1], file.path, paths);
      if (asModule) out.set(alias || name, { file: asModule });
      else if (parent) out.set(alias || name, { file: parent, name });
    }
  }
  // import pkg.mod as alias
  for (const m of file.content.matchAll(/^\s*import\s+([\w.]+)\s+as\s+(\w+)/gm)) {
    const target = moduleFile(m[1], file.path, paths);
    if (target) out.set(m[2], { file: target });
  }
  return out;
};

export const resolveMountPrefixes = (files: RepoFile[]): Map<string, string> => {
  const paths = files.map((f) => f.path);
  const own = new Map(files.map((f) => [f.path, ownPrefixes(f.content)]));
  const mountedInto = new Map<string, { parent: Ref; prefix: string }>(); // child key → its mount

  for (const file of files) {
    if (!file.content.includes('include_router')) continue;
    const imports = importsOf(file, paths);
    for (const m of file.content.matchAll(/(\w+)\.include_router\(\s*([\w.]+)\s*(?:,([^)]*))?\)/g)) {
      const [, parentVar, childExpr, args = ''] = m;
      const prefix = /prefix\s*=\s*["']([^"']*)["']/.exec(args)?.[1] ?? '';
      const [head, attr] = childExpr.split('.');
      const imported = imports.get(head);
      const child: Ref | undefined = imported
        ? attr
          ? { file: imported.file, name: attr } // module.router
          : imported.name
            ? { file: imported.file, name: imported.name } // from mod import router as r
            : undefined
        : attr
          ? undefined
          : { file: file.path, name: head }; // a router defined in this same file
      if (child && !mountedInto.has(key(child))) mountedInto.set(key(child), { parent: { file: file.path, name: parentVar }, prefix });
    }
  }

  // Everything above a router: its parent's own prefix + the parent's mounts + the include prefix.
  const above = (ref: Ref, seen: Set<string>): string => {
    const mount = mountedInto.get(key(ref));
    if (!mount || seen.has(key(ref))) return '';
    seen.add(key(ref));
    const parentOwn = own.get(mount.parent.file)?.get(mount.parent.name) ?? '';
    return join(join(above(mount.parent, seen), parentOwn), mount.prefix);
  };

  const result = new Map<string, string>();
  for (const childKey of mountedInto.keys()) {
    const [file, name] = childKey.split('::');
    const prefix = above({ file, name }, new Set());
    if (prefix) result.set(childKey, prefix);
  }
  return result;
};

const join = (a: string, b: string): string => {
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
};
