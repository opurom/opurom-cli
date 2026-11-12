# opurom-cli

The OPUROM toolchain CLI. Zero npm dependencies — **Node builtins only** (`node:fs`,
`node:http`, `node:net`, `node:child_process`, `node:sqlite`, `node:test`, `node:assert`).
Run it directly:

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
| `build --src <src.opu> --target full --out <dir>` | The whole full-stack chain in one command: compile → frontend (`web` + `native`) → generated server crate → SQL migrations → `shared/types.json`. Prints an artifact summary. |
| `build --src <src.opu> --target wasm --out <dir>` | `opuromc target --target wasm` then `cargo build --release --target wasm32-unknown-unknown`. |
| `serve --out <dir> [--port N]` | Runs the generated service (`OPR_PORT`, `OPR_DB`), waits for `GET /health`, streams the output, shuts down cleanly on `SIGINT`/`SIGTERM`. |
| `migrate --src <src.opu> --out <dir>` | Compiles the source and writes `migrations/001_create_<model>.sql` + `schema.sql` from the IR models. |
| `dev --src <src.opu> [--port N]` | Serves the generated `web` output over HTTP with SSE hot reload **and** rebuilds/restarts the backend service when the source changes (details below). |
| `bench --src <src.opu> [--out <dir>]` | Measured compile / lowering / build times and on-disk artifact sizes, printed as a markdown table. No fps, startup or throughput claims. |
| `test` | End-to-end pipeline assertions (`node:assert`). Reports `PASS` / `FAIL` / `SKIP` per check and exits 1 on any failure. |

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

## Unit tests

```sh
cd /Users/mac/work/opurom/opurom-cli && node --test
```

These cover `lib/args.mjs` (flag parsing, target validation, port), `lib/paths.mjs`
(executable and sibling-binary discovery), `lib/targets.mjs` (emitter list parsed from the
spec, build-target validation), `lib/build.mjs` (compile/lower/cargo orchestration plan),
`lib/fullstack.mjs` (full-build plan, shared types, artifact summary, temp-path guard),
`lib/service.mjs` (env/port/db handling, service binary discovery), `lib/bench.mjs`
(markdown table, byte formatting), `lib/dev.mjs` (SSE client injection, path-traversal guard,
SSE framing) and the e2e output parsers. They pass with **no sibling Rust repos present**.

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

## `bench`: measured numbers only

```sh
node bin/opurom.mjs bench --src ../opurom-spec/counter.opu --out tmp/bench
```

```
OPUROM bench (measured on this machine, this run)

| step | elapsed |
| --- | --- |
| compile (opuromc compile) | 8 ms |
| lower to web (opuromc target --target web) | 5 ms |
| native build (cargo build --release) | 412 ms |

| artifact | files | bytes |
| --- | --- | --- |
| web | 3 | 24.4 KiB |
| native | 2 | 1.1 KiB |
```

Every number is a wall-clock measurement of a real command on this machine plus the real
on-disk size of the generated files. There are deliberately **no** fps, cold-start or
throughput claims: no GPU backend and no device matrix exist yet.

## Status (round 2)

- **Implemented and unit-tested now**: arg parsing, path/tool discovery, lazy cargo builds,
  `doctor`, `targets`, `init`, `check`, `build` (emitter, `full`, `wasm`), `serve`, `migrate`,
  `dev` (HTTP + SSE + fs.watch + state-preserving reload + backend rebuild/restart), `bench`
  (measured times and sizes), `test` orchestration (incl. the full-stack and wasm checks),
  README, own git repo, clean tree.
- `node --test`: the dependency-free unit suite (35 tests) passes with **no sibling Rust repo
  present**.
- `node bin/opurom.mjs test`: 9 checks PASS at commit time — the 7 round-1 checks, the
  full-stack check (real service on a free port: health, POST 201, GET list, GET one, PUT,
  DELETE, 404, SSR, persisted SQLite row) and the wasm check (build +
  `WebAssembly.instantiate` + `opu_version() == 1`).
- Verified by hand against the real toolchain: `build --target full` produces frontend,
  service crate, migrations and `shared/types.json`; `serve` answers
  `{"ok":true,"app":"TodoApp","version":"0.2.0"}` on `/health`, persists rows in
  `<out>/data/opurom.db` and stops on `SIGINT`; `dev` restarts the backend on a source change
  (`backend.restarts` grows in `/health`); `bench` prints measured times and sizes only.
- If a sibling repo is genuinely absent (or has no `Cargo.toml` yet), `test` prints **SKIP**
  with the reason instead of a false pass.
- **Not implemented (R3+)**: TLS and authentication, cloud/container deployment recipes,
  multi-DB drivers (PostgreSQL/MySQL — only SQLite and the embedded KV store exist), a
  debugger/profiler (DAP), multi-device sync, connection pooling (the generated service opens
  one SQLite connection per request), streaming responses and real device benchmarks.
  The CLI does not advertise them.

## Layout

```
bin/opurom.mjs        dispatcher (shebang, executable)
lib/args.mjs          parseArgs / requireFlags / parsePort
lib/paths.mjs         sibling paths, PATH lookup, lazy cargo builds
lib/targets.mjs       8 emitters + spec parsing + build-target validation
lib/proc.mjs          spawnSync wrappers
lib/doctor.mjs        toolchain report
lib/init.mjs          scaffold
lib/build.mjs         planBuild / check / build / buildFull / migrate / buildWasm
lib/fullstack.mjs     full-build plan, shared types, artifact stats, wasm helpers
lib/service.mjs       generated-service env, build, spawn, health wait
lib/serve.mjs         serve command
lib/dev.mjs           static server, SSE, fs.watch, client injection, backend restart
lib/bench.mjs         measured timings + artifact sizes
lib/e2e.mjs           end-to-end assertions
templates/main.opu    counter-based scaffold source
test/*.test.mjs       node:test unit suite
```
