# OPUROM project

A multi-file OPUROM project. The compiler resolves the `import` declarations in
[main.opu](main.opu) and merges declarations from
[models/todo.opu](models/todo.opu) and
[views/dashboard.opu](views/dashboard.opu) into one program before lowering.

## Layout

- [main.opu](main.opu) is the app entry. It declares the UI tree and imports the two modules.
- [models/todo.opu](models/todo.opu) declares the Todo `model` and its `api` block.
- [views/dashboard.opu](views/dashboard.opu) declares the `state` and `theme` used by the UI.
- `opurom.json` records the project name, the emitters and the module roots.
- `.gitignore` excludes generated output.

Imported modules contribute `state`, `model`, `api`, `theme` and nested `import`
declarations. UI nodes and event handlers stay in the app entry. Adding a module
requires an `import` line in the app entry; other files in the project are not
compiled unless an import reaches them.

## Build

From the project directory:

```sh
node <path-to>/opurom-cli/bin/opurom.mjs build --project . --target web --out dist/web
```

`--project` discovers `main.opu` and passes that file through the same
compile-and-lower pipeline used by `--src`, so every target receives the merged
program. `--src` and `--project` are mutually exclusive.
