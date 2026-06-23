// Standalone, single-purpose page: just the familier deposit→mint flow.
// The main dev-lab (App.tsx) accumulated a lot of unrelated probes (HTLC,
// orderbook, NIA transitions...) that are no longer useful day-to-day —
// this page exists so testing the familier flow doesn't require wading
// through all of that. Reuses FamilierDepositInline/IssueUdaInline as-is
// from App.tsx rather than duplicating them.

import { useEffect, useState } from 'react'
import { generateSecretKey, nip19 } from 'nostr-tools'
import { parseLoginSecret } from './lib/nostrKey'
import { ensureSparkCoreReady, type SparkCore } from './lib/sparkCore'
import { FamilierDepositInline, IssueUdaInline } from './App'

// Plain localStorage, no PIN vault — this is a disposable testnet dev
// tool, not the real wallet. The point is just to survive an accidental
// reload without losing the address you may have already sent a faucet
// deposit to (learned the hard way: testnet faucets rate-limit retries
// for hours).
const STORAGE_KEY = 'frognesis_familier_nsec'

export default function FamilierPage() {
  const [secret, setSecret] = useState('')
  const [seed, setSeed] = useState<Uint8Array | null>(null)
  const [npub, setNpub] = useState('')
  const [loginErr, setLoginErr] = useState<string | null>(null)
  const [core, setCore] = useState<SparkCore | null>(null)
  const [coreErr, setCoreErr] = useState<string | null>(null)
  const [familierUtxo, setFamilierUtxo] = useState<{ txid: string; vout: number } | null>(null)
  const [minted, setMinted] = useState<{ contractId: string; consignmentHex: string } | null>(null)

  useEffect(() => {
    ensureSparkCoreReady()
      .then((c) => setCore(c))
      .catch((e) => setCoreErr(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) boot(saved)
    // Only ever auto-boot once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function boot(input: string) {
    setLoginErr(null)
    try {
      const parsed = parseLoginSecret(input)
      setSeed(parsed.sparkSeed)
      setNpub(parsed.npub)
      localStorage.setItem(STORAGE_KEY, parsed.nsec)
    } catch (e) {
      setLoginErr(e instanceof Error ? e.message : String(e))
    }
  }

  function generateAndBoot() {
    const sk = generateSecretKey()
    const nsec = nip19.nsecEncode(sk)
    setSecret(nsec)
    boot(nsec)
  }

  function forget() {
    localStorage.removeItem(STORAGE_KEY)
    setSeed(null)
    setNpub('')
    setSecret('')
    setFamilierUtxo(null)
    setMinted(null)
  }

  return (
    <section style={{ maxWidth: 640, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 20 }}>FROGNESIS — mint familier (test)</h1>
      <p style={{ color: '#666', fontSize: 13 }}>
        Just the deposit → UDA mint flow, nothing else. No Spark wallet/leaves needed for this part — only an L1 UTXO and the rgb-spark-core wasm.
      </p>

      {!seed && (
        <>
          <textarea
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="paste an nsec / mnemonic, or click Generate fresh"
            rows={3}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: 8, boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={() => boot(secret)} disabled={!secret.trim()}>Load</button>
            <button onClick={generateAndBoot}>Generate fresh</button>
          </div>
          {loginErr && <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{loginErr}</pre>}
        </>
      )}

      {seed && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p style={{ fontSize: 11, color: '#888', fontFamily: 'monospace', wordBreak: 'break-all', margin: 0 }}>npub: {npub}</p>
            <button onClick={forget} style={{ fontSize: 10 }}>forget / use different key</button>
          </div>
          <p style={{ fontSize: 11, color: '#a66', marginTop: 4 }}>
            Saved in this browser's localStorage so a reload doesn't lose it — but it's still only in this browser. Don't rely on it for anything real.
          </p>
          {coreErr && <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{coreErr}</pre>}

          <FamilierDepositInline rootSeed={seed} disabled={false} onUtxoReady={setFamilierUtxo} />

          <IssueUdaInline
            core={core}
            disabled={false}
            utxo={familierUtxo}
            onIssuance={(contractId, consignmentHex) => setMinted({ contractId, consignmentHex })}
          />

          {minted && (
            <div style={{ marginTop: 12, padding: 8, background: '#e8f5e9', border: '1px solid #a5d6a7', fontSize: 12 }}>
              <strong>Minted.</strong>
              <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', marginTop: 4 }}>
                contractId: {minted.contractId}
              </div>
              <div>consignment: {minted.consignmentHex.length / 2} bytes</div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
