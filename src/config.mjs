/**
 * Config loading. A project drops `devframes.config.mjs` (or `.json`) in its
 * repo root; everything is optional and merged over DEFAULTS, so a plain Vite
 * app needs no config at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_FILES = ["devframes.config.mjs", "devframes.config.js", "devframes.config.json"];

export const DEFAULTS = Object.freeze({
  /**
   * Ref the Changes panel and Combine compare against (ahead/behind, incoming,
   * reset base). null = the remote's HEAD, else origin/main, origin/master,
   * main, master (see resolveBaseRef).
   */
  baseRef: null,
  /** Port the devframes UI itself listens on. */
  uiPort: 5180,
  /**
   * Dev server command for a session. null = detect from package.json (Vite,
   * Next.js, Astro, SvelteKit, Remix, Nuxt, CRA, or a plain `dev` script).
   * Non-Node projects set it themselves. Placeholders:
   *   {port} {root} (the worktree) {mainRoot} (the main checkout)
   *   {cacheDir} (a per-session scratch dir) {name}
   */
  command: null,
  /** Command for the main checkout; defaults to `command`. */
  mainCommand: null,
  /** Fixed port for the main checkout (null = allocate from `ports`). */
  mainPort: null,
  /** Port range for sessions, inclusive. */
  ports: [5175, 5224],
  /** Extra env for every dev server. */
  env: {},
  /**
   * Named env sets a session can be switched between from the UI, e.g.
   * `{ fixtures: { env: { API: "off" } }, live: { env: { API: "local" } } }`.
   * The chosen profile's env is merged over `env`; switching restarts that
   * session. `defaultProfile` is used until a session picks one.
   */
  profiles: {},
  defaultProfile: null,
  /** Path polled until it answers (<500) before a session counts as running. */
  readyPath: "/",
  /** "http" = readyPath answers with a status below 500; "tcp" = the port accepts connections. */
  readyCheck: "http",
  readyTimeoutMs: 120_000,
  /** Viewports drawn side by side for the active session. */
  viewports: [
    { name: "phone", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 900 },
  ],
  /**
   * Size presets per viewport name, cycled from the frame label (or the `p` key)
   * and picked in the settings modal (gear). CSS points, portrait; `rotate` swaps
   * them. A viewport can also carry its own `presets: [...]`, which wins. Only
   * viewports that have presets get the picker. Identical sizes are listed once.
   */
  presets: {
    tablet: [
      { id: "ipad-mini", label: "iPad mini", width: 744, height: 1133 },
      { id: "ipad-10", label: 'iPad 10th gen / iPad Air 11"', width: 820, height: 1180 },
      { id: "ipad-pro-11", label: 'iPad Pro 11"', width: 834, height: 1210 },
      { id: "ipad-air-13", label: 'iPad Air 13"', width: 1024, height: 1366 },
      { id: "ipad-pro-13", label: 'iPad Pro 13"', width: 1032, height: 1376 },
    ],
  },
  /** Quick-route buttons in the toolbar. */
  routes: ["/"],
  /** Route a session opens on. */
  startPath: "/",
  /**
   * Worktree setup, run before a non-main session starts. Each `link` entry is
   * symlinked from the main checkout when the worktree doesn't have its own.
   * `badge` labels the row while the shared copy is in use — always, or only
   * `when: "lockfileDiffers"` — and clicking it removes the link and runs
   * `fix` ("install" → installCommand, "setup" → setupCommand).
   */
  worktree: {
    link: null, // auto: node_modules when a package.json exists, else nothing
    /** Keep the links out of every worktree's `git status` via info/exclude. */
    exclude: true,
  },
  /** Where Combine builds its throwaway preview branch (relative to the repo root). */
  combine: {
    worktreeDir: ".devframes/combined",
    branch: "devframes/combined",
  },
  /** Lockfile compared against main's for the "deps differ" badge. */
  lockfile: null, // auto-detect
  /** Install command used by the "deps differ" fix. null = detect from lockfile. */
  installCommand: null,
  /** Optional setup command (the "setup" fix), e.g. a content emit. */
  setupCommand: null,
  /** Stop sessions nobody viewed for this long (pinned sessions are exempt). */
  idleTimeoutMs: 15 * 60_000,
  /** Most sessions running at once; starting another stops the least recently used unpinned one. */
  maxRunning: 4,
  /** Static links shown in the sidebar (servers devframes doesn't manage). */
  links: [],
});

/** Deep-ish merge: plain objects merge one level, everything else replaces. */
export function mergeConfig(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    const b = base[k];
    if (v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)) {
      out[k] = { ...b, ...v };
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function findRepoRoot(cwd = process.cwd()) {
  try {
    // --show-toplevel of the MAIN checkout even when run inside a worktree.
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
    }).trim();
    return common.endsWith("/.git") ? common.slice(0, -5) : execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

export const NODE_MODULES_LINK = Object.freeze({
  path: "node_modules",
  badge: "deps differ",
  when: "lockfileDiffers",
  fix: "install",
});

const git = (root, args) => {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

/**
 * The ref to compare against: the remote's HEAD (`origin/HEAD`), else the first
 * of origin/main, origin/master, main, master that exists, else "origin/main".
 */
export function resolveBaseRef(root) {
  const head = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head && git(root, ["rev-parse", "--verify", "-q", head]) != null) return head;
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "-q", ref]) != null) return ref;
  }
  return "origin/main";
}

export function detectLockfile(root) {
  for (const f of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "bun.lock"]) {
    if (existsSync(join(root, f))) return f;
  }
  return null;
}

export function installCommandFor(lockfile) {
  return (
    {
      "pnpm-lock.yaml": "pnpm install --frozen-lockfile",
      "package-lock.json": "npm ci",
      "yarn.lock": "yarn install --frozen-lockfile",
      "bun.lockb": "bun install --frozen-lockfile",
      "bun.lock": "bun install --frozen-lockfile",
    }[lockfile] ?? "npm install"
  );
}

function readPackageJson(root) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

const RUNNERS = { "pnpm-lock.yaml": "pnpm exec", "yarn.lock": "yarn", "bun.lockb": "bunx", "bun.lock": "bunx" };
const SCRIPT_RUNNERS = { "pnpm-lock.yaml": "pnpm run", "yarn.lock": "yarn", "bun.lockb": "bun run", "bun.lock": "bun run" };
const PORT_FLAG_TOOLS = /\b(vite|rsbuild|rspack|webpack(-dev-server)?|ng serve|storybook|astro|nuxt|next)\b/;

/**
 * Pick a dev command from package.json and the lockfile. Returns
 * `{ command, framework }`, or null when there's nothing to go on (no
 * package.json, or no dev/start script and no known framework).
 */
export function detectCommand(root) {
  const pkg = readPackageJson(root);
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (name) => name in deps;
  const lock = detectLockfile(root);
  const x = RUNNERS[lock] ?? "npx";
  const hit = (framework, command) => ({ framework, command });
  if (has("next")) return hit("Next.js", `${x} next dev -p {port}`);
  if (has("nuxt") || has("nuxt3")) return hit("Nuxt", `${x} nuxt dev --port {port}`);
  if (has("astro")) return hit("Astro", `${x} astro dev --port {port}`);
  if (has("@sveltejs/kit")) return hit("SvelteKit", `${x} vite dev --port {port} --strictPort`);
  if (Object.keys(deps).some((d) => d.startsWith("@remix-run/"))) {
    return has("vite")
      ? hit("Remix", `${x} remix vite:dev --port {port}`)
      : hit("Remix", `PORT={port} ${x} remix dev`);
  }
  if (has("react-scripts")) return hit("Create React App", `BROWSER=none PORT={port} ${x} react-scripts start`);
  if (has("vite")) return hit("Vite", `${x} vite --port {port} --strictPort`);
  const script = pkg.scripts?.dev ? "dev" : pkg.scripts?.start ? "start" : null;
  if (!script) return null;
  const run = SCRIPT_RUNNERS[lock] ?? "npm run";
  const sep = run === "npm run" ? " --" : "";
  const flag = PORT_FLAG_TOOLS.test(pkg.scripts[script]) ? `${sep} --port {port}` : "";
  return hit(`package.json "${script}" script`, `PORT={port} ${run} ${script}${flag}`);
}

export async function loadConfig(root = findRepoRoot()) {
  let user = {};
  let file = null;
  for (const name of CONFIG_FILES) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    file = p;
    if (name.endsWith(".json")) user = JSON.parse(readFileSync(p, "utf8"));
    else user = (await import(`${pathToFileURL(p).href}?t=${Date.now()}`)).default ?? {};
    break;
  }
  const cfg = mergeConfig(DEFAULTS, user);
  cfg.root = root;
  cfg.configFile = file;
  cfg.lockfile ??= detectLockfile(root);
  cfg.installCommand ??= installCommandFor(cfg.lockfile);
  cfg.baseRef ??= resolveBaseRef(root);
  if (cfg.command == null) {
    const found = detectCommand(root);
    cfg.command = found?.command ?? null;
    cfg.detected = found;
  }
  cfg.mainCommand ??= cfg.command;
  cfg.worktree = {
    ...cfg.worktree,
    link: cfg.worktree.link ?? (existsSync(join(root, "package.json")) ? [{ ...NODE_MODULES_LINK }] : []),
  };
  return cfg;
}

/** Profile name in force for a session: its saved choice, else the default (if it exists). */
export function activeProfile(cfg, saved) {
  const names = Object.keys(cfg.profiles ?? {});
  if (saved && names.includes(saved)) return saved;
  return cfg.defaultProfile && names.includes(cfg.defaultProfile) ? cfg.defaultProfile : null;
}

/** Base `env` with the profile's env merged over it. */
export function profileEnv(cfg, name) {
  return { ...cfg.env, ...(name ? cfg.profiles?.[name]?.env : null) };
}

export function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** A starter config; `command` is prefilled when one was detected. */
export function starterConfig(detected = null) {
  const command = detected
    ? `  command: ${JSON.stringify(detected.command)},`
    : `  // command: "python manage.py runserver {port}",  // nothing detected: set your dev command`;
  return `// devframes config — every key is optional; see the devframes README.
export default {
  // Dev server per session. {port} {root} {mainRoot} {cacheDir} {name}
${command}
  // mainPort: 5174,                 // pin the main checkout to a port
  ports: [5175, 5224],
  env: {},
  readyPath: "/",                    // any status below 500 counts as up
  // readyCheck: "tcp",              // for servers that don't speak HTTP first
  // baseRef: "origin/main",         // default: the remote's HEAD
  viewports: [
    { name: "phone", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 900 },
  ],
  routes: ["/"],
  // combine: { worktreeDir: ".devframes/combined", branch: "devframes/combined" },
  // setupCommand: "npm run codegen",
  idleTimeoutMs: 15 * 60_000,
  maxRunning: 4,
};
`;
}

export const STARTER_CONFIG = starterConfig();
