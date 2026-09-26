# devframes

Live phone + desktop previews of **every git worktree's dev server**, in one
browser tab. Built for running several coding sessions (e.g. parallel Claude
Code sessions, each in its own worktree) and flipping between their
in-progress UIs instantly.

- A sidebar lists every worktree: branch, uncommitted-file count, last-commit age, status.
- ▶ / ■ start and stop a worktree's dev server; 📌 pins it against idle shutdown.
- Each **running** session keeps its frames mounted, so switching is instant and
  keeps each session's route, scroll position and open dialogs.
- View mode: phone, desktop or both. At most N sessions run at once (default 4);
  the least-recently-used unpinned one is stopped to make room. Idle sessions stop
  after 15 min.
- One-click fixes for common setup problems: shared generated files, or `npm ci`
  when a worktree's lockfile differs from the main checkout.

No runtime dependencies. The UI is plain HTML/JS served by the CLI.

## Install

```bash
git clone <this repo> ~/projects/devframes
cd ~/projects/devframes && npm link      # puts `devframes` on PATH
```

Or run it directly: `node ~/projects/devframes/bin/devframes.mjs`.

## Use

```bash
cd your-repo
devframes init          # writes devframes.config.mjs (edit it)
devframes               # starts the UI on http://localhost:5180
devframes status        # what's running
devframes stop          # stop the UI and every dev server it started
```

In the UI, `[` and `]` cycle sessions. The URL hash remembers the active session and view mode.

## Config (`devframes.config.mjs`)

```js
export default {
  uiPort: 5180,                                   // the devframes UI
  command: "npx vite --port {port} --strictPort", // placeholders: {port} {root} {mainRoot} {cacheDir} {name}
  mainCommand: null,                              // main checkout's command (defaults to command)
  mainPort: null,                                 // fixed port for main (null = allocate)
  ports: [5175, 5224],                            // session port range
  env: { VITE_SOME_FLAG: "true" },
  readyPath: "/",
  viewports: [
    { name: "phone", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 900 },
  ],
  routes: ["/", "/settings"],                     // quick-route buttons
  startPath: "/",
  worktree: {
    // symlinked from the main checkout when the worktree lacks its own;
    // the badge's one-click fix removes the link and runs install/setup
    link: [{ path: "node_modules", badge: "deps differ", when: "lockfileDiffers", fix: "install" }],
    exclude: true,                                // keep links out of git status
  },
  setupCommand: null,                             // e.g. "npm run build:content"
  installCommand: null,                           // null = detect from lockfile
  idleTimeoutMs: 15 * 60_000,
  maxRunning: 4,
};
```

`src/config.mjs` (`DEFAULTS`) is the full, commented reference. See
`open-lingo/lingo/devframes.config.mjs` for a real one.

Anything you leave out falls back to a default, so a plain Vite app needs little
more than `dev.command`.

Linked paths are added to the repo's shared `.git/info/exclude`. That file is
never committed, so the links never show up as untracked files in anyone's worktree.

## How it works

- `git worktree list --porcelain` is used for discovery; the UI polls `/api/sessions`.
- Each session is a child process group on its own port, with a readiness check
  on `readyPath`. The idle timer, the LRU cap and pins are handled by the session
  manager. State lives in `$TMPDIR/devframes-<hash>.json` so `devframes stop` can
  find everything.
- The library is usable from code: `import { createDevframes, listWorktrees, SessionManager } from "devframes"`.

## Tests

```bash
npm test
```

## Planned

- Follow the active terminal tab (e.g. Windows Terminal / WSL), so the viewer
  switches to whichever session you're talking to.
- Publish (npm / GitHub): location not decided yet.
