// Node-side localStorage polyfill. The rgb-spark/frontend libs
// (`pathTweakStorage`, `rgbStash`, `orderPreimageStash`,
// `claimedLeafStore`, `secretVault`) call into the browser
// `localStorage` API. We map them onto an in-memory Map so each test
// scenario can reset state without touching disk.
//
// Per-wallet isolation: when running multiple SparkWallet instances in
// the same Node process, the npub-scoped stores will all write to the
// SAME Map. The scenarios call `installStorage()` to swap in a fresh
// backing Map before attaching a new wallet's stores, so each
// wallet/scenario gets a clean slate.

type StorageBackend = { data: Map<string, string> }

function makeStorage(backend: StorageBackend): Storage {
  return {
    get length() {
      return backend.data.size
    },
    clear(): void {
      backend.data.clear()
    },
    getItem(key: string): string | null {
      return backend.data.get(key) ?? null
    },
    key(index: number): string | null {
      return [...backend.data.keys()][index] ?? null
    },
    removeItem(key: string): void {
      backend.data.delete(key)
    },
    setItem(key: string, value: string): void {
      backend.data.set(key, value)
    },
  }
}

let current: StorageBackend = { data: new Map() }

/** Replace the active backing Map. Returns the previous backend so a
 *  caller can save/restore state across scenarios if needed. */
export function installStorage(): StorageBackend {
  const prev = current
  current = { data: new Map() }
  return prev
}

/** Install a single shared localStorage on globalThis. Call once at
 *  process boot before importing any rgb-spark lib module. */
export function attachGlobalLocalStorage(): void {
  if (typeof globalThis.localStorage !== 'undefined') return
  Object.defineProperty(globalThis, 'localStorage', {
    value: makeStorage({
      get data() {
        return current.data
      },
    }),
    writable: false,
    configurable: false,
  })
}

/** Node + JSON.stringify don't know how to serialize a BigInt — the
 *  Spark SDK's gRPC event-stream payloads include them (transfer
 *  amounts, balances, timestamps). Without this monkey-patch the SDK's
 *  internal event handler throws "Do not know how to serialize a
 *  BigInt" on EVERY event, silently dropping every claim signal —
 *  which is precisely why mainnet HTLC swaps timeout at the claim
 *  step inside this harness. The browser side doesn't hit this
 *  because the SDK uses a different serializer there.
 *
 *  Call once at process boot, before importing any SDK module. */
export function patchBigIntToJson(): void {
  if (typeof (BigInt.prototype as unknown as { toJSON?: unknown }).toJSON === 'function') {
    return
  }
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function () {
      return this.toString()
    },
    writable: true,
    configurable: true,
  })
}
