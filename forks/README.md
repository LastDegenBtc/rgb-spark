# forks/

This directory is a placeholder. Submodules land here in Phase 1, **not
before** — Phase 0 (`../scoping/`) must conclude with a green crate-map
and a working seal prototype first.

## Phase 1 plan (when we get there)

Add as git submodules at the pinned tags listed in
`../scoping/01-crate-map.md`:

```bash
git submodule add -b spark-utk <fork-url> forks/bp-core
git submodule add -b spark-utk <fork-url> forks/rgb-core
git submodule add -b spark-utk <fork-url> forks/rgb-lib
```

Each fork carries a `spark-utk` branch off the pinned upstream tag, with
the changes mapped in `../scoping/01-crate-map.md`. Rebase strategy:
keep the branch fast-forwardable from upstream until upstream merges
(or refuses).

## Why submodules instead of vendored copies

- Clean `git log` — fork commits visible upstream-style, not buried in
  this repo's history
- Trivial rebase against upstream releases
- Trivial PR submission upstream once the design is stable
