// Node-side initializer for the vendored wasm-pack output.
//
// The frontend's `sparkCore.ts` wrapper uses Vite to fetch the .wasm
// via the served URL. In Node we need to load it from disk. wasm-pack's
// generated init() accepts a Request | URL | string, so we pass a
// file:// URL to the .wasm and it fetches it (Node 18+ supports fetch
// against file:// schemes).
//
// We re-export everything from the frontend's `sparkCore` so the rest
// of the harness imports the same names whether running in browser or
// Node.

import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import init, * as sparkCore from '@rgb-spark/lib/spark-core/rgb_spark_core'

let ready: Promise<typeof sparkCore> | null = null

const WASM_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'frontend',
  'src',
  'lib',
  'spark-core',
  'rgb_spark_core_bg.wasm',
)

export async function ensureSparkCoreReady(): Promise<typeof sparkCore> {
  if (!ready) {
    ready = (async () => {
      // Read the .wasm bytes off disk and pass them to wasm-pack's
      // init. Avoids the implicit fetch() against import.meta.url
      // which doesn't resolve cleanly under tsx + node:test runners.
      const bytes = await readFile(WASM_PATH)
      await init({ module_or_path: bytes })
      return sparkCore
    })()
  }
  return ready
}

export type SparkCore = typeof sparkCore
