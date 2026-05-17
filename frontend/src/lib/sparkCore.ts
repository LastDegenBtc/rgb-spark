// Single-init wrapper around the vendored wasm-pack output. Both the
// wallet-boot smoke check and the Consignment Lab share the same WASM
// instance — re-initializing it would re-fetch the 1.3 MiB blob and
// reset secp256k1 context state.

import init, * as sparkCore from './spark-core/rgb_spark_core'

let ready: Promise<typeof sparkCore> | null = null
let initialized = false

export function ensureSparkCoreReady(): Promise<typeof sparkCore> {
  if (!ready) {
    ready = init().then(() => {
      initialized = true
      return sparkCore
    })
  }
  return ready
}

/** Synchronous accessor for code paths (render loops, sync iterators)
 *  that can't await. Returns the module namespace iff init() has already
 *  resolved at least once; null otherwise. The wallet boot flow awaits
 *  `ensureSparkCoreReady` before mounting the UI, so by the time any
 *  user-facing component renders this is non-null. */
export function sparkCoreIfReady(): typeof sparkCore | null {
  return initialized ? sparkCore : null
}

export type SparkCore = typeof sparkCore
