# opurom-cli

The OPUROM toolchain CLI. Zero npm dependencies — **Node builtins only** (`node:fs`,
`node:http`, `node:net`, `node:crypto`, `node:os`, `node:perf_hooks`, `node:child_process`,
`node:sqlite`, `node:module`, `node:vm`, `node:test`, `node:assert`). Run it directly:

```sh
node opurom-cli/bin/opurom.mjs <command>
```

This repo assumes the standard sibling layout, with the sibling repositories checked out
next to it:
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
| `doctor` | Checks `rustc`, `cargo`, `node`, `opuromc`, `opurom-render` and the golden spec; prints remediation hints and exits 1 if a required tool is missing. `opurom-core`, `opurom-platform` and the `opurom-gpu` binary behind `bench --compare` are reported as optional from a read-only scan, so two runs over the same workspace print the same rows. |
| `targets` | Prints the emitter names read from `opurom-spec/IR_SCHEMA.md`: `native web wechat alipay qq douyin baidu kuaishou` (plus `wasm` once the wasm emitter is in the spec). |
| `init <dir> [--template counter\|particles\|project]` | Scaffolds `opurom.json` (name + targets), a starter screen (`src/main.opu` from the counter template by default; `--template particles` writes `src/particles.opu` with a seeded particle field and a spring animation), `README.md`, `.gitignore`. `--template project` writes `main.opu`, two imported modules under `models/` and `views/`, and a README describing the layout. Refuses to overwrite a non-empty directory. |
| `check <src.opu>` | Runs `opuromc check` and forwards diagnostics. |
| `build --src <src.opu> --target <name> --out <dir>` | `opuromc compile` to a temp IR, then `opuromc target <ir> --target <name> -o <out>`; `native` additionally runs `cargo build --release` inside `<out>`. Prints a concise summary; nonzero on failure. |
| `build --project <dir> --target <name> --out <dir>` | Resolves `<dir>/main.opu` and its `import` declarations into one program, then runs the same compile-and-lower pipeline. Accepts every target and build flag from `--src`. Errors clearly when `main.opu` is absent. |
| `build --src <src.opu> --target web-dom --out <dir>` | Responsive DOM build: the compiler delegates to the sibling `opurom-web` emitter, which writes a standalone `index.html` with a viewport meta tag and flex layout that reflows on browser resize. `web-dom` is a build target, not a v0.1 IR emitter, so `targets` and `opuromc targets` keep their existing lists. |
| `build --src <src.opu> --target <name> --out <dir> --optimize` | Runs `opuromc optimize <ir> -o <optimized-ir>` before every emitter, prints measured input/output byte sizes and falls back to the original IR with an explicit message if the compiler cannot optimize. Default builds are unchanged. |
| `build --src <src.opu> --target <name> --out <dir> --minify` | Minifies the emitted `.js` files with the built-in safe minifier (comments and non-semantic whitespace only), removes unused generated assets, prints the measured before/after byte table and writes the measured baseline to `<out>/.opurom-size.json`. Works with every target including `full` and `wasm`, and composes with `--optimize`, `--tree-shake` and `--sourcemap`. |
| `build --src <src.opu> --target <name> --out <dir> --tree-shake` | Tokenizes the emitter's own JS, computes top-level function reachability, removes unreachable declarations and unused generated assets, and prints exactly what was removed plus a `fs.statSync` before/after table. No bundler and no third-party dependency graph. |
| `build --src <src.opu> --target <name> --out <dir> --sourcemap` | Emits a `<file>.js.map` Source Map v3 file for each generated JS file and appends `//# sourceMappingURL=<file>.js.map`. Mappings are generated line-start segments, honestly documented as **not line-exact or column-exact**. Composes with `--minify` and `--tree-shake`. |
| `size <dir>` | Prints the measured before/after byte table and reduction percentage for a directory built with `--minify`, `--tree-shake` and/or `--sourcemap`. Every number comes from `fs.statSync` on the real files. |
| `build --src <src.opu> --target full --out <dir>` | The whole full-stack chain in one command: compile → frontend (`web` + `native`) → generated server crate → SQL migrations → `shared/types.json`. Prints an artifact summary, writes `.opurom-manifest.json` and checks it before returning. |
| `verify --out <dir>` | Checks the generated-artifact manifest: every listed artifact and file must exist, keep its recorded byte size and match its recorded SHA-256 digest. Exits 1 with the offending paths. |
| `build --src <src.opu> --target wasm --out <dir>` | `opuromc target --target wasm` then `cargo build --release --target wasm32-unknown-unknown`. |
| `serve --out <dir> [--port N]` | Runs the generated service (`OPR_PORT`, `OPR_DB`), waits for `GET /health`, streams the output, shuts down cleanly on `SIGINT`/`SIGTERM`. |
| `migrate --src <src.opu> --out <dir>` | Compiles the source and writes `migrations/001_create_<model>.sql` + `schema.sql` from the IR models. |
| `dev --src <src.opu> [--port N]` | Serves the generated `web` output over HTTP with SSE hot reload **and** rebuilds/restarts the backend service when the source changes (details below). |
| `dev --src <src.opu> [--port N] --sync` | Adds a dev preview sync hub for N browser clients: one shared state snapshot on connect and the same reload frame for every SSE client. Not a device-conformance or multi-OS claim. |
| `dev --sync [--clients N] [--port N]` | One-shot sync verification: N real RFC 6455 WebSocket clients (default 2, cap 8) connect over loopback TCP to an already running sync hub, dispatch one state event and report MEASURED per-client delivery times plus same-delta equality. A missed delta is FAIL; no hub is a documented SKIP with `n/a (reason)`. |
| `dev --src <src.opu> [--port N] --targets web,wechat` | Compiles once per rebuild and lowers two or more emitter targets from that one IR; serves each target under `/<target>/` and an index page at `/` that lists the targets with links to their entry files. Combines with `--sync`. |
| `bench --src <src.opu> [--out <dir>] [--full] [--json]` | Measured compile / lowering / build times and on-disk artifact sizes, printed as a markdown table. No fps, startup or throughput claims. |
| `bench --src <src.opu> [--out <dir>] --full [--json]` | Adds measured render, native/wasm build, one service `GET /health` request and exact artifact byte sizes. Unavailable measurements are printed as `n/a (reason)`. |
| `bench --src <src.opu> --compare [--json]` | Renders the SAME scene through the software renderer **and** the GPU backend (`opurom-gpu`), reports both MEASURED times and the byte-equality result of the two outputs. A speed ratio is only printed when the outputs are byte-equal. |
| `profile --src <src.opu> [--frames N] [--json]` | Compiles once, then runs N real `opurom-render` frames and reports MEASURED p50/p95/min/max ms plus achieved fps derived from those frame times. N defaults to 30 and is capped at 600. Software-raster timings on this host only. |
| `profile --src <src.opu> --repeat N [--json]` | Runs the SAME work N times, discards a documented warmup count (reported as `warmup excluded: 2`) and reports the MEASURED median, p95, min, max and achieved fps of the measured runs only, plus the environment description. N defaults to 10 and accepts 1..600. |
| `<bench or profile command> --json` | Emits exactly one stable-schema JSON object with measured milliseconds instead of the human-readable report. Field order and unavailable values are described below. |
| `inspect <ir.json>` | Read-only layer tree (id, kind, bounds, frame-wide dirty-rect status) beside the deterministic a11y tree from `opurom-render --a11y`. Never mutates the IR file. |
| `test` | End-to-end pipeline assertions (`node:assert`). Reports `PASS` / `FAIL` / `SKIP` per check and exits 1 on any failure. |
| `lint-docs [dir]` | Scans Markdown under `dir` (default `.`) for publication red lines, skipping `.git`, `node_modules`, `target`, `tmp` and `dist`. Prints `file:line: rule: text` findings and a summary, and exits 1 on any finding; otherwise prints the scanned file count. |
| `examples` | Lists the apps registered in `opurom-examples/examples.json`: name, source, test count and whether the source is present, plus the app/test totals. |
| `test --examples [--filter <name>] [--jobs N] [--verbose]` | Runs the registered example tests ctest-style: one `PASS` / `FAIL` / `SKIP` line per test, then `tests passed: X, failed: Y, skipped: Z, time N.Ns` and the failed test ids; exits 1 on any failure. Tests of one app run in registry order (render consumes the IR its compile test wrote); apps run in parallel, `--jobs` defaults to min(4, cpus). A missing source marked `required: false` is a SKIP with the reason; a missing `required: true` source is a FAIL. Commands use `{source}` / `{tmp}` placeholders and the `opuromc`, `opurom-render`, `node` tool aliases, so no machine-specific paths are stored in the registry. |

```sh
cd opurom-cli
cli() { node bin/opurom.mjs "$@"; }
cli doctor
cli targets
cli init tmp/demo
cli check tmp/demo/src/main.opu
cli init tmp/field --template particles
cli check tmp/field/src/particles.opu
cli init tmp/app --template project
cli build --project tmp/app --target web --out tmp/app-web
cli build --src ../opurom-spec/counter.opu --target web --out tmp/web
cli build --src ../opurom-spec/counter.opu --target web --out tmp/web-opt --optimize
cli build --src ../opurom-spec/counter.opu --target web --out tmp/web-min --minify
cli build --src ../opurom-spec/counter.opu --target web --out tmp/web-shake --tree-shake
cli build --src ../opurom-spec/counter.opu --target web --out tmp/web-tree-shake --tree-shake --sourcemap --minify
cli size tmp/web-min
cli size tmp/web-tree-shake
cli build --src ../opurom-spec/counter.opu --target wechat --out tmp/wechat
cli build --src ../opurom-spec/counter.opu --target native --out tmp/native
cli bench --src ../opurom-spec/counter.opu --out tmp/bench --full
cli bench --src ../opurom-spec/counter.opu --compare
cli profile --src ../opurom-spec/counter.opu --frames 30
cli profile --src ../opurom-spec/counter.opu --repeat 10
cli inspect ../opurom-spec/counter.opuir.json
# Long-running: cli dev --src tmp/demo/src/main.opu --sync --port 5178
# Start a hub first, then: cli dev --sync --clients 8 --port 5178
# Long-running: cli dev --src tmp/demo/src/main.opu --targets web,wechat --port 5179
cli test
```

`package.json` scripts: `node --test` (`npm test`) runs the dependency-free unit suite;
`node bin/opurom.mjs doctor` (`npm run doctor`) runs the toolchain check.

## Multi-file projects

`init <dir> --template project` writes an app entry with two imported modules.
The app entry is `<dir>/main.opu`; it imports `models/todo.opu` (a `model` and an
`api` block) and `views/dashboard.opu` (`state` and `theme`). `opuromc compile`
resolves those imports from the main file and merges their declarations into one
IR before lowering, so `--project` accepts the same targets and flags as `--src`.
Imported modules contribute `state`, `model`, `api`, `theme` and nested `import`
declarations; UI nodes and event handlers stay in the app entry. `build --project`
reports an error when `<dir>/main.opu` is absent, and `--src` with `--project` is
rejected. Files in the project directory are compiled when an import reaches them.

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
cd opurom-cli
node bin/opurom.mjs build --target full --src ../opurom-examples/todo.opu --out tmp/full
```

```
build ok: ../opurom-examples/todo.opu [full] -> /.../tmp/full
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
| `.opurom-manifest.json` | Generated-artifact manifest: measured sizes and SHA-256 digests of the files above. |

The chain is: `opuromc compile` → `opuromc target --target web|native` → `opurom-serverc`
→ `opurom-migrate`. Missing sibling binaries are built lazily with
`cargo build --manifest-path <repo>/Cargo.toml`; a sibling repo that is genuinely absent is a
hard error, never a silent success.

#### Generated-artifact manifest

`<out>/.opurom-manifest.json` lists the expected roots (`web`, `native`, `server`,
`migrations`, `shared`, `app.opuir.json`) with measured file counts and byte sizes, plus a
path-sorted list of every generated file with its measured byte size and SHA-256 digest.
Build output written later by `cargo` under `target/` is excluded. The build checks the
manifest immediately; the same check is available after the output is copied or edited:

```sh
node bin/opurom.mjs verify --out tmp/full
```

It prints `manifest ok: ...` on success. A missing manifest, a missing artifact, a changed
byte size or a changed digest fails with a message naming the offending path and exits 1.
Existing build, size and serve output is unchanged.

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
never reports a silent optimized build. A build without `--optimize` uses exactly the
standard compile/lower path; a clean `HEAD` CLI and the default CLI produced byte-identical
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
   were not written by this build — for example stale `app.json` / `pages/index/index.js` files
   left in the output directory by an earlier `wechat` build. Every removed file is printed with its
   measured size. Files that are not emitter assets (your own files, the `server/`, `shared/`
   and `migrations/` chain outputs) are never touched.
2. **Minifies the emitted `.js` files** with `lib/minify.mjs`, a small state-machine tokenizer.
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
dir: /tmp/opurom-minify-web.61do4P
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

That scope line is for `--minify` alone. The `--tree-shake` and `--sourcemap` flags print
their own scope, including the
source-map accuracy statement. Those numbers are from one real run of `counter.opu` on this
machine; rerun the command for values on your machine. A build **without any build-output
flags** is byte-identical to the original emitter output: only the opt-in flags change it.

### What `--minify` alone does

- **In-place minification.** For `--minify` alone, files are minified in place. `--tree-shake`
  is a separate opt-in pass.
- **Source maps are written when `--sourcemap` is also given.** A `--minify`-only build has no
  `.map` file; the `--sourcemap` pass adds segment-level maps.
- **The size report is raw file bytes on disk.**
- **The inspected output is the emitter's own output.** The reachability pass analyzes function
  declarations inside that output.
- **`--minify` removes comments and non-semantic whitespace only.** `--tree-shake` removes
  top-level function declarations found unreachable by its tokenizer/state machine.
- **Removed-asset detection is emitter-scoped**, not import-graph based: a file is removed when
  the compiler's own artifact list says it belongs to a different target than the one built.

## `build --tree-shake` and `build --sourcemap`: measured output

```sh
cd <workspace>
node opurom-cli/bin/opurom.mjs build --src opurom-examples/counter.opu \
  --target web --out opurom-cli/tmp/tree-shake-web --tree-shake --sourcemap --minify
```

`--tree-shake` parses the emitter's own generated JS with the tokenizer/state machine in
`lib/optimize.mjs`, collects top-level function declarations and references, follows transitive
and recursive references, and removes only declarations proven unreachable. String, regex
and object-key lookalikes are lexical tokens, not references or declarations. Duplicate names
and shadowed bindings are kept conservatively. It also removes stale emitter assets and
reports **exactly** the function and asset names it removed. `--sourcemap` writes one
`<file>.js.map` per generated JS file and appends `//# sourceMappingURL=<file>.js.map`.
All four flags (`--optimize`, `--minify`, `--tree-shake`, `--sourcemap`) compose in any
combination; every transformed JS file is checked with `node --check`.

One real run on this machine produced `app.js.map` and this measured output (bytes from
`fs.statSync`; the total rises because the source map is a new artifact, not a compression
claim):

```
removed unused generated assets: (none)
tree shake: removed app.js: applyInput (33 B)
source map: app.js.map (2194 B)
| file | before | after | reduction |
| --- | --- | --- | --- |
| app.js | 1438 B | 1291 B | 10.2% |
| app.js.map | n/a | 2194 B | n/a |
| index.html | 383 B | 383 B | 0.0% |
| ir.json | 1411 B | 1411 B | 0.0% |
| total | 3232 B | 5279 B | -63.3% |
measured reduction: -63.3% (before 3232 B -> after 5279 B)
tree shake removed functions: app.js: applyInput (33 B)
OPUROM tree shake (measured with fs.statSync; generated JS only)
| app.js | 1438 B | 1405 B | 2.3% |
measured tree-shake reduction: 2.3% (before 1438 B -> after 1405 B)
source maps: app.js -> app.js.map (2194 B)
```

An abbreviated sample of that real `app.js.map` (the real file contains the complete
`mappings` string and the full original JS in `sourcesContent`):

```json
{
  "version": 3,
  "file": "app.js",
  "sources": ["app.js"],
  "sourcesContent": ["// Generated by opuromc for app Counter; ...\n\"use strict\";\n..."],
  "names": ["ctx", "render", "canvas"],
  "mappings": "AACA;AACA;AACA;AACA;AAEA;AACEA;...;AAEAD",
  "x_opurom_accuracy": "Generated line starts to original token positions; not line-exact or column-exact; generated columns > 0 are unmapped.",
  "x_opurom_source": "Emitter JS before tree shaking/minification; sourcesContent is that original text."
}
```

The map parses with `new SourceMap(map)` from `node:module`. **Mapping honesty:** each
generated line start maps to an original token line/column; generated columns greater than
zero are deliberately unmapped. This is a valid Source Map v3, **not** a line-exact or
column-exact map and not source-map chaining. There is **no bundler, no third-party
dependency graph, no Brotli/zstd and no scope-hoisting**. Full column/token mappings,
source-map chaining, bundling, third-party graph analysis and scope-hoisting are not
implemented.

## Unit tests

```sh
cd opurom-cli && node --test
```

These cover `lib/args.mjs` (flag parsing, target validation, port, boolean flags),
`lib/paths.mjs` (executable and sibling-binary discovery), `lib/targets.mjs` (emitter list
parsed from the spec, build-target validation), `lib/build.mjs` (compile/lower/cargo
orchestration plan, optimizer step, measured byte formatting, explicit fallback),
`lib/fullstack.mjs` (full-build plan, shared types, artifact summary, artifact manifest
write/verify, temp-path guard),
`lib/service.mjs` (env/port/db handling, service binary discovery), `lib/bench.mjs`
(markdown table, byte formatting, exact measured rows and `n/a (reason)`), `lib/dev.mjs`
(SSE client injection, path-traversal guard, SSE framing, sync hub bookkeeping),
`lib/async_runtime.mjs`
(percentile math, frame caps, measured/`n/a` profile reports, deterministic layer formatting,
read-only `inspect`), `lib/minify.mjs` (minifier literal edge cases, `node --check` on every
emitter's real output, golden web app behaviour in a DOM harness, measured size report math,
unused asset removal, byte-identical default build), `lib/profile.mjs` (repeat-count validation,
warmup-exclusion arithmetic, percentile math on known arrays, the environment description, the
`profile --repeat` report, the compare byte-equality reporting and the unavailable-GPU path),
`lib/sync.mjs` (RFC 6455 handshake and masked-frame vectors, cap validation, measured reports,
real N-client same-delta verification, dropped-client FAIL, no-hub SKIP and socket cleanup),
`lib/optimize.mjs` (reachability on used/unused/recursive/string-lookalike fixtures, Source Map v3
shape and `node:module` parsing, all 16 flag combinations, default byte identity, exact
function/asset removal and `fs.statSync` size math), `lib/examples.mjs` (registry schema
validation, listing rows, filter, jobs cap, parallel pool, summary math and exit codes against a
fake registry) and the e2e output parsers.
`test/catalog.test.mjs` also drives stub compilers,
two SSE clients and a real local `dev --sync` server; `test/async_runtime.test.mjs` drives a stub renderer
and compares IR bytes before/after `inspect`; `test/profile.test.mjs` drives stub compiler, renderer
and GPU-backend binaries; `test/sync.test.mjs` starts a real loopback TCP WebSocket hub without
the sibling Rust server; `test/optimize.test.mjs` drives stub compilers without sibling Rust repos;
`test/examples.test.mjs` covers the example registry, listing, filter, jobs cap, pool and summary
math with trivial `node -e` commands. The 100 unit tests pass with **no sibling Rust repos
present** (the shipped-registry and `opurom examples` checks skip when the sibling repo is absent).

## `test`: end-to-end checks

`node bin/opurom.mjs test` runs the checks below and prints `PASS` / `FAIL` / `SKIP` per
check:

1. `doctor` passes.
2. Compile golden `counter.opu` and `assert.deepEqual` the parsed IR vs
   `opurom-spec/counter.opuir.json`.
3. Build `web`, `node --check` the generated `app.js`.
4. Build `wechat`, `node --check` the generated root `app.js` and `pages/index/index.js`.
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
Check 6 needs `cargo` on `PATH`.

## `dev`: HTTP + SSE hot reload, backend rebuild

```sh
cd opurom-cli
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
reload — state-preserving reload for the v0.1 web emitter. The responsive `web-dom` page
restores and re-renders from the same snapshot inside its own script instead of using an
`app.js` rewrite, so both preview paths preserve state across a reload. Static files
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

The sync verifier is a one-shot command. It does **not** start a hub. Start the small in-repo
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
checks, ping/pong, close and 1 MiB frame / 8 MiB message caps. It adds only the broadcast
rule. There are no extensions, no subprotocol negotiation, no TLS and no authentication.

The sync hub verifies **loopback clients on one host**. The command verifies the sync path
itself: the delta delivery, the measured timings and the socket cleanup.

## `dev --targets`: several target previews from one IR

```sh
node bin/opurom.mjs dev --src tmp/dev-demo.opu --targets web,wechat --port 5178
curl -s http://127.0.0.1:5178/          # index page listing the targets with links
curl -s http://127.0.0.1:5178/web/index.html
curl -s http://127.0.0.1:5178/wechat/app.js
```

`--targets` accepts a comma-separated list of nine dev targets: the eight emitter targets
(`native`, `web`, `wechat`, `alipay`, `qq`, `douyin`, `baidu`, `kuaishou`) plus `web-dom`.
Each rebuild compiles the source
once and lowers every listed target from that one IR into its own subdirectory of the dev
output, so the previews show one compiled program instead of per-target recompiles that
could drift apart. The dev server serves each target under `/<target>/` and an index page at
`/` that lists the targets with a link to each target's entry file (the target's
`index.html` when the emitter writes one, otherwise its first emitted file). The injected
SSE client is added to the index page and to each target's emitted `index.html`; the `web`
target keeps the state-preserving reload rewrite, other targets receive no state rewrite. A
source change rebuilds every listed target from one fresh compile and broadcasts the same
`reload` frame to every connected client. `/health` reports the target list in a `targets`
field.

`--targets` accepts dev targets only: `full` and `wasm` drive cargo builds and are
rejected with `invalid --targets: <name> (expected one of native, web, ...)` before the
server starts. Without `--targets`, `dev` serves `web-dom` from the output root; `web`
remains available through `--targets web`. `--targets` combines with `--sync`: the preview
hub serves the same listing page to every connected browser client, and a source change
broadcasts one `reload` frame after all listed targets are rebuilt.

`web-dom` is the default dev preview. Its emitted `index.html` carries a viewport meta tag,
five `@media` breakpoints and DOM UI nodes. The dev server injects the SSE client into that
page, so a source change still broadcasts a reload. The page owns a small state runtime: it
restores the `opurom.state` `sessionStorage` snapshot over the IR's initial values, re-renders
the bound nodes from the live state, and writes edited values back to the snapshot, so a save
reloads the page with its current state. `/health` lists the targets receiving the snapshot in
`stateRestore`.

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
src: ../opurom-spec/counter.opu
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
`frames / sum(measured frame times)`. The report also states the renderer process's peak
resident set size and user+system CPU time, measured with the host's `/usr/bin/time` (`-l` on
macOS, `-v` on Linux, falling back to a `ps`-poll when it is absent) and reported as `n/a
(reason)` when the host exposes neither value. Every frame is checked for renderer `digest=` / `dirty=`
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
src: ../opurom-spec/counter.opu
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

## Machine-readable reports

`--json` is accepted by `bench`, `bench --full`, `bench --compare`, `profile` and
`profile --repeat`. It writes exactly one JSON object on stdout; the human-readable
report is unchanged when the flag is absent. Tool progress lines are also suppressed
so stdout remains parseable.

Top-level keys are always written in this order: `command`, `mode`, `frames`,
`p50`, `p95`, `min`, `max`, `unit`, `memory`, `cpu`, `backends`, `byteEqual`,
`reason`. `frames` is
the count of real timing samples behind the statistics. `p50`, `p95`, `min`, and
`max` are derived from those samples and are milliseconds; `unit` is always `ms`.
`mode` is `single` for `bench` and `profile`, `full` for `bench --full`, `repeat`
for `profile --repeat`, and `compare` for `bench --compare`.

`memory` and `cpu` describe the renderer process of the measured runs. `memory`
has the keys `peakRssKb`, `peakRssMb` and `reason`; `cpu` has `userMs`,
`systemMs`, `totalMs`, `maxTotalMs` and `reason`. A command that does not measure
the renderer process leaves both metric objects with `null` values and a `reason`;
the profile commands fill them from the measured runs.

`backends` is empty except in `compare` mode, where it holds `software` and `gpu`
objects in that order. Each backend object has the stable keys `name`, `frames`,
`p50`, `p95`, `min`, `max`, `reason`. `byteEqual` is `true`, `false` or `null` when
byte equality could not be checked. If no timing could be measured, the statistic
fields are `null` and `reason` carries the cause. Invalid or non-finite samples
make the report fail rather than substitute estimates.

The CLI exit code still reports measurement availability. JSON mode does not add
fps, startup, throughput, device or competitor claims.

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

## Status

- **Implemented and unit-tested now**: arg parsing, path/tool discovery, lazy cargo builds
  (offline-forced for the sibling Rust tools), offline-first generated-service builds,
  `doctor`, `targets`,
  `init`, `check`, `build` (emitter, `full`, `wasm`, opt-in `--optimize`, `--minify`,
  `--tree-shake`, `--sourcemap`, all composing),
  `serve`, `migrate`, `dev` (HTTP + SSE + fs.watch + state-preserving reload + backend
  rebuild/restart + `--sync` preview hub + `--targets` multi-target preview from one IR),
  `dev --sync --clients N` (real N-client RFC 6455
  loopback verification with measured delivery times), `bench` (default shape, measured
  `--full` table and `--json` reports), `bench --compare` (software vs GPU backend, both MEASURED,
  paired with the byte-equality result and a `--json` schema), `profile` (measured sequential
  software-raster frames with honest `n/a` and `--json`),
  `profile --repeat` (measured repeated work, warmup excluded and reported, environment stated,
  `--json`),
  `inspect` (read-only layer/a11y trees), `lint-docs` (publication checks for Markdown),
   `size` (measured before/after byte table), `examples`
  (ctest-style example registry listing), `test --examples` (parallel example test runner), `test`
  orchestration (incl. full-stack, wasm and minified-build checks), README, own git repo,
  clean tree.
- `node --test`: the dependency-free unit suite (122 tests)
  passes with **no sibling Rust repo present**. It covers the example registry schema, listing,
  filter, jobs cap, pool and summary math, plus the new flags, exact measured
  formatting, the stable JSON schema, real-process JSON reports, optimizer success/fallback, sync hub bookkeeping, a real two-client
  `dev --sync` SSE server, percentile math, frame caps, layer formatting, an `inspect` byte
  comparison, the minifier, the measurement layer, the RFC 6455 vectors, cap
  validation, N=2/N=8 same-delta runs, different/dropped-delta failures, no-hub SKIP,
  real loopback socket cleanup, reachability fixtures, Source Map v3 parsing, the 16-way
  flag matrix, default byte identity, exact removal reports, measured size math, the
  `dev --targets` parser, the target listing page, a multi-target dev server run against a
  stub compiler, publication checks and the doctor renderer/GPU availability report.
- `node bin/opurom.mjs test`: 10 checks PASS at commit time — the seven core checks, the
  full-stack check (real service on a free port: health, POST 201, GET list, GET one, PUT,
  DELETE, 404, SSR, persisted SQLite row), the wasm check (build +
  `WebAssembly.instantiate` + `opu_version() == 1`) and the minified-build check
  (`node --check` on the minified `app.js` plus the measured before/after sizes). The
  `--tree-shake`, `--sourcemap` and `--minify` flags add unit coverage and a real
  `--tree-shake --sourcemap --minify` CLI run; they do not change the 10-check e2e suite.
- Verified by hand against the real toolchain: default `build` output was byte-identical to a
  clean `HEAD` CLI (identical `app.js`, `index.html` and `ir.json` checksums); `build
  --optimize` printed measured `1411 B -> 1411 B` on `counter.opu`; `build --minify` measured
  `app.js 1438 B -> 1292 B` (`3232 B -> 3086 B` total, 4.5%) on `counter.opu` and removed stale
  mini-program emitter assets left in the output directory by an earlier build; `bench --full`
  measured six steps and one `GET /health`, with
  the real numbers shown above; two `dev --sync` SSE clients received snapshots and the same
  reload frame after a source change; real N=2 and N=8 RFC 6455 loopback clients each received
  the same state delta with MEASURED per-client `hrtime` delivery times and clean socket
  shutdown; `profile` ran real renderer frames and printed MEASURED
  percentiles plus derived fps; `inspect` printed the side-by-side trees from
  `opurom-render --a11y` without changing IR bytes; `profile --repeat 10` ran ten real renderer
  runs, excluded two warmup runs and printed the measured statistics of the eight remaining
  runs; `bench --compare` rendered the same scene through `opurom-render` and `opurom-gpu` and
  reported **byte-equal** outputs with both measured times. The exact web command measured
  `app.js 1438 B -> 1405 B` from tree shaking (2.3%, `applyInput` 33 B), then `app.js 1438 B
  -> 1291 B` after minification (10.2%); `app.js.map` was 2194 B and the overall artifact
  total was `3232 B -> 5279 B` (-63.3%) because the map is a new file. `node --check` passed
  on the final `app.js`, and `new SourceMap(map)` parsed the v3 map. No number is invented.
- If a sibling repo is genuinely absent (or has no `Cargo.toml` yet), `test` prints **SKIP**
  with the reason instead of a false pass. Unavailable `bench --full` rows, `profile`,
  `profile --repeat` and `bench --compare` measurements print `n/a (reason)`.
- **Measurement scope**: `profile --repeat` measures this host's software raster only and states
  the CPU, the OS release, the Node version and the raster kind; it cannot observe machine
  idleness from inside the CLI and does not claim it. `bench --compare` compares two **OPUROM**
  backends against each other only: **no competitor binary is executed and no competitor
  number is estimated**. The comparison is a relative measurement between two backends of
  this project, reported together with the byte-equality result of the two outputs.
  `bench --compare` prints a speed ratio only when the two outputs are byte-equal. The
  `--minify` pass removes comments and non-semantic whitespace; the `--tree-shake` pass adds
  top-level function reachability over the emitter's own JS and valid v3 **segment-level
  line-start** maps that are explicitly **not** line-exact or column-exact. `inspect` is
  data-only and read-only: it parses the IR without writing to it and reports the
  renderer's layer and a11y trees.
- **The CLI covers its own toolchain**: arg parsing, path/tool discovery, lazy cargo builds,
  offline-first generated-service builds, `doctor`, `targets`, `init`, `check`, `build`,
  `serve`, `migrate`, `dev`, `bench`, `profile`, `inspect`, `size` and `test`. GPU effect
  kernels, GPU presentation and Vulkan/ANGLE/D3D are the responsibility of `opurom-gpu` and
  `opurom-render`.

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
lib/build.mjs         planBuild / measured optimize / check / projectMain / build / buildFull / migrate / buildWasm
lib/fullstack.mjs     full-build plan, shared types, artifact stats + manifest, wasm helpers
lib/service.mjs       generated-service env, offline-first build, spawn, health wait
lib/serve.mjs         serve command
lib/dev.mjs           static server, SSE, sync hub, fs.watch, client injection, backend restart, multi-target preview
lib/bench.mjs         measured timings + artifact sizes + bench --full table + JSON samples
lib/async_runtime.mjs measured profile + JSON schema + read-only layer/a11y inspect
lib/minify.mjs        tokenizer, safe JS minifier, asset removal, measured size report
lib/profile.mjs       profile --repeat stats + environment, bench --compare byte equality + JSON
lib/sync.mjs          RFC 6455 codec + loopback hub + N-client sync verification
lib/optimize.mjs      reachability analysis, tree shaking, v3 segment-level source maps
lib/examples.mjs      example registry, listing and ctest-style parallel test runner
lib/e2e.mjs           end-to-end assertions
templates/main.opu    counter-based scaffold source
templates/particles.opu  seeded particle-field scaffold source
templates/project/    multi-file app entry, two modules and README
test/fixtures/inspect.opuir.json  inspector fixture
test/fixtures/emit/*.js.fixture   real emitter outputs (web, mini programs, wasm host)
test/sync.test.mjs    real loopback WebSocket sync tests (10)
test/optimize.test.mjs  reachability, source maps, composition and size tests (8)
test/examples.test.mjs  example registry and runner tests (12)
test/bench-json.test.mjs  real-process JSON report tests (8)
test/doctor.test.mjs   toolchain report tests (3)
test/project.test.mjs project entry, imports and scaffold build tests (5)
test/*.test.mjs       node:test unit suite (133 tests)
```
