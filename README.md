# opurom-cli

The OPUROM toolchain CLI. Zero npm dependencies — **Node builtins only** (`node:fs`,
`node:http`, `node:net`, `node:crypto`, `node:os`, `node:perf_hooks`, `node:child_process`,
`node:sqlite`, `node:test`, `node:assert`). Run it directly:

```sh
node /Users/mac/work/opurom/opurom-cli/bin/opurom.mjs <command>
```

This repo assumes the standard sibling layout under `/Users/mac/work/opurom/`:
`opurom-spec` (golden `counter.opu` + `counter.opuir.json`, `IR_SCHEMA.md`), `opurom-lang`
(`opuromc`), `opurom-render`, `opurom-core`, `opurom-platform`, `opurom-server`
(`opurom-serverc`), `opurom-db` (`opurom-migrate`), `opurom-runtime-adapters`.
Rust binaries are discovered in `../<repo>/target/debug|release/` or on `PATH`;
if a sibling repo is present but its binary is not built, the CLI runs
`cargo build --manifest-path ../<repo>/Cargo.toml` lazily. Nothing is installed into
your shell and no npm packages are fetched.

## Commands

| Command | What it does |
| --- | --- |
| `doctor` | Checks `rustc`, `cargo`, `node`, `opuromc`, `opurom-render` and the golden spec; prints remediation hints and exits 1 if a required tool is missing. `opurom-core` / `opurom-platform` are reported as optional. |
| `targets` | Prints the emitter names read from `opurom-spec/IR_SCHEMA.md`: `native web wechat alipay qq douyin baidu kuaishou` (plus `wasm` once the R2 emitter is in the spec). |
| `init <dir>` | Scaffolds `opurom.json` (name + targets), `src/main.opu` (from the counter template), `README.md`, `.gitignore`. Refuses to overwrite a non-empty directory. |
| `check <src.opu>` | Runs `opuromc check` and forwards diagnostics. |
| `build --src <src.opu> --target <name> --out <dir>` | `opuromc compile` to a temp IR, then `opuromc target <ir> --target <name> -o <out>`; `native` additionally runs `cargo build --release` inside `<out>`. Prints a concise summary; nonzero on failure. |
| `build --src <src.opu> --target <name> --out <dir> --optimize` | Runs `opuromc optimize <ir> -o <optimized-ir>` before every emitter, prints measured input/output byte sizes and falls back to the original IR with an explicit message if the compiler cannot optimize. Default builds are unchanged. |
| `build --src <src.opu> --target <name> --out <dir> --minify` | Minifies the emitted `.js` files with the built-in safe minifier (comments and non-semantic whitespace only), removes unused generated assets, prints the measured before/after byte table and writes the measured baseline to `<out>/.opurom-size.json`. Works with every target including `full` and `wasm`, and composes with `--optimize`. |
| `size <dir>` | Prints the measured before/after byte table and reduction percentage for a directory built with `--minify`. Every number comes from `fs.statSync` on the real files. |
| `build --src <src.opu> --target full --out <dir>` | The whole full-stack chain in one command: compile → frontend (`web` + `native`) → generated server crate → SQL migrations → `shared/types.json`. Prints an artifact summary. |
| `build --src <src.opu> --target wasm --out <dir>` | `opuromc target --target wasm` then `cargo build --release --target wasm32-unknown-unknown`. |
| `serve --out <dir> [--port N]` | Runs the generated service (`OPR_PORT`, `OPR_DB`), waits for `GET /health`, streams the output, shuts down cleanly on `SIGINT`/`SIGTERM`. |
| `migrate --src <src.opu> --out <dir>` | Compiles the source and writes `migrations/001_create_<model>.sql` + `schema.sql` from the IR models. |
| `dev --src <src.opu> [--port N]` | Serves the generated `web` output over HTTP with SSE hot reload **and** rebuilds/restarts the backend service when the source changes (details below). |
| `dev --src <src.opu> [--port N] --sync` | Adds a dev preview sync hub for N browser clients: one shared state snapshot on connect and the same reload frame for every SSE client. Not a device-conformance or multi-OS claim. |
| `dev --sync [--clients N] [--port N]` | One-shot R8 verification: N real RFC 6455 WebSocket clients (default 2, cap 8) connect over loopback TCP to an already running sync hub, dispatch one state event and report MEASURED per-client delivery times plus same-delta equality. A missed delta is FAIL; no hub is a documented SKIP with `n/a (reason)`. |
| `bench --src <src.opu> [--out <dir>]` | Measured compile / lowering / build times and on-disk artifact sizes, printed as a markdown table. No fps, startup or throughput claims. |
| `bench --src <src.opu> [--out <dir>] --full` | Adds measured render, native/wasm build, one service `GET /health` request and exact artifact byte sizes. Unavailable measurements are printed as `n/a (reason)`. |
| `bench --src <src.opu> --compare` | Renders the SAME scene through the software renderer **and** the GPU backend (`opurom-gpu`), reports both MEASURED times and the byte-equality result of the two outputs. A speed ratio is only printed when the outputs are byte-equal. |
| `profile --src <src.opu> [--frames N]` | Compiles once, then runs N real `opurom-render` frames and reports MEASURED p50/p95/min/max ms plus achieved fps derived from those frame times. N defaults to 30 and is capped at 600. Software-raster timings on this host only. |
| `profile --src <src.opu> --repeat N` | Runs the SAME work N times, discards a documented warmup count (reported as `warmup excluded: 2`) and reports the MEASURED median, p95, min, max and achieved fps of the measured runs only, plus the environment description. N defaults to 10 and accepts 1..600. |
| `inspect <ir.json>` | Read-only layer tree (id, kind, bounds, frame-wide dirty-rect status) beside the deterministic a11y tree from `opurom-render --a11y`. Never mutates the IR file. |
| `test` | End-to-end pipeline assertions (`node:assert`). Reports `PASS` / `FAIL` / `SKIP` per check and exits 1 on any failure. |

```sh
cd /Users/mac/work/opurom/opurom-cli
cli() { node bin/opurom.mjs "$@"; }
cli doctor
cli targets
cli init tmp/demo
cli check tmp/demo/src/main.opu
cli build --src ../opurom-spec/counter.opu --target web --out tmp/web
cli build --src ../opurom-spec/counter.opu --target web --out tmp/web-opt --optimize
cli build --src ../opurom-spec/counter.opu --target web --out tmp/web-min --minify
cli size tmp/web-min
cli build --src ../opurom-spec/counter.opu --target wechat --out tmp/wechat
cli build --src ../opurom-spec/counter.opu --target native --out tmp/native
cli bench --src ../opurom-spec/counter.opu --out tmp/bench --full
cli bench --src ../opurom-spec/counter.opu --compare
cli profile --src ../opurom-spec/counter.opu --frames 30
cli profile --src ../opurom-spec/counter.opu --repeat 10
cli inspect ../opurom-spec/counter.opuir.json
# Long-running: cli dev --src tmp/demo/src/main.opu --sync --port 5178
# Start a hub first, then: cli dev --sync --clients 8 --port 5178
cli test
```

`package.json` scripts: `node --test` (`npm test`) runs the dependency-free unit suite;
`node bin/opurom.mjs doctor` (`npm run doctor`) runs the toolchain check.

## Quickstart: one `.opu` file → a running full-stack service

The same source file carries the UI, the data model and the HTTP API.

```opu
app TodoApp {
  model Todo {
    id: int primary
    title: string
    done: bool = false
  }

  api "/todos" {
    list Todo
    create Todo
  }

  api "/todos/:id" {
    get Todo
    update Todo
    delete Todo
  }

  state remaining = 0
  Column(p: 16) {
    Text("Remaining: {remaining}")
    Button("Refresh") { remaining += 1 }
  }
}
```

### 1. Build the whole stack

```sh
cd /Users/mac/work/opurom/opurom-cli
node bin/opurom.mjs build --target full --src ../opurom-examples/todo.opu --out tmp/full
```

```
build ok: /Users/mac/work/opurom/opurom-examples/todo.opu [full] -> /.../tmp/full
  app=TodoApp models=1 api=2
  web: 3 files, 24.4 KiB
  native: 2 files, 1.1 KiB
  server: 2 files, 6.2 KiB
  migrations: 2 files, 0.4 KiB
  shared/types.json: 1 file, 0.3 KiB
  app.opuir.json: 1 file, 1.5 KiB
```

What lands in `--out`:

| Path | Content |
| --- | --- |
| `web/` | `index.html`, `app.js`, `ir.json` — the browser frontend (Canvas 2D, no runtime dependency). |
| `native/` | `Cargo.toml`, `src/main.rs` — the native (std-only Rust) build of the same UI. |
| `server/` | `Cargo.toml`, `src/main.rs` — the generated service crate: router, handlers, JSON, SSR route. |
| `migrations/` | `001_create_todo.sql` (+ `schema.sql`) — SQL derived from the IR `models`. |
| `shared/types.json` | The shared type source: the IR `models` and `api` arrays, read by both sides. |
| `app.opuir.json` | The compiled IR — the single contract between the compiler and the backend. |

The chain is: `opuromc compile` → `opuromc target --target web|native` → `opurom-serverc`
→ `opurom-migrate`. Missing sibling binaries are built lazily with
`cargo build --manifest-path <repo>/Cargo.toml`; a sibling repo that is genuinely absent is a
hard error, never a silent success.

### 2. Serve it

```sh
node bin/opurom.mjs serve --out tmp/full --port 8787
```

```
service ready: http://127.0.0.1:8787
  health: curl -s http://127.0.0.1:8787/health
  db:     /.../tmp/full/data/opurom.db
```

The service reads `OPR_PORT` (default `8787`) and `OPR_DB` (default `./opurom.db`); the CLI
sets both to values inside `--out`. `SIGINT`/`SIGTERM` stop it cleanly.

### 3. Drive the API

```sh
BASE=http://127.0.0.1:8787

curl -s $BASE/health
# {"ok":true,"app":"TodoApp","version":"0.2.0"}

curl -s -X POST $BASE/todos -H 'content-type: application/json' \
     -d '{"title":"write tests"}'
# {"id":1,"title":"write tests","done":false}

curl -s $BASE/todos
# [{"id":1,"title":"write tests","done":false}]

curl -s $BASE/todos/1
# {"id":1,"title":"write tests","done":false}

curl -s -X PUT $BASE/todos/1 -H 'content-type: application/json' \
     -d '{"title":"done","done":true}'
# {"id":1,"title":"done","done":true}

curl -s -X DELETE $BASE/todos/1
# {"deleted":true}

curl -s -o /dev/null -w '%{http_code}\n' $BASE/todos/1
# 404

curl -s $BASE/ssr | head -c 120
# <!DOCTYPE html> ... <title>TodoApp</title> ...
```

### 4. Verify the SQLite rows

The service stores rows in the SQLite file the CLI pointed `OPR_DB` at. Run this **before**
the `DELETE` above, or create a second row first — `DELETE` removes the row again.

```sh
sqlite3 tmp/full/data/opurom.db 'select id, title, done from Todo;'
# 1|write tests|0
```

or without the `sqlite3` binary, using the Node builtin driver:

```sh
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('tmp/full/data/opurom.db',{readOnly:true});console.log(db.prepare('select * from Todo').all())"
```

### 5. Run the checks

```sh
node bin/opurom.mjs test
```

## `build --optimize`: opt-in measured IR pass

```sh
node bin/opurom.mjs build --src ../opurom-spec/counter.opu --target web --out tmp/web-opt --optimize
```

`--optimize` works for emitter targets, `full` and `wasm`. Before any emitter runs, the CLI
executes `opuromc optimize <ir> -o <optimized-ir>` and uses the optimized IR for the rest of
the chain. It prints the input and output byte sizes measured from the two real files:

```
optimizer: input=1411 B, output=1411 B (measured from files)
build ok: /.../counter.opu [web] -> /.../tmp/web-opt [optimize=applied] (3 entries: app.js, index.html, ir.json)
```

These two numbers are from one real run of `counter.opu` on this machine; both files were
1411 bytes because the compiler pretty-prints IR. A dead-state IR can shrink. If the compiler
does not support `optimize`, or exits nonzero without a non-empty output file, the CLI prints
`NOT optimized` with the exit status and diagnostic, copies the original IR to the output
path, prints the measured sizes of those real files and continues with the original IR. It
never reports a silent optimized build. A build without `--optimize` uses exactly the R2
compile/lower path; a clean `HEAD` CLI and the default R3 CLI produced byte-identical
`app.js`, `index.html` and `ir.json` artifacts.

## `build --minify` and `size`: measured, safe minification

```sh
node bin/opurom.mjs build --src ../opurom-spec/counter.opu --target web --out tmp/web-min --minify
node bin/opurom.mjs size tmp/web-min
```

`--minify` runs after the emitter (and after `--optimize`, if both are given) and does three
things, in this order:

1. **Removes unused generated assets.** The CLI asks the compiler for its own file list
   (`opuromc targets`) and deletes only files that belong to *another* emitter's file list and
   were not written by this build — for example a stale `app.json` / `index.js` left in the
   output directory by an earlier `wechat` build. Every removed file is printed with its
   measured size. Files that are not emitter assets (your own files, the `server/`, `shared/`
   and `migrations/` chain outputs) are never touched.
2. **Minifies the emitted `.js` files** with `lib/r6.mjs`, a small state-machine tokenizer.
   It removes comments and collapses whitespace runs. **It never mangles identifiers, never
   rewrites strings, template literals or regular expressions, and never renames anything.**
   Every literal token is copied verbatim from the source, so a URL inside a string, a
   template with `${...}` interpolation, or a regex containing `/` or quotes is preserved
   byte for byte. Line breaks are preserved wherever the source had them, so automatic
   semicolon insertion cannot change. Each minified file is checked with `node --check`
   before the build continues; a file that fails the check aborts the build.
3. **Records the measured baseline** in `<out>/.opurom-size.json` (the file sizes measured
   before minification) and prints the measured before/after table.

`opurom size <dir>` re-reads that baseline, re-measures the directory with `fs.statSync` and
prints the same table. Numbers are never invented: every cell is a real file size.

```
OPUROM size (measured with fs.statSync; excludes target/, data/, dotfiles)
dir: /tmp/opurom-r6-web.61do4P
target: web
| file | before | after | reduction |
| --- | --- | --- | --- |
| app.js | 1438 B | 1292 B | 10.2% |
| index.html | 383 B | 383 B | 0.0% |
| ir.json | 1411 B | 1411 B | 0.0% |
| total | 3232 B | 3086 B | 4.5% |
measured reduction: 4.5% (before 3232 B -> after 3086 B)
removed unused generated assets: (none)
minified js files: app.js
files created after baseline: (none)
Scope: comment/whitespace minification only — no bundler, no source maps, no Brotli/zstd, no dependency graph analysis.
```

Those numbers are from one real run of `counter.opu` on this machine; rerun the command for
values on your machine. A build **without** `--minify` is byte-identical to a build with it:
the flag is the only thing that changes the output.

### Honest scope of `--minify`

- **No bundler.** Files are minified in place; nothing is concatenated, tree-shaken or
  deduplicated.
- **No source maps.** Minified output has no `.map` file and no mapping back to the original.
- **No Brotli, gzip or zstd.** The size report is raw file bytes on disk.
- **No dependency graph analysis.** Only the emitter's own output is inspected; the CLI does
  not know which of your files are actually imported and does not try to find out.
- **No identifier mangling, no dead-code elimination, no expression rewriting.** The minifier
  removes comments and non-semantic whitespace only.
- **Removed-asset detection is emitter-scoped**, not import-graph based: a file is removed when
  the compiler's own artifact list says it belongs to a different target than the one built.
- **Bundling, source maps, Brotli/zstd and real dependency graph analysis are R7+ work.**

## Unit tests

```sh
cd /Users/mac/work/opurom/opurom-cli && node --test
```

These cover `lib/args.mjs` (flag parsing, target validation, port, R3 boolean flags),
`lib/paths.mjs` (executable and sibling-binary discovery), `lib/targets.mjs` (emitter list
parsed from the spec, build-target validation), `lib/build.mjs` (compile/lower/cargo
orchestration plan, optimizer step, measured byte formatting, explicit fallback),
`lib/fullstack.mjs` (full-build plan, shared types, artifact summary, temp-path guard),
`lib/service.mjs` (env/port/db handling, service binary discovery), `lib/bench.mjs`
(markdown table, byte formatting, exact measured rows and `n/a (reason)`), `lib/dev.mjs`
(SSE client injection, path-traversal guard, SSE framing, sync hub bookkeeping), `lib/r4.mjs`
(percentile math, frame caps, measured/`n/a` profile reports, deterministic layer formatting,
read-only `inspect`), `lib/r6.mjs` (minifier literal edge cases, `node --check` on every
emitter's real output, golden web app behaviour in a DOM harness, measured size report math,
unused asset removal, byte-identical default build), `lib/r7.mjs` (repeat-count validation,
warmup-exclusion arithmetic, percentile math on known arrays, the environment description, the
`profile --repeat` report, the compare byte-equality reporting and the unavailable-GPU path),
`lib/r8.mjs` (RFC 6455 handshake and masked-frame vectors, cap validation, measured reports,
real N-client same-delta verification, dropped-client FAIL, no-hub SKIP and socket cleanup) and
the e2e output parsers.
`test/r3.test.mjs` also drives stub compilers,
two SSE clients and a real local `dev --sync` server; `test/r4.test.mjs` drives a stub renderer
and compares IR bytes before/after `inspect`; `test/r7.test.mjs` drives stub compiler, renderer
and GPU-backend binaries; `test/r8.test.mjs` starts a real loopback TCP WebSocket hub without
the sibling Rust server. The 80 unit tests pass with **no sibling Rust repos present**.

## `test`: end-to-end checks

`node bin/opurom.mjs test` runs the checks below and prints `PASS` / `FAIL` / `SKIP` per
check:

1. `doctor` passes.
2. Compile golden `counter.opu` and `assert.deepEqual` the parsed IR vs
   `opurom-spec/counter.opuir.json`.
3. Build `web`, `node --check` the generated `app.js`.
4. Build `wechat`, `node --check` the generated `index.js`.
5. Build `web` with `--minify`, `node --check` the minified `app.js` and assert the measured
   before/after sizes and the reduction percentage.
6. Build `native` (including `cargo build --release`), run the binary with piped stdin,
   assert its output contains `state`.
7. Run `opurom-render` on the golden IR, assert a stable `digest=` line across two runs
   plus a numeric `dirty=` count.
8. Run `opurom-platform`, assert 14 rows.
9. **Full stack**: build a Todo `.opu` (the `opurom-examples/todo.opu` fixture when present,
   otherwise an inline fixture), start the generated service on a free port and assert
   `GET /health`, `POST /todos` → a created row, `GET /todos` containing that row,
   `GET /todos/:id`, `PUT` update, `DELETE`, a 404 for an unknown row, `GET /ssr` containing
   the app name, and the SQLite row. The server is stopped afterwards.
10. **wasm**: build the `wasm32-unknown-unknown` crate, instantiate the `.wasm` with an empty
    import object and assert `opu_version() == 1` (plus the tap/state round trip when the IR
    has an incrementing button).

If a sibling repo is genuinely absent (or has no `Cargo.toml` yet), that check prints
**SKIP** with the reason instead of a false pass. A build failure, a wrong IR, invalid
generated JS, a failing API call or a missing binary is a real **FAIL** with a diagnostic.
Check 6 needs `cargo` on `PATH` (or `$HOME/.cargo/bin`).

## `dev`: HTTP + SSE hot reload, backend rebuild

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

`/health` returns JSON (`ok`, `src`, `port`, `clients`, `rebuilds`, `lastBuild`, `lastError`,
plus a `backend` object with `status`, `port`, `restarts` and `lastError`).
The server watches the source directory with `fs.watch`, debounces changes, re-runs
compile + `web` lowering, and broadcasts `reload` (or `build-error`) to every SSE client.
When the backend toolchain is present, the same change also regenerates the service crate,
rebuilds it and restarts the child process; the new port is reported in `/health`.

The served `index.html` is injected with a tiny `EventSource` client that writes a
`opurom.state` snapshot into `sessionStorage` before `location.reload()`, and exposes the
snapshot as `window.__OPUROM_STATE_RESTORE__` on the next load. Because the v0.1 web emitter
keeps `const state` in its own script scope, `dev` also applies a **dev-only** rewrite to the
served `app.js` (never to the generated artifact on disk outside `tmp/`): merge the snapshot
into the state initializer and expose the live state as `window.opurom.state` for the next
reload — state-preserving reload that actually works with the round-1 emitter. Static files
are served from a temp dir under `tmp/` (gitignored), with a path-traversal guard.
`SIGINT`/`SIGTERM` close the watcher, clients, backend child and server, and remove the temp
output.

## `dev --sync`: dev preview hub

```sh
node bin/opurom.mjs dev --src tmp/dev-demo.opu --sync --port 5178
# The startup log prints LAN URLs for other browser clients on the same network.
curl -N http://127.0.0.1:5178/__opurom/events   # receive event: snapshot on connect
touch tmp/dev-demo.opu                          # every SSE client receives the same reload frame
```

`--sync` keeps all existing `dev` behavior (frontend SSE, backend rebuild/restart and
state-preserving reload) and adds a shared hub. It binds the preview server to `0.0.0.0`,
prints reachable LAN URLs, and supports **N browser clients connected to one CLI process**.
Every connected client receives the same `event: reload` frame when the source changes. A new
client receives `event: snapshot` with the hub's shared state: dev-server status, rebuild
count, last build, backend status, reload count, client count and LAN URLs. The injected
browser script exposes that payload as `window.opurom.syncSnapshot` and
`window.__OPUROM_SYNC_SNAPSHOT__`. The snapshot is dev-server state, not synchronized
application UI state.

This is a **dev preview hub for N browser clients**, NOT a device-conformance test, NOT
multi-OS synchronization and NOT a cloud deployment. There is no TLS, authentication or
device matrix; use it only on a trusted local network. `/health` reports a `sync` object
with `mode`, `host`, `urls`, `clients`, `reloads` and `lastReload`, alongside the existing
`clients` count.

## `dev --sync --clients N`: measured WebSocket verification

The R8 verifier is a one-shot command. It does **not** start a hub. Start the small in-repo
loopback helper first, in another terminal:

```sh
node bin/sync-hub.mjs --port 5178
# loopback sync hub: ws://127.0.0.1:5178/__opurom/sync
```

Then verify N clients against that hub:

```sh
node bin/opurom.mjs dev --sync --clients 8 --port 5178
# or: node bin/opurom.mjs dev --sync           # N defaults to 2
```

`--clients N` accepts 1..8; 0, negative, fractional, non-numeric and >8 values fail with
`invalid --clients: <value> (expected 1..8)` before any socket is opened. `--port N` (or
`OPR_SYNC_PORT`) selects the loopback hub port; the default is 5178. `dev --sync --src ...`
without `--clients` remains the existing long-running SSE preview hub.

Each of the N clients opens a REAL `node:net` TCP connection to `127.0.0.1`, performs the
RFC 6455 handshake (random `Sec-WebSocket-Key`, verified `Sec-WebSocket-Accept`), sends one
masked text frame carrying the same canonical state event, answers hub ping frames with a
masked pong, reads the hub's unmasked text-frame reply and closes the WebSocket cleanly. The
hub broadcasts one canonical state delta after it has received all N state events. Delivery
time is the measured `process.hrtime.bigint()` interval from each client's event write to its
reply frame, printed as exact milliseconds per client. A timeout, close, missing reply or a
different delta is a **FAIL** with a nonzero exit; no delivery time is invented for a client
that missed the delta. If the TCP connection is refused, the command prints
`sync: n/a (no sync hub at 127.0.0.1:<port>: <reason>)`, `status: SKIP` and exits 0.

`bin/sync-hub.mjs` is a testable helper, not a production server. It uses the same bounded
frame conventions as `opurom-server/src/websocket.rs`: RFC 6455 accept-key derivation,
masked client frames, unmasked server frames, text/binary/continuation opcodes, control-frame
checks, ping/pong, close and 1 MiB frame / 8 MiB message caps. It adds only the R8 broadcast
rule. There are no extensions, no subprotocol negotiation, no TLS and no authentication.

Honest scope: **loopback clients on one host, NOT real devices**. There is no visual diff,
no network capture UI, no multi-OS or cross-host synchronization, no device conformance and
no competitive timing claim. Real-device conformance, visual diffing and a network capture
UI remain **R9+**.

## `bench`: measured numbers only

```sh
node bin/opurom.mjs bench --src ../opurom-spec/counter.opu --out tmp/bench
node bin/opurom.mjs bench --src ../opurom-spec/counter.opu --out tmp/bench --full
```

The default `bench` keeps its original two-table shape and rounded `ms`/KiB cells. `--full`
adds `render`, `wasm build` and one service `GET /health` request, all timed with
`performance.now()`, and prints exact elapsed numbers and byte counts. Service startup and
readiness probes are not timed; the measured service row is one real HTTP request after the
service is healthy. Any measurement that could not run is `n/a (reason)`; no number is
invented. One real run of `counter.opu` on this machine produced:

```
OPUROM bench --full (measured on this machine, this run)

| step | elapsed |
| --- | --- |
| compile (opuromc compile) | 2.704917000000002 ms |
| lower to web (opuromc target --target web) | 2.242666 ms |
| render (opurom-render 800x600) | 65.579125 ms |
| native build (cargo build --release) | 794.131625 ms |
| wasm build (cargo build --release --target wasm32) | 209.34183299999995 ms |
| service request (GET /health) | 1.9715839999998934 ms |

| artifact | files | bytes |
| --- | --- | --- |
| web | 3 | 3226 B |
| native | 3 | 2367 B |
| wasm | 6 | 7980 B |
| wasm module | 1 | 21842 B |
| frame.ppm | 1 | 1440015 B |
| server | 5 | 10821 B |
| migrations | 0 | 0 B |
| shared/types.json | 1 | 67 B |
| app.opuir.json | 1 | 1411 B |
| service /health body | 1 | 45 B |
```

Those values are from that run only; rerun the command for values on your machine. `bench`
deliberately makes **no** fps, startup, throughput or competitor claims. See `profile` below for
measured sequential software-raster frame times and a derived fps for this host only, and
`bench --compare` for the software-versus-GPU-backend comparison of two OPUROM backends.

## `bench --compare`: software renderer vs GPU backend

```sh
node bin/opurom.mjs bench --src ../opurom-spec/counter.opu --compare
```

`--compare` renders the **same scene** through two sibling backends and reports both MEASURED
times plus the byte-equality result of the two outputs:

1. `opurom-render` (software raster) writes `software.ppm` and, in the same run, the exact
   display list (`--commands`) the GPU backend consumes.
2. `opurom-gpu raster` (the Metal compute backend) executes that display list and writes
   `gpu.ppm`.
3. The two PPM files are compared **byte for byte**; the report prints the sha256 of the
   shared bytes and the byte count.

Every speed statement is paired with the correctness result:

- When the two outputs are byte-equal, the report prints the measured ratio
  (`speed: gpu is <x>x the software renderer time (measured; byte-equal outputs)`).
- When the outputs differ, **no** ratio is printed: the report says
  `speed: n/a (outputs are not byte-equal; no speed claim over a different image)`.
- When the GPU backend (or its sibling repo) is unavailable, the software measurement is still
  printed, the GPU side prints `n/a (reason)`, the byte-equality result prints `n/a (reason)`
  and the speed line prints `n/a (one backend could not be measured)`.

One real run of `counter.opu` at 800x600 on this machine produced:

```
OPUROM bench --compare (MEASURED software vs GPU backend, this host)
src: /Users/mac/work/opurom/opurom-spec/counter.opu
software renderer (opurom-render): 101.561791 ms
gpu backend (opurom-gpu): 298.659667 ms
byte equality of the two outputs: byte-equal (5b842542b08d88e05eaaacf9b57b6b0d901b4044aa6201b7745d45c732b6ccc5 sha256, 1440015 B each)
speed: gpu is 0.34x the software renderer time (measured; byte-equal outputs)
environment: cpu=Apple M6 (12 logical cpus)
environment: os release=27.3.0
environment: node=v26.13.0
environment: raster=software raster (opurom-render) and GPU compute backend (opurom-gpu) on this host
Note: both timings are on this host, NOT a device/competitor benchmark.
No competitor binary was executed and no competitor number was estimated.
```

Those values are from that run only; rerun the command for values on your machine. Both
timings include process launch and file output, so they are **not** a pure GPU-vs-CPU kernel
comparison. The comparison is **OPUROM backend against OPUROM backend only**: no competitor
binary is executed and no competitor number is estimated. There is no device matrix.

## `profile`: measured software-raster frames

```sh
node bin/opurom.mjs profile --src ../opurom-spec/counter.opu --frames 30
```

The command compiles the `.opu` source once, then launches `opurom-render` once per requested
frame at 800x600 and times each real process with `performance.now()`. It reports MEASURED
p50/p95/min/max milliseconds and achieved fps computed as
`frames / sum(measured frame times)`. Every frame is checked for renderer `digest=` / `dirty=`
output and a non-empty PPM. `--frames` defaults to 30 and accepts 1..600; values outside that
range fail with a clear error. If a tool or any frame is unavailable, every statistic prints
`n/a (reason)` and the command exits nonzero. No number is invented.

These are software-raster timings on this host, **NOT a device/competitor benchmark**. Each
measurement includes process launch and PPM output. There is no device matrix, no
debugger/profiler GUI and no competitive claim.

## `profile --repeat`: measured repeated work with the warmup excluded

```sh
node bin/opurom.mjs profile --src ../opurom-spec/counter.opu --repeat 10
```

`--repeat N` runs the **same work N times** (one real `opurom-render` process per run at
800x600, identical to `--frames`), discards a documented warmup count and reports the
statistics of the **measured runs only**:

- The warmup count is 2 and is reported explicitly as `warmup excluded: 2`. The first two runs
  pay for process start-up, page-cache and first-touch costs, so they are discarded.
- The warmup shrinks when `N` is small, so that **at least one measured run always survives**:
  `N = 1` discards 0 warmup runs, `N = 2` discards 1, `N = 3` discards 2.
- The reported `median`, `p95`, `min`, `max` and `achieved fps` are computed over the measured
  runs only, never over the discarded ones. The fps is `measured runs / sum(measured times)`.
- `--repeat` defaults to 10 and accepts 1..600. Anything else (`0`, `-1`, `601`, `3.5`,
  `nope`) fails with `invalid --repeat: <value> (expected 1..600)` before any tool is run.

Every report states the environment it was measured in: the CPU model from `os.cpus()[0].model`
with the logical CPU count, the OS release from `os.release()`, the Node version, and whether
the measurement is a **software raster on this host**. Any statistic that could not be measured
prints `n/a (reason)` — never a fabricated number.

One real run of `counter.opu` on this machine produced:

```
OPUROM profile --repeat (MEASURED repeated identical work on this host)
src: /Users/mac/work/opurom/opurom-spec/counter.opu
repeat: 10 requested / warmup excluded: 2 / 8 measured runs
median: 57.757874500000014 ms
p95: 59.80372555000001 ms
min: 56.04404200000002 ms
max: 59.90545900000001 ms
achieved fps: 17.316910598730278 (8 measured runs / 461.97616800000003 ms of measured time)
environment: cpu=Apple M6 (12 logical cpus)
environment: os release=27.3.0
environment: node=v26.13.0
environment: raster=software raster on this host (opurom-render CPU path)
Note: software-raster timings on this host, NOT a device/competitor benchmark.
No competitor binary was executed and no competitor number was estimated.
```

Those values are from that run only; rerun the command for values on your machine. These are
software-raster timings on this host, **NOT a device/competitor benchmark**. The command does
not report whether the machine was idle — that is not measurable from inside the CLI — so it
states the host, the CPU, the OS and the raster kind instead of claiming an idle machine.

## `inspect`: read-only layer and a11y trees

```sh
node bin/opurom.mjs inspect ../opurom-spec/counter.opuir.json
```

`inspect` reads the IR as bytes, parses it without writing to it, and invokes
`opurom-render --a11y` with PPM/a11y outputs in a temporary directory. It prints a deterministic
pre-order layer tree (id, kind, renderer bounds and frame-wide dirty-rect status) beside the
data-only a11y tree (id, role, label, bounds and hidden). The IR bytes are compared before and
after; a change is reported as a read-only violation. The dirty status is the renderer's
frame-wide rect count, not an invented per-layer rect list. If the renderer is unavailable or
`--a11y` fails, the command prints a clear diagnostic and exits nonzero. This is not OS
screen-reader integration.

## Status (round 8)

- **Implemented and unit-tested now**: arg parsing, path/tool discovery, lazy cargo builds
  (offline-forced for R4 tools), offline-first generated-service builds, `doctor`, `targets`,
  `init`, `check`, `build` (emitter, `full`, `wasm`, opt-in `--optimize`, opt-in `--minify`),
  `serve`, `migrate`, `dev` (HTTP + SSE + fs.watch + state-preserving reload + backend
  rebuild/restart + `--sync` preview hub), `dev --sync --clients N` (real N-client RFC 6455
  loopback verification with measured delivery times), `bench` (default shape and measured
  `--full` table), `bench --compare` (software vs GPU backend, both MEASURED, paired with the
  byte-equality result), `profile` (measured sequential software-raster frames with honest `n/a`),
  `profile --repeat` (measured repeated work, warmup excluded and reported, environment stated),
  `inspect` (read-only layer/a11y trees), `size` (measured before/after byte table), `test`
  orchestration (incl. full-stack, wasm and minified-build checks), README, own git repo,
  clean tree.
- `node --test`: the dependency-free unit suite (80 tests: the original 70 plus 10 R8 tests)
  passes with **no sibling Rust repo present**. It covers the new flags, exact measured
  formatting, optimizer success/fallback, sync hub bookkeeping, a real two-client
  `dev --sync` SSE server, percentile math, frame caps, layer formatting, an `inspect` byte
  comparison, the R6 minifier, the R7 measurement layer, and the R8 RFC 6455 vectors, cap
  validation, N=2/N=8 same-delta runs, different/dropped-delta failures, no-hub SKIP and
  real loopback socket cleanup.
- `node bin/opurom.mjs test`: 10 checks PASS at commit time — the 7 round-1 checks, the
  full-stack check (real service on a free port: health, POST 201, GET list, GET one, PUT,
  DELETE, 404, SSR, persisted SQLite row), the wasm check (build +
  `WebAssembly.instantiate` + `opu_version() == 1`) and the minified-build check
  (`node --check` on the minified `app.js` plus the measured before/after sizes).
- Verified by hand against the real toolchain: default `build` output was byte-identical to a
  clean `HEAD` CLI (identical `app.js`, `index.html` and `ir.json` checksums); `build
  --optimize` printed measured `1411 B -> 1411 B` on `counter.opu`; `build --minify` measured
  `app.js 1438 B -> 1292 B` (`3232 B -> 3086 B` total, 4.5%) on `counter.opu` and removed the
  stale `wechat` assets (`app.json`, `index.js`, `index.wxml`, `index.wxss`) left in the output
  directory by an earlier build; `bench --full` measured six steps and one `GET /health`, with
  the real numbers shown above; two `dev --sync` SSE clients received snapshots and the same
  reload frame after a source change; real N=2 and N=8 RFC 6455 loopback clients each received
  the same state delta with MEASURED per-client `hrtime` delivery times and clean socket
  shutdown; `profile` ran real renderer frames and printed MEASURED
  percentiles plus derived fps; `inspect` printed the side-by-side trees from
  `opurom-render --a11y` without changing IR bytes; `profile --repeat 10` ran ten real renderer
  runs, excluded two warmup runs and printed the measured statistics of the eight remaining
  runs; `bench --compare` rendered the same scene through `opurom-render` and `opurom-gpu` and
  reported **byte-equal** outputs with both measured times. No number is invented.
- If a sibling repo is genuinely absent (or has no `Cargo.toml` yet), `test` prints **SKIP**
  with the reason instead of a false pass. Unavailable `bench --full` rows, `profile`,
  `profile --repeat` and `bench --compare` measurements print `n/a (reason)`.
- **Honest scope of the R7/R8 work**: `profile --repeat` measures this host's software
  raster only and states the CPU, the OS release, the Node version and the raster kind; it
  cannot observe machine idleness from inside the CLI and does not claim it. `bench --compare`
  compares two **OPUROM** backends against each other only: **no competitor binary is executed
  and no competitor number is estimated**. There is **no device matrix**, no competitive fps
  benchmark, no cross-OS sweep and no debugger/profiler GUI. For `--minify`: **no bundler, no
  source maps, no Brotli/zstd, no dependency graph analysis** beyond the emitter's own output,
  and **no identifier mangling or dead-code elimination**. There is **no debugger/profiler GUI**
  in this CLI; the separate DAP subset server has no GUI client. There is **no multi-OS sync**:
  `dev --sync --src ...` is a dev preview hub for N browser clients, and
  `dev --sync --clients N` verifies N loopback WebSocket clients on one host. Neither is
  real-device conformance testing. R8 has **no visual diff and no network capture UI**;
  those, real-device conformance and competitive benchmarks remain **R9+**. `inspect` is
  data-only and read-only.
- **Not implemented (R9+)**: real-device conformance, visual diff, network capture UI,
  multi-OS/cross-host synchronization, a device matrix, TLS/auth/cloud deployment, competitive
  benchmarks, a remote package marketplace and a debugger/profiler GUI. GPU effect kernels,
  GPU presentation and Vulkan/ANGLE/D3D remain outside this CLI.

## Layout

```
bin/opurom.mjs        dispatcher (shebang, executable)
bin/sync-hub.mjs      standalone loopback RFC 6455 sync hub helper
lib/args.mjs          parseArgs / requireFlags / parsePort / flagEnabled
lib/paths.mjs         sibling paths, PATH lookup, lazy cargo builds
lib/targets.mjs       8 emitters + spec parsing + build-target validation
lib/proc.mjs          spawnSync wrappers
lib/doctor.mjs        toolchain report
lib/init.mjs          scaffold
lib/build.mjs         planBuild / measured optimize / check / build / buildFull / migrate / buildWasm
lib/fullstack.mjs     full-build plan, shared types, artifact stats, wasm helpers
lib/service.mjs       generated-service env, offline-first build, spawn, health wait
lib/serve.mjs         serve command
lib/dev.mjs           static server, SSE, sync hub, fs.watch, client injection, backend restart
lib/bench.mjs         measured timings + artifact sizes + bench --full table
lib/r4.mjs            measured profile + read-only layer/a11y inspect
lib/r6.mjs            safe JS minifier, unused asset removal, measured size report
lib/r7.mjs            profile --repeat stats + environment, bench --compare byte equality
lib/r8.mjs            RFC 6455 codec + loopback hub + N-client sync verification
lib/e2e.mjs           end-to-end assertions
templates/main.opu    counter-based scaffold source
test/fixtures/inspect.opuir.json  R4 inspector fixture
test/fixtures/r6/*.js.fixture     real emitter outputs (web, mini programs, wasm host)
test/r8.test.mjs      real loopback WebSocket sync tests (10)
test/*.test.mjs       node:test unit suite (80 tests)
```
