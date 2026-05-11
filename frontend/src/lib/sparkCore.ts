// Single-init wrapper around the vendored wasm-pack output. Both the
// wallet-boot smoke check and the Consignment Lab share the same WASM
// instance — re-initializing it would re-fetch the 1.3 MiB blob and
// reset secp256k1 context state.

import init, * as sparkCore from './spark-core/rgb_spark_core'

let ready: Promise<typeof sparkCore> | null = null

export function ensureSparkCoreReady(): Promise<typeof sparkCore> {
  if (!ready) ready = init().then(() => sparkCore)
  return ready
}

export type SparkCore = typeof sparkCore
