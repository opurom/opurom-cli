# opurom-cli

The OPUROM toolchain CLI. Zero npm dependencies — **Node builtins only** (`node:fs`,
`node:http`, `node:net`, `node:os`, `node:perf_hooks`, `node:child_process`, `node:sqlite`,
`node:test`, `node:assert`). Run it directly:

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
| `build --src <src.opu> --target full --out <dir>` | The whole full-stack chain in one command: compile → frontend (`web` + `native`) → generated server crate → SQL migrations → `shared/types.json`. Prints an artifact summary. |
| `build --src <src.opu> --target wasm --out <dir>` | `opuromc target --target wasm` then `cargo build --release --target wasm32-unknown-unknown`. |
| `serve --out <dir> [--port N]` | Runs the generated service (`OPR_PORT`, `OPR_DB`), waits for `GET /health`, streams the output, shuts down cleanly on `SIGINT`/`SIGTERM`. |
| `migrate --src <src.opu> --out <dir>` | Compiles the source and writes `migrations/001_create_<model>.sql` + `schema.sql` from the IR models. |
| `dev --src <src.opu> [--port N]` | Serves the generated `web` output over HTTP with SSE hot reload **and** rebuilds/restarts the backend service when the source changes (details below). |
| `dev --src <src.opu> [--port N] --sync` | Adds a dev preview sync hub for N browser clients: one shared state snapshot on connect and the same reload frame for every SSE client. Not a device-conformance or multi-OS claim. |
| `bench --src <src.opu> [--out <dir>]` | Measured compile / lowering / build times and on-disk artifact sizes, printed as a markdown table. No fps, startup or throughput claims. |
| `bench --src <src.opu> [--out <dir>] --full` | Adds measured render, native/wasm build, one service `GET /health` request and exact artifact byte sizes. Unavailable measurements are printed as `n/a (reason)`. |
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
cli build --src ../opurom-spec/counter.opu --target wechat --out tmp/wechat
cli build --src ../opurom-spec/counter.opu --target native --out tmp/native
cli bench --src ../opurom-spec/counter.opu --out tmp/bench --full
# Long-running: cli dev --src tmp/demo/src/main.opu --sync --port 5178
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
(SSE client injection, path-traversal guard, SSE framing, sync hub bookkeeping) and the e2e
output parsers. `test/r3.test.mjs` also drives stub compilers, two SSE clients and a real
local `dev --sync` server. They pass with **no sibling Rust repos present**.

## `test`: end-to-end checks

`node bin/opurom.mjs test` runs the checks below and prints `PASS` / `FAIL` / `SKIP` per
check:

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
8. **Full stack**: build a Todo `.opu` (the `opurom-examples/todo.opu` fixture when present,
   otherwise an inline fixture), start the generated service on a free port and assert
   `GET /health`, `POST /todos` → a created row, `GET /todos` containing that row,
   `GET /todos/:id`, `PUT` update, `DELETE`, a 404 for an unknown row, `GET /ssr` containing
   the app name, and the SQLite row. The server is stopped afterwards.
9. **wasm**: build the `wasm32-unknown-unknown` crate, instantiate the `.wasm` with an empty
   import object and assert `opu_version() == 1` (plus the tap/state round trip when the IR
   has an incrementing button).

If a sibling repo is genuinely absent (or has no `Cargo.toml` yet), that check prints
**SKIP** with the reason instead of a false pass. A build failure, a wrong IR, invalid
generated JS, a failing API call or a missing binary is a real **FAIL** with a diagnostic.
Check 5 needs `cargo` on `PATH` (or `$HOME/.cargo/bin`).

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

Those values are from that run only; rerun the command for values on your machine. There are
deliberately **no** fps, startup, throughput or competitor claims: no GPU backend and no
device matrix exist yet.

## Status (round 3)

- **Implemented and unit-tested now**: arg parsing, path/tool discovery, lazy cargo builds,
  offline-first generated-service builds, `doctor`, `targets`, `init`, `check`, `build`
  (emitter, `full`, `wasm`, opt-in `--optimize`), `serve`, `migrate`, `dev` (HTTP + SSE +
  fs.watch + state-preserving reload + backend rebuild/restart + `--sync` preview hub), `bench`
  (default shape and measured `--full` table), `test` orchestration (incl. full-stack and wasm
  checks), README, own git repo, clean tree.
- `node --test`: the dependency-free unit suite (43 tests) passes with **no sibling Rust repo
  present**. It covers the new flags, exact measured formatting, optimizer success/fallback,
  sync hub bookkeeping and a real two-client `dev --sync` SSE server.
- `node bin/opurom.mjs test`: 9 checks PASS at commit time — the 7 round-1 checks, the
  full-stack check (real service on a free port: health, POST 201, GET list, GET one, PUT,
  DELETE, 404, SSR, persisted SQLite row) and the wasm check (build +
  `WebAssembly.instantiate` + `opu_version() == 1`).
- Verified by hand against the real toolchain: default `build` output was byte-identical to a
  clean `HEAD` CLI (identical `app.js`, `index.html` and `ir.json` checksums); `build
  --optimize` printed measured `1411 B -> 1411 B` on `counter.opu`; `bench --full` measured six
  steps and one `GET /health`, with the real numbers shown above; two `dev --sync` SSE clients
  received snapshots and the same reload frame after a source change. No number is invented.
- If a sibling repo is genuinely absent (or has no `Cargo.toml` yet), `test` prints **SKIP**
  with the reason instead of a false pass. Unavailable `bench --full` rows print
  `n/a (reason)`.
- **Not implemented (R4+)**: Metal/Vulkan/ANGLE GPU backends, real OS-native window adapters,
  PostgreSQL/MySQL, cloud deployment, TLS/auth, async/await in the language, a package
  marketplace, a JetBrains IDE plugin, real fps/device benchmarks, a 100+ distinct primitive
  renderer, connection pooling and streaming responses. There is **no debugger/profiler GUI** in
  this CLI; the separate DAP subset server has no GUI client. There is **no multi-OS sync**:
  `dev --sync` is a dev preview hub for N browser clients, not device-conformance testing or
  real multi-device synchronization. No competitor claims are made.

## Layout

```
bin/opurom.mjs        dispatcher (shebang, executable)
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
lib/e2e.mjs           end-to-end assertions
templates/main.opu    counter-based scaffold source
test/*.test.mjs       node:test unit suite (43 tests)
```
