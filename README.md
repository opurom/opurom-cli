# opurom-cli

The OPUROM toolchain CLI. Zero npm dependencies — **Node builtins only** (`node:fs`,
`node:http`, `node:child_process`, `node:test`, `node:assert`). Run it directly:

```sh
node /Users/mac/work/opurom/opurom-cli/bin/opurom.mjs <command>
```

This repo assumes the standard sibling layout under `/Users/mac/work/opurom/`:
`opurom-spec` (golden `counter.opu` + `counter.opuir.json`, `IR_SCHEMA.md`),
`opurom-lang` (`opuromc`), `opurom-render`, `opurom-core`, `opurom-platform`.
Rust binaries are discovered in `../<repo>/target/debug|release/` or on `PATH`;
if a sibling repo is present but its binary is not built, the CLI runs
`cargo build --manifest-path ../<repo>/Cargo.toml` lazily. Nothing is installed into
your shell and no npm packages are fetched.

## Commands

| Command | What it does |
| --- | --- |
| `doctor` | Checks `rustc`, `cargo`, `node`, `opuromc`, `opurom-render` and the golden spec; prints remediation hints and exits 1 if a required tool is missing. `opurom-core` / `opurom-platform` are reported as optional. |
| `targets` | Prints the 8 emitter names read from `opurom-spec/IR_SCHEMA.md`: `native web wechat alipay qq douyin baidu kuaishou`. |
| `init <dir>` | Scaffolds `opurom.json` (name + targets), `src/main.opu` (from the counter template), `README.md`, `.gitignore`. Refuses to overwrite a non-empty directory. |
| `check <src.opu>` | Runs `opuromc check` and forwards diagnostics. |
| `build --src <src.opu> --target <name> --out <dir>` | `opuromc compile` to a temp IR, then `opuromc target <ir> --target <name> -o <out>`; `native` additionally runs `cargo build --release` inside `<out>`. Prints a concise summary; nonzero on failure. |
| `dev --src <src.opu> [--port 5178]` | Serves the generated `web` output over HTTP with SSE hot reload (details below). |
| `test` | End-to-end golden pipeline assertions (`node:assert`). Reports `PASS` / `FAIL` / `SKIP` per check and exits 1 on any failure. |

```sh
cd /Users/mac/work/opurom/opurom-cli
cli() { node bin/opurom.mjs "$@"; }
cli doctor
cli targets
cli init tmp/demo
cli check tmp/demo/src/main.opu
cli build --src ../opurom-spec/counter.opu --target web --out tmp/web
cli build --src ../opurom-spec/counter.opu --target wechat --out tmp/wechat
cli build --src ../opurom-spec/counter.opu --target native --out tmp/native
cli test
```

`package.json` scripts: `node --test` (`npm test`) runs the dependency-free unit suite;
`node bin/opurom.mjs doctor` (`npm run doctor`) runs the toolchain check.

## Unit tests

```sh
cd /Users/mac/work/opurom/opurom-cli && node --test
```

These cover `lib/args.mjs` (flag parsing, target validation, port), `lib/paths.mjs`
(executable and sibling-binary discovery), `lib/targets.mjs` (emitter list parsed from the
spec), `lib/build.mjs` (compile/lower/cargo orchestration plan), `lib/dev.mjs` (SSE client
injection, path-traversal guard, SSE framing) and the e2e output parsers. They pass with
**no sibling Rust repos present**.

## `test`: end-to-end checks

`node bin/opurom.mjs test` runs seven checks:

1. `doctor` passes.
2. Compile golden `counter.opu` and `assert.deepEqual` the parsed IR vs
   `opurom-spec/counter.opuir.json`.
3. Build `web`, `node --check` the generated `app.js`.
4. Build `wechat`, `node --check` the generated `index.js`.
5. Build `native` (including `cargo build --release`), run the binary with piped stdin,
   assert its output contains `state`.
6. Run `opurom-render` on the golden IR, assert a stable `digest=` line across two runs
   plus a numeric `dirty=` count.
7. Run `opurom-platform`, assert 14 rows.

If a sibling repo is genuinely absent (or has no `Cargo.toml` yet), that check prints
**SKIP** with the reason instead of a false pass. A build failure, a wrong IR, invalid
generated JS or a missing binary is a real **FAIL** with a diagnostic. Check 5 also
needs `cargo` on `PATH` (or `$HOME/.cargo/bin`).

## `dev`: HTTP + SSE hot reload

```sh
cd /Users/mac/work/opurom/opurom-cli
cp ../opurom-spec/counter.opu tmp/dev-demo.opu
node bin/opurom.mjs dev --src tmp/dev-demo.opu --port 5178 > /tmp/opurom-dev.log 2>&1 &
DEV_PID=$!
curl -s http://127.0.0.1:5178/health
curl -s http://127.0.0.1:5178/index.html | grep __opurom/events
curl -N http://127.0.0.1:5178/__opurom/events     # keep open, then touch the .opu file
touch tmp/dev-demo.opu                            # -> "event: reload" on the SSE stream
kill $DEV_PID
```

`/health` returns JSON (`ok`, `src`, `port`, `clients`, `rebuilds`, `lastBuild`, `lastError`).
The server watches the source directory with `fs.watch`, debounces changes, re-runs
compile + `web` lowering, and broadcasts `reload` (or `build-error`) to every SSE client.
The served `index.html` is injected with a tiny `EventSource` client that writes a
`opurom.state` snapshot into `sessionStorage` before `location.reload()`, and exposes the
snapshot as `window.__OPUROM_STATE_RESTORE__` on the next load. Because the v0.1 web emitter
keeps `const state` in its own script scope, `dev` also applies a **dev-only** rewrite to the
served `app.js` (never to the generated artifact on disk outside `tmp/`): merge the snapshot
into the state initializer and expose the live state as `window.opurom.state` for the next
reload — state-preserving reload that actually works with the round-1 emitter. Static files
are served from a temp dir under `tmp/` (gitignored), with a path-traversal guard.
`SIGINT`/`SIGTERM` close the watcher, clients and server, and remove the temp output.

## Status (verified, round 1)

- Implemented and unit-tested now: arg parsing, path/tool discovery, lazy cargo builds,
  `doctor`, `targets`, `init`, `check`, `build`, `dev` (HTTP + SSE + fs.watch +
  state-preserving reload), `test` orchestration, README, own git repo, clean tree.
- `node --test`: 21/21 pass (0.25 s), including a self-contained dev-server test that boots
  the HTTP server with a stub compiler and asserts `/health`, injected HTML and an SSE
  `reload` event. No sibling Rust repo is needed for that suite.
- `node bin/opurom.mjs doctor`: 6/6 required tools OK; `node bin/opurom.mjs test`: 7/7
  end-to-end checks PASS at commit time (golden IR, web, wechat, native + piped stdin,
  renderer digest/dirty, platform 14 rows). `dev` was additionally smoke-tested against the
  real `opuromc` web emitter: health JSON, injected SSE client, `app.js` state rewrite,
  `event: reload` after `touch`, and clean shutdown; no server was left running.
- If a sibling repo is genuinely absent (or has no `Cargo.toml` yet), `test` prints **SKIP**
  with the reason instead of a false pass.
- **Not in this round:** debugger, profiler, IDE LSP, incremental/delta builds, GPU backend,
  WASM emitter, real OS adapters, package publishing. These are R2+ items in
  `opurom-spec/ARCHITECTURE.md`. IDE grammar/snippets live in `opurom-ide-plugins`, not here.
- Known shortcut: the `app.js` state rewrite matches the v0.1 emitter's
  `const state = {...};` declaration. A future emitter that declares state differently needs
  its own hook; the SSE reload itself works regardless.

## Layout

```
bin/opurom.mjs        dispatcher (shebang, executable)
lib/args.mjs          parseArgs / requireFlags / parsePort
lib/paths.mjs         sibling paths, PATH lookup, lazy cargo builds
lib/targets.mjs       8 emitters + spec parsing + validateTarget
lib/proc.mjs          spawnSync wrappers
lib/doctor.mjs        toolchain report
lib/init.mjs          scaffold
lib/build.mjs         planBuild / check / build
lib/dev.mjs           static server, SSE, fs.watch, client injection
lib/e2e.mjs           seven end-to-end assertions
templates/main.opu    counter-based scaffold source
test/*.test.mjs       node:test unit suite
```
