<div align="center">

# devframes

**Every git worktree's dev server, live, side by side, in one browser tab.**

Phone, tablet and desktop previews of all your branches at once. Built for running
several coding sessions in parallel (one AI agent or teammate per worktree) and
flipping between their in-progress UIs instantly.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

</div>

---

## Why

Worktrees make it easy to work on five branches at once. Looking at five branches
at once is still a mess: five terminals, five dev servers, five ports, five browser
tabs that forget where you were. devframes turns that into one sidebar and one view.

## Features

- **Every worktree in one sidebar.** Branch, uncommitted-file count, last-commit age
  and status, discovered from `git worktree list`.
- **One-click dev servers.** ▶ / ■ start and stop each worktree's server on its own
  port. 📌 pins a session so it never idles out.
- **Instant switching.** Running sessions keep their frames mounted, so switching
  keeps each session's route, scroll position and open dialogs. `[` and `]` cycle.
- **Real device sizes.** Phone, desktop, tablet (rotatable) or all of them at once,
  with quick-route buttons for the pages you check most.
- **Combine branches.** Tick unmerged branches and preview them merged together on
  top of `origin/main`, without touching main or any other worktree.
- **Changes panel.** What each worktree has that main doesn't, and what main has
  that it's missing.
- **Resource-aware.** At most N sessions run at once (LRU eviction, pins exempt),
  and idle ones stop after 15 minutes.
- **Self-healing setup.** Shares `node_modules` (or anything else) from the main
  checkout via symlinks, and offers a one-click reinstall when a worktree's lockfile
  drifts.
- **Zero dependencies.** A small Node CLI plus a plain HTML/JS UI.

## Quick start

```bash
git clone https://github.com/lichfiet/devframes.git
cd devframes && npm link        # puts `devframes` on your PATH

cd ~/code/your-app
devframes init                  # writes devframes.config.mjs
devframes                       # opens http://localhost:5180
```

Most Node apps work with no config at all: devframes reads `package.json` to pick the
dev command. `devframes init` writes it into the config and tells you what it found.
For anything else, set `command`.

**Works with:** Vite, Next.js, Astro, SvelteKit, Remix, Nuxt and Create React App,
plus any package with a `dev` (or `start`) script. npm, pnpm, yarn and bun are picked
from the lockfile. Non-Node servers (Django, Rails, a static server) work by setting
`command`, see below.

## Commands

| Command | What it does |
| --- | --- |
| `devframes` | Start the UI on `http://localhost:5180` |
| `devframes init` | Write a starter `devframes.config.mjs` in the current repo |
| `devframes status` | Show what's running |
| `devframes stop` | Stop the UI and every dev server it started |

The URL hash remembers the active session and view mode, so a refresh lands where
you were.

## Combine: preview unmerged branches together

The sidebar's **Combine** section lists local branches that aren't merged into
the base branch (the remote's HEAD, usually `origin/main`; see `baseRef`). Tick some and press **Build preview**:

1. devframes keeps a dedicated worktree at `<repo>/.devframes/combined` on a local
   `devframes/combined` branch (change both with `combine.worktreeDir` and
   `combine.branch`). `.devframes/` goes into `.git/info/exclude`, so it never shows
   up in `git status`.
2. It fetches `origin` and resets **that worktree only** to the base ref.
3. It merges each ticked branch. A branch that conflicts is aborted and listed as
   skipped, with its conflicting files.
4. The combined session starts like any other.

**Rebuild** repeats it with the saved selection. Nothing is ever pushed, and the
reset refuses to run anywhere except the combined worktree.

## Configuration

`devframes.config.mjs` in your repo root. Every key is optional and merges over the
defaults in [`src/config.mjs`](src/config.mjs), which is the full commented reference.

```js
export default {
  uiPort: 5180,                                   // the devframes UI
  command: "npx vite --port {port} --strictPort", // default: detected from package.json
                                                  // {port} {root} {mainRoot} {cacheDir} {name}
  mainCommand: null,                              // main checkout's command (defaults to command)
  mainPort: null,                                 // fixed port for main (null = allocate)
  ports: [5175, 5224],                            // session port range
  env: { VITE_SOME_FLAG: "true" },                // extra env for every dev server
  profiles: { fixtures: { env: { API: "off" } }, live: { env: { API: "local" } } },
  defaultProfile: "fixtures",                     // see "Env profiles"
  readyPath: "/",                                 // polled; any status below 500 counts as up
  readyCheck: "http",                             // "tcp" = just wait for the port to accept connections
  baseRef: "origin/main",                         // Changes + Combine base; default: the remote's HEAD
  combine: { worktreeDir: ".devframes/combined", branch: "devframes/combined" },
  viewports: [
    { name: "phone", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 900 },
    { name: "tablet", width: 820, height: 1180, rotatable: true },
  ],
  routes: ["/", "/settings"],                     // quick-route buttons
  startPath: "/",
  worktree: {
    // Symlinked from the main checkout when a worktree lacks its own. The badge's
    // one-click fix removes the link and runs install or setup.
    // Default: node_modules, only when a package.json exists.
    link: [{ path: "node_modules", badge: "deps differ", when: "lockfileDiffers", fix: "install" }],
    exclude: true,                                // keep links out of git status
  },
  setupCommand: null,                             // e.g. "npm run build:content"
  installCommand: null,                           // null = detect from the lockfile
  idleTimeoutMs: 15 * 60_000,
  maxRunning: 4,
};
```

Non-Node projects set `command` and nothing else:

```js
command: "python manage.py runserver {port}"      // Django
command: "bin/rails s -p {port}"                  // Rails
command: "python3 -m http.server {port}"          // static files
command: "npx serve -l {port}"                    // static files, Node
```

Linked paths go into the repo's shared `.git/info/exclude`, which is never
committed, so they never show up as untracked files in any worktree.

## Env profiles

Some things you mock in dev, some you need live. Define named env sets and
each session gets a switch in the sidebar:

```js
profiles: { fixtures: { env: { VITE_DEV_API: "fixtures" } }, live: { env: { VITE_DEV_API: "local" } } },
defaultProfile: "fixtures",
```

The chosen profile's `env` is merged over the base `env` (placeholders work).
Clicking a profile restarts that session's dev server with it; the choice is
saved per session in the devframes state and survives restarts.

## How it works

- **Discovery:** `git worktree list --porcelain`. The UI polls `/api/sessions`.
- **Sessions:** each dev server runs as its own process group on its own port, and
  counts as running once `readyPath` answers. The session manager handles idle
  timeouts, the LRU cap and pins.
- **State:** kept in `$TMPDIR/devframes-<hash>.json`, so `devframes stop` can always
  find and clean up everything it started.

It's also usable as a library:

```js
import { createDevframes, listWorktrees, SessionManager } from "devframes";
```

## Development

```bash
npm test        # node --test, no extra tooling
npm start       # run the CLI from source
```

## Roadmap

- Follow the active terminal tab, so the viewer switches to whichever session
  you're talking to.
- Publish to npm.

## License

[MIT](LICENSE) © Trevor Lichfield
