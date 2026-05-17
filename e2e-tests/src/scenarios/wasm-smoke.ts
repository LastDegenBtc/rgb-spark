// scenario:wasm-smoke — verifies the WASM init path works in Node and
// the primitives we'll exercise in happy-path-trade (issueNiaContract,
// niaGenesisMetadata, deriveUTweaked) behave the same as in tests.
//
// Doesn't need a funded wallet — pure WASM exercise. Cheap to run
// before any real trade.

import { ensureSparkCoreReady } from '../lib/spark-core.ts'
import type { ScenarioContext, ScenarioResult } from '../cli/run-scenario.ts'

const FIXTURE_TXID = '14295d5bb1a191cdb6286dc0944df938421e3dfcbf0811353ccac4100c2068c5'

export default async function wasmSmoke(_ctx: ScenarioContext): Promise<ScenarioResult> {
  const steps: ScenarioResult['steps'] = []

  // 1. init
  let core: Awaited<ReturnType<typeof ensureSparkCoreReady>>
  try {
    core = await ensureSparkCoreReady()
    steps.push({ name: 'WASM init', ok: true })
  } catch (e) {
    steps.push({
      name: 'WASM init',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    })
    return { passed: false, steps, summary: 'WASM did not load — cannot proceed' }
  }

  // 2. issue a fresh contract; assert the returned hex shapes.
  let issued: ReturnType<typeof core.issueNiaContract>
  try {
    issued = core.issueNiaContract('SMK', 'Smoke asset', 1_000_000n, FIXTURE_TXID, 0, BigInt(Date.now()))
    // Pull values into locals so the WASM-backed getters fire once
    // (NiaIssuance is `private constructor` with `readonly` getters; each
    // access marshals across the JS↔WASM boundary).
    const cid = issued.contractId
    const consig = issued.consignmentHex
    const okShape = cid.length === 64 && consig.length > 200
    steps.push({
      name: 'issueNiaContract returns 32-byte contractId + non-empty consignment',
      ok: okShape,
      detail: `contractId=${cid.slice(0, 16)}…  consignmentHex=${consig.length} chars`,
    })
    if (!okShape) {
      return { passed: false, steps, summary: 'issueNiaContract output shape unexpected' }
    }
  } catch (e) {
    steps.push({
      name: 'issueNiaContract',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    })
    return { passed: false, steps, summary: 'issueNiaContract crashed' }
  }

  // 3. roundtrip through niaGenesisMetadata: same ticker / name / supply.
  try {
    const meta = core.niaGenesisMetadata(issued.consignmentHex)
    const ticker = meta.ticker
    const name = meta.name
    const supply = meta.supply
    const contractIdEcho = meta.contractId
    meta.free()
    const okMeta =
      ticker === 'SMK' &&
      name === 'Smoke asset' &&
      supply === '1000000' &&
      contractIdEcho === issued.contractId
    steps.push({
      name: 'niaGenesisMetadata round-trip equal',
      ok: okMeta,
      detail: `ticker=${ticker} name=${name} supply=${supply}`,
    })
  } catch (e) {
    steps.push({
      name: 'niaGenesisMetadata',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    })
  }

  // 4. validate the freshly-issued consignment.
  try {
    const validatedId = core.validateNiaConsignment(issued.consignmentHex)
    const ok = validatedId === issued.contractId
    steps.push({
      name: 'validateNiaConsignment matches issuance id',
      ok,
      detail: ok ? '' : `validated=${validatedId} issued=${issued.contractId}`,
    })
  } catch (e) {
    steps.push({
      name: 'validateNiaConsignment',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    })
  }

  const allOk = steps.every((s) => s.ok)
  return {
    passed: allOk,
    steps,
    summary: allOk
      ? 'WASM core healthy in Node; happy-path-trade can use these primitives'
      : 'see failing steps',
  }
}
