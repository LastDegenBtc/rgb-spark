# 03 · Spark-UTK test vectors

> Phase 0 deliverable.
> **Source of truth**: `02-seal-prototype/src/bin/emit-vectors.rs`.
> Do **not** hand-edit. Regenerate with:
>
> ```bash
> cd 02-seal-prototype && cargo run --bin emit-vectors
> ```
>
> and paste the output below verbatim, replacing the **PENDING** block.

## Why deterministic vectors

Any future implementer (RGB-WG reviewer, alternative wallet, audit) must
be able to confirm their re-implementation of the construction agrees
with ours by feeding identical `(u_base_sk, operator_sk, m)` and getting
identical `(u_tweaked, V, output_xonly)`. NUMS-style filler inputs make
the vector reproducible without any RNG state.

## Vector v1

Generated 2026-05-10, `cargo run --release --bin emit-vectors`,
`secp256k1 = "0.29"`, `sha2 = "0.10"`.

### Inputs
- `u_base_sk`      = `0x11..11` (32 bytes filler)
- `u_base`         = `034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa`
- `operator_sk`    = `0x22..22` (32 bytes filler)
- `operator`       = `02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27`
- `m`              = `3333333333333333333333333333333333333333333333333333333333333333`

### Outputs
- `u_tweaked`      = `02590567584842f153cc63e4ec8447e543900ff8c26f15f21a51e1996fb8a1e6e8`
- `verifying_key`  = `02d4632ae349ef45b121f35e9bc414efd4fdbc9ecf58e1cbe084ccf8469226853c`
- `output_xonly`   = `5bd9be289c4d4949ea85169a2c5e905d0778fdc50bba06e47dcb3311b7792e50`

### What this vector proves

- The tagged-hash domain separation runs correctly (`Spark-RGB-UTK-v1`).
- `u_tweaked != u_base` — the tweak actually moved the point.
- The full chain `(u_base, m, operator) → output_xonly` is reproducible
  and deterministic; any reimplementation that gets these byte-exact
  outputs from these inputs has the same construction we do.

## Cross-language verification

**Confirmed 2026-05-10.** TS reproduction at `04-repro-ts/repro.mjs`
(uses `@noble/secp256k1` + `@noble/hashes`, no Spark SDK dep) yields
**byte-for-byte identical** `u_tweaked`, `verifying_key`, and
`output_xonly` from the same inputs. Reproduce with:

```bash
cd 04-repro-ts && npm install && node repro.mjs
# → MATCH — construction is portable Rust ↔ TS (byte-for-byte).
```

Two independent implementations (Rust `secp256k1` v0.29 + `sha2` v0.10
on one side, TS `@noble/secp256k1` v2 + `@noble/hashes` v1 on the other)
agreeing on all three outputs is strong evidence that the construction
is unambiguously specified and portable to whichever stack the bp-seals
fork (Rust) and the wallet (TS) end up using. A future verification
against the Spark SDK's own exported primitives
(`applyAdditiveTweakToPublicKey`, `computeTaprootKeyNoScript`) would
add a third independent witness — nice-to-have, not blocking.
