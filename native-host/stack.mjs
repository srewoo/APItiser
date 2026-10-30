/**
 * Stack planning for one-click "Start": find the repo's code (a local clone, or clone it),
 * decide which folder is the API, which infra services (databases, queues) it needs, and which
 * folder is the web frontend. Pure filesystem/text logic plus a small git wrapper — no
 * native-messaging I/O, so it is unit-tested directly.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STACK_MARKERS = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'manage.py', 'go.mod',
  'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'Procfile'
];
export const hasStackMarker = (dir) => STACK_MARKERS.some((file) => existsSync(path.join(dir, file)));

// --- locating the code -------------------------------------------------------

/** "github.com/owner/repo" (lowercase, no .git) from https / ssh / scp-style git URLs. */
export const normalizeRemote = (url) => {
  const text = String(url ?? '').trim();
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(text) ??
    /^(?:[^@/]+@)?([^/:]+):(.+?)(?:\.git)?\/?$/i.exec(text);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : '';
};

/** The `origin` remote URL from a clone's .git/config, without spawning git. */
export const readOriginUrl = (dir) => {
  try {
    const config = readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const section = /\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/.exec(config)?.[1] ?? '';
    return /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
};

// Never descended into: dependency/build trees, system folders, and the macOS folders that
// trigger a privacy prompt when a background process reads them (Desktop/Documents/Downloads).
// ponytail: fixed skip list; add a "search roots" setting if users keep code in those folders.
const SKIP_DIRS = new Set([
  'node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'Public', 'Desktop',
  'Documents', 'Downloads', 'venv', 'dist', 'build', 'target', 'vendor', 'go', 'Pods'
]);

/**
 * Find an existing clone of `slug` ("host/owner/repo") under `roots`, breadth-first so the
 * shallowest match wins. Stops descending at any git repo. Bounded by depth and directory count.
 */
export const findLocalClone = (slug, { roots = [os.homedir()], maxDepth = 3, maxDirs = 20_000 } = {}) => {
  const wanted = String(slug).toLowerCase();
  let queue = roots.filter((root) => existsSync(root)).map((dir) => ({ dir, depth: 0 }));
  let visited = 0;
  while (queue.length && visited < maxDirs) {
    const next = [];
    for (const { dir, depth } of queue) {
      visited += 1;
      if (existsSync(path.join(dir, '.git'))) {
        if (normalizeRemote(readOriginUrl(dir)) === wanted) return dir;
        continue; // a different repo — don't search inside it
      }
      if (depth >= maxDepth) continue;
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable (permissions) — skip quietly
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
          next.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
      }
    }
    queue = next;
  }
  return null;
};

/** Where APItiser keeps clones it makes itself (safe for it to update/reset). */
export const managedClonePath = (slug, base = path.join(os.homedir(), '.apitiser', 'repos')) =>
  path.join(base, ...String(slug).toLowerCase().split('/'));

const runGit = (args, options = {}) =>
  new Promise((resolve) => {
    const proc = spawn('git', args, { ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    proc.once('error', (error) => resolve({ code: -1, stderr: error.message }));
    proc.once('exit', (code) => resolve({ code: code ?? -1, stderr }));
  });

/**
 * Shallow-clone `cloneUrl` into `dest`, or refresh an existing managed clone. A token (private
 * repos) is sent as a one-off HTTP header, so it is never written into .git/config.
 */
export const cloneOrUpdate = async (cloneUrl, dest, { token, platform } = {}) => {
  const auth = token
    ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`${platform === 'gitlab' ? 'oauth2' : 'x-access-token'}:${token}`).toString('base64')}`]
    : [];
  if (existsSync(path.join(dest, '.git'))) {
    const fetched = await runGit([...auth, '-C', dest, 'fetch', '--depth', '1', 'origin']);
    if (fetched.code === 0) await runGit(['-C', dest, 'reset', '--hard', 'FETCH_HEAD']);
    return { updated: fetched.code === 0, error: fetched.code === 0 ? undefined : fetched.stderr.trim() };
  }
  const cloned = await runGit([...auth, 'clone', '--depth', '1', cloneUrl, dest]);
  if (cloned.code !== 0) {
    const reason = cloned.stderr.trim().split('\n').pop() ?? 'git clone failed';
    throw new Error(`Could not clone ${cloneUrl}: ${reason}${token ? '' : ' (private repo? add a GitHub/GitLab token in Settings)'}`);
  }
  return { updated: true };
};

// --- planning the stack ------------------------------------------------------

const API_DIR_NAMES = ['backend', 'api', 'server', 'service', 'apps/api', 'apps/backend', 'apps/server', 'services/api', 'packages/api'];
const FRONTEND_DIR_NAMES = ['frontend', 'web', 'client', 'ui', 'webapp', 'apps/web', 'apps/frontend', 'apps/client', 'packages/web', 'packages/frontend'];
const FRONTEND_DEPS = /^(react|react-dom|vue|svelte|next|nuxt|@angular\/core|vite|react-scripts|@sveltejs\/kit|solid-js)$/;

/**
 * The folder to boot as the API. `hint` is where the scanned routes live (relative path); walk
 * up from it to the nearest folder with a stack marker. Without a usable hint, prefer a
 * conventional backend folder when the root only has compose/Docker files.
 */
export const pickApiDir = (root, hint) => {
  if (hint) {
    let dir = path.resolve(root, hint);
    while (dir.startsWith(root)) {
      if (hasStackMarker(dir)) return dir;
      if (dir === root) break;
      dir = path.dirname(dir);
    }
  }
  if (hasStackMarker(root)) return root;
  return API_DIR_NAMES.map((name) => path.join(root, name)).find((dir) => hasStackMarker(dir)) ?? root;
};

const isFrontendPackage = (dir) => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((name) => FRONTEND_DEPS.test(name));
  } catch {
    return false;
  }
};

/** A separate web-frontend folder, if the repo has one (never the API folder itself). */
export const pickFrontendDir = (root, apiDir) =>
  FRONTEND_DIR_NAMES.map((name) => path.join(root, name)).find((dir) => dir !== apiDir && isFrontendPackage(dir)) ?? null;

/** Env vars common frontend toolchains read for the backend's URL. */
export const frontendEnv = (backendUrl) => ({
  BROWSER: 'none', // CRA: don't pop a browser tab
  REACT_APP_BACKEND_URL: backendUrl,
  REACT_APP_API_URL: backendUrl,
  REACT_APP_API_BASE_URL: backendUrl,
  VITE_API_URL: backendUrl,
  VITE_BACKEND_URL: backendUrl,
  VITE_API_BASE_URL: backendUrl,
  NEXT_PUBLIC_API_URL: backendUrl,
  NEXT_PUBLIC_BACKEND_URL: backendUrl,
  VUE_APP_API_URL: backendUrl,
  NUXT_PUBLIC_API_BASE: backendUrl
});

const ENV_SAMPLES = ['.env.example', '.env.sample', 'env.sample', '.env.template', 'env.example', '.env.dist'];

/**
 * Create `<appDir>/.env` from the repo's sample when missing (the app or the repo root).
 * Returns the sample used, or null. Never overwrites an existing .env.
 */
export const ensureEnvFile = (appDir, root) => {
  const target = path.join(appDir, '.env');
  if (existsSync(target)) return null;
  for (const dir of appDir === root ? [appDir] : [appDir, root]) {
    for (const name of ENV_SAMPLES) {
      const sample = path.join(dir, name);
      if (existsSync(sample) && statSync(sample).isFile()) {
        copyFileSync(sample, target);
        return sample;
      }
    }
  }
  return null;
};

// --- infra (databases, queues) from docker compose ---------------------------

export const findComposeFile = (dir) =>
  ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].map((f) => path.join(dir, f)).find((f) => existsSync(f)) ?? null;

/**
 * Services from a compose file: name, image, published host ports. Line-based on purpose (no
 * YAML dependency in the host). ponytail: handles the common 2-space layout; a real YAML
 * parser if anchors/extends or unusual indentation show up.
 */
export const parseComposeServices = (text) => {
  const services = [];
  let inServices = false;
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      inServices = /^services:\s*$/.test(line);
      current = null;
      continue;
    }
    if (!inServices) continue;
    const name = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (name) {
      current = { name: name[1], image: '', ports: [] };
      services.push(current);
      continue;
    }
    if (!current) continue;
    const image = /^\s+image:\s*["']?([^"'\s]+)/.exec(line);
    if (image) current.image = image[1];
    const port = /^\s+-\s*["']?(?:[\d.]+:)?(\d{2,5}):\d{2,5}/.exec(line);
    if (port) current.ports.push(Number(port[1]));
  }
  return services;
};

const INFRA_IMAGE = /(^|\/)(mongo|redis|valkey|postgres|postgis|mysql|mariadb|rabbitmq|elasticsearch|opensearch|memcached|kafka|cp-kafka|zookeeper|minio|localstack|mailhog|mailpit|clickhouse-server|cassandra|neo4j|nats)(:|$)/i;

/** Compose services that are infrastructure (a known DB/queue image), not the app itself. */
export const infraServices = (services) => services.filter((service) => INFRA_IMAGE.test(service.image));

// --- user-chosen locations ---------------------------------------------------

/** "~/code" → "/Users/me/code"; blank → ''. Paths come from extension settings. */
export const expandHome = (p) => {
  const text = String(p ?? '').trim();
  if (text === '~') return os.homedir();
  return text.startsWith('~/') ? path.join(os.homedir(), text.slice(2)) : text;
};

/**
 * Where to look for an existing clone, in priority order: the user's clone folder, their extra
 * folders, then home. Extra roots are searched even inside Documents etc. — the user asked.
 */
export const searchRootsFor = ({ cloneRoot, extraRoots = [] } = {}, home = os.homedir()) => {
  const roots = [cloneRoot, ...extraRoots, home].map(expandHome).filter((root) => root && existsSync(root));
  return [...new Set(roots.map((root) => path.resolve(root)))];
};

/**
 * Where a NEW clone goes. With a user clone folder: `<root>/<repo>` like a plain `git clone`
 * there, or `<root>/<owner>-<repo>` if that name is taken by something else. Without one:
 * APItiser's managed folder.
 */
export const cloneDestination = (slug, cloneRoot, cloneUrl) => {
  const root = expandHome(cloneRoot);
  if (!root) return { dest: managedClonePath(slug), managed: true };
  const parts = String(slug).split('/');
  // The repo's real name (case preserved) from the clone URL — slugs are lowercased for matching.
  const repo = /([^/]+?)(?:\.git)?\/?$/.exec(String(cloneUrl ?? ''))?.[1] || parts[parts.length - 1];
  const owner = parts.slice(1, -1).join('-');
  const plain = path.join(root, repo);
  const dest = existsSync(plain) ? path.join(root, `${owner}-${repo}`) : plain;
  return { dest, managed: false };
};

/** The OS's native "choose a folder" dialog, or null when none is available. */
export const folderPickerCommand = (platform = process.platform, prompt = 'Choose a folder') => {
  const quoted = String(prompt).replace(/["\\]/g, '');
  if (platform === 'darwin') {
    // Run inside the frontmost app (the browser) so the dialog appears in front, not behind it.
    return {
      cmd: 'osascript',
      args: ['-e', 'tell application (path to frontmost application as text)', '-e', `POSIX path of (choose folder with prompt "${quoted}")`, '-e', 'end tell']
    };
  }
  if (platform === 'win32') {
    return {
      cmd: 'powershell',
      args: ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "${quoted}"; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }`]
    };
  }
  return { cmd: 'zenity', args: ['--file-selection', '--directory', `--title=${quoted}`] };
};
