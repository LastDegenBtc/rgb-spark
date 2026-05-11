# 01 · Crate map for Spark-UTK

> Phase 0 deliverable · 2026-05-10
> Goal: identify the **exact crates** that need a code change to land
> `Method::SparkUtk` end-to-end, before committing to a fork.
>
> **Status: complete.** All hypotheses verified against pinned source in
> `~/.cargo/registry/src/...` (matched to `rgb-ark-node`'s lockfile).
> Verdict at the bottom.

## Pinned versions (target)

Cribbed from `rgb-ark-node/Cargo.lock` to stay wire-compatible with
Bitmask 0.11.

| Crate | Version | Source |
|---|---|---|
| `bp-consensus` | `0.11.1-alpha.2+unreviewed` | crates.io (origin: BP-WG/bp-core) |
| `bp-core` | `0.11.1-alpha.2+unreviewed` | crates.io (origin: BP-WG/bp-core) |
| `bp-dbc` | `0.11.1-alpha.2+unreviewed` | crates.io (origin: BP-WG/bp-core) |
| `bp-seals` | `0.11.1-alpha.2+unreviewed` | crates.io (origin: BP-WG/bp-core) |
| `commit_verify` | `0.11.1-alpha.2` | crates.io (origin: LNP-BP/client_side_validation) |
| `rgb-consensus` | `0.11.1-rc.6` | crates.io |
| `rgb-ops` | `0.11.1-rc.6` | crates.io |
| `rgb-invoicing` | `0.11.1-rc.6` | crates.io |
| `rgb-schemas` | `0.11.1-rc.5` | crates.io |
| `rgb-lib` | `0.3.0-beta.4` | git: `RGB-Tools/rgb-lib@9d6a297` |

Inspection clones at `/tmp/spark-utk-inspection/` (bp-core, rgb-lib).
crates.io sources resolved from the local cargo registry cache.

## Confirmed change surface

The Spark-UTK seal touches **three layers**, not the four I initially
hypothesised. The big surprise: `bp-dbc` already has an empty
`keytweak/` module, with documentation describing exactly our
construction (`PublicKey, Msg -> PublicKey'`). Maxim Orlovsky reserved
the namespace; we're filling in a planned slot, not introducing an
alien concept.

### Layer 1 — `bp-dbc` (closing-method primitive)

✓ **Confirmed**: `bp-dbc` is the home of both the `Method` enum and the
per-method proof implementations.

- `bp-dbc/src/proof.rs` defines `pub enum Method { OpretFirst = 0x00, TapretFirst = 0x01 }`
  with `#[repr(u8)]`, `tags = repr`, `into_u8`, `try_from_u8`. **Slot
  0x02 is free.** Adding `SparkUtk = 0x02` is a single-line change.
- `bp-dbc/src/{opret,tapret,sigtweak,keytweak}/` — one module per
  closing method. **`keytweak/` currently contains only `mod.rs`** with
  documentation:

      //! Homomorphic key tweaking-based deterministic commitment scheme.
      //!
      //! **Embed-commit:**
      //! a) `PublicKey, Msg -> PublicKey', PublicKey`;
      //! ...

  This is literally Spark-UTK's construction — the namespace is reserved
  and unimplemented.

**Change**: implement `bp-dbc/src/keytweak/`:
- `mod.rs` — `pub struct SparkUtkProof { u_base: PublicKey, operator_pubkey: PublicKey }` plus `impl Proof<Method>` with `verify(&self, msg: &Commitment, tx: &Tx)` doing the derive-and-compare we already prototyped in `02-seal-prototype/`.
- Companion files following the `tapret/` template (`txout.rs`, `xonlypk.rs`, `tx.rs`) with `EmbedCommitProof` impls (we use embed-commit, not convolve-commit, per the keytweak module doc).
- StrictType derives (`StrictType, StrictDumb, StrictEncode, StrictDecode`) following the existing `TapretProof` pattern at `bp-dbc/src/tapret/mod.rs:352`.

**Estimated scope**: ~200-350 lines of Rust including tests and doc.
The math is fully specified in `02-seal-prototype/src/lib.rs` and the
test vector in `03-test-vectors.md` is the cross-check.

### Layer 2 — `rgb-consensus` (DbcProof aggregation + validator dispatch)

✓ **Confirmed**: rgb-consensus owns the `DbcProof` aggregator enum and
the validator that disambiguates on output type.

- `rgb-consensus/src/validation/commitments.rs:74-83` defines:

      pub enum DbcProof {
          #[strict_type(tag = 0x01)] Tapret(TapretProof),
          #[strict_type(tag = 0x02)] Opret(OpretProof),
      }

  `tags = custom` with explicit per-variant byte tags. **Slot 0x03 is
  free** for `SparkUtk(SparkUtkProof)`.

- `rgb-consensus/src/validation/commitments.rs:87-114` — `dbc::Proof`
  trait impl with `method()` and `verify()`. Two new arms required:
  one for `method()` returning `Method::SparkUtk`, one for `verify()`
  delegating to `sparkutk.verify(msg, tx)`.

- `rgb-consensus/src/validation/validator.rs:476-478` — **subtle gotcha
  here**. Current logic infers `output_method` from output-script type:

      let output_method = if output.script_pubkey.is_op_return() {
          CloseMethod::OpretFirst
      } else { CloseMethod::TapretFirst };

  Spark-UTK *also* produces a p2tr output (`p2tr(verifyingKey, no-script)`),
  so the heuristic "p2tr ⇒ TapretFirst" no longer holds. Two viable fixes:
  (a) trust `proof.method()` and skip the cross-check (the proof's own
  `verify()` will reject if the output doesn't actually commit), or
  (b) generalise the cross-check to "p2tr ⇒ {TapretFirst, SparkUtk}" and
  rely on `proof.method()` to pick. (b) preserves a defence-in-depth.

**Estimated scope**: ~25-40 lines of Rust + a few new test fixtures.

### Layer 3 — `rgb-lib` (wallet integration — the big one)

✓ **Confirmed**: rgb-lib's wallet code is UTXO-centric. Spark-UTK breaks
that assumption.

- `rgb-lib/src/wallet/online.rs:2483, 2649`, `wallet/offline.rs:1762`,
  `wallet/rust_only.rs:243` — the dominant patterns are
  `GraphSeal::new_random_vout(outpoint.txid, outpoint.vout)` and
  `set_rgb_close_method(CloseMethod::OpretFirst)`. Both assume an
  on-chain UTXO under the wallet's control.
- A Spark-UTK seal is **not a UTXO** at issue time. It's a Spark leaf
  with a tweaked user-side pubkey. There's no PSBT to sign for issuance,
  no change output, no UTXO selection.

**Change scope** is the cost driver of the whole project:
- New methods alongside existing ones: `Wallet::issue_via_spark_utk(..)`,
  `Wallet::send_via_spark_utk(..)`, `Wallet::receive_via_spark_utk(..)`,
  `Wallet::exit_to_l1(..)`.
- New consignment transport: serialise `U_base` + `m` + lineage so the
  receiver can reconstruct `t` and validate the commitment locally.
- Decision: parallel API surface on the existing `Wallet` struct, OR a
  separate `SparkWallet` struct that shares only the contract/consignment
  layer. **Recommend the latter** — UTXO and Spark-leaf flows have
  almost no shared state, and forcing them through one object breeds
  bugs.

**Estimated scope**: 800-1500 lines, plus tests. This is the dominant
effort in Phase 1.

### Layer 4 — `pprgb-wallet` (TypeScript, Phase 2)

Out of Phase 0 scope. Pattern: TS wrapper that calls into the forked
`rgb-lib` via Node bindings, then submits `u_tweaked` to the Spark SDK's
`generateDepositAddress`. Cross-language correctness already validated
by `04-repro-ts/` matching the Rust prototype byte-for-byte.

## Strict-encoding wire-format risk

✓ **Resolved — closed-loop case has no wire break.**

Both critical enums use **explicit per-variant tags**, not positional:

- `bp_dbc::Method`: `#[strict_type(tags = repr, into_u8, try_from_u8)]`
  with explicit u8 discriminants. Adding `SparkUtk = 0x02` does not
  shift `OpretFirst` (0x00) or `TapretFirst` (0x01). Existing serialised
  seals decode unchanged.
- `rgb_consensus::DbcProof`: `tags = custom` with `#[strict_type(tag = 0x01)]`
  and `#[strict_type(tag = 0x02)]`. Adding `#[strict_type(tag = 0x03)] SparkUtk(SparkUtkProof)`
  reserves a fresh slot.

- **Forward compat (new code reading old seals)**: works.
- **Backward compat (old code reading new seals)**: errors gracefully via
  `try_from_u8` / unknown-tag failure. No data misinterpretation.

The Bitmask interop story is unchanged from the RFC: Bitmask wallets need
to upgrade their bp-dbc/rgb-consensus dependencies to a version that
knows the new variant. That's exactly what an upstream merge would
deliver. No version-bump dance required at this layer.

## Phase 0 verification checklist

- [x] All "VERIFY" markers above have concrete grep evidence
- [x] Crate-map confirmed: bp-dbc (Method + keytweak/), rgb-consensus
      (DbcProof + validator), rgb-lib (wallet flows). Layers initially
      hypothesised on `bp-seals` / `bp-core` / `commit_verify` were
      wrong — those crates only re-export or define unrelated types
- [x] Strict-encoding wire-format risk classified — no break
- [x] `02-seal-prototype/` builds and its test passes
- [x] `03-test-vectors.md` filled with prototype output
- [x] Cross-language repro (`04-repro-ts/`) matches Rust byte-for-byte
- [x] Go / no-go decision written below

## Verdict (Phase 0 exit)

**GO** for Phase 1 — with eyes open on rgb-lib being the cost driver.

**Estimated Rust LOC by layer**:
- `bp-dbc`: ~250-400 lines (one new variant + one new module
  following the `tapret/` template)
- `rgb-consensus`: ~30-50 lines (enum extension + validator
  disambiguation + tests)
- `rgb-lib`: ~800-1500 lines (parallel `SparkWallet` flow — the new
  paradigm, not a graft on the UTXO pipeline)

**Total**: ~1100-2000 lines of Rust for the closed-loop case, plus the
TS wrapper in Phase 2.

**Calendar estimate** for an experienced rgb-core dev:
- bp-dbc + rgb-consensus: 4-6 working days (the math is specified, the
  patterns are clear from `tapret/`/`opret/`)
- rgb-lib `SparkWallet` flow: 2-3 weeks (this is the real work — new
  transport class in a UTXO-centric library)
- **Total Phase 1: ~3-4 weeks** focused, single experienced dev.

**Top three risks, ranked**:

1. **rgb-lib paradigm mismatch (highest)**. The wallet assumes on-chain
   UTXOs at every layer (PSBT building, change tracking, fee
   estimation). Bolting Spark leaves into that assumption either bloats
   the wallet API or forces a shadow `SparkWallet` that duplicates
   plumbing. Either way, the LOC estimate above could double if we don't
   ruthlessly scope.
2. **Validator output-method disambiguation**. Existing logic
   "p2tr ⇒ TapretFirst" no longer suffices. A subtle bug here means a
   forged proof of one method against a leaf produced by the other gets
   accepted. Tests must cover both wrong-method-against-right-output and
   right-method-against-wrong-output.
3. **Upstream coordination cost**. Filling in `bp-dbc::keytweak` is a
   defensible PR (the namespace is reserved, the doc describes our
   construction), but coordination with Orlovsky/LNP-BP for review and
   merge is a months-long calendar item independent of code time. Not a
   blocker for shipping closed-loop in production.

**What this verdict does NOT settle**:
- Whether to do this at all given the active trading-engagement priority.
- Whether to in-house the Rust work or contract it (the bp-dbc /
  rgb-consensus portion is small enough to learn-on-the-job; the rgb-lib
  portion is the gating skill question).
- Migration mechanics for PPSPARK v1 → v2 (handled separately when
  Phase 1 lands; the user's existing custodial-server architecture
  makes the on-chain part of this trivial — most balances are server-
  side allocations, not on-chain UTXOs).
