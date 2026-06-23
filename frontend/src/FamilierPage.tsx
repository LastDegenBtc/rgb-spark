// Standalone, single-purpose page: just the familier deposit→mint flow.
// The main dev-lab (App.tsx) accumulated a lot of unrelated probes (HTLC,
// orderbook, NIA transitions...) that are no longer useful day-to-day —
// this page exists so testing the familier flow doesn't require wading
// through all of that. Reuses FamilierDepositInline/IssueUdaInline/KV
// as-is from App.tsx rather than duplicating them.

import { useEffect, useRef, useState } from 'react'
import { generateSecretKey, nip19 } from 'nostr-tools'
import { parseLoginSecret } from './lib/nostrKey'
import { ensureSparkCoreReady, type SparkCore } from './lib/sparkCore'
import {
  loadFamiliers,
  addFamilier,
  downloadBackup,
  parseBackup,
  restoreFamiliers,
  type FamilierEntry,
} from './lib/familierStash'
import { FamilierDepositInline, IssueUdaInline, KV } from './App'

// Plain localStorage, no PIN vault — this is a disposable testnet dev
// tool, not the real wallet. The point is just to survive an accidental
// reload without losing the address you may have already sent a faucet
// deposit to (learned the hard way: testnet faucets rate-limit retries
// for hours).
const STORAGE_KEY = 'frognesis_familier_nsec'

export default function FamilierPage() {
  const [secret, setSecret] = useState('')
  const [seed, setSeed] = useState<Uint8Array | null>(null)
  const [nsec, setNsec] = useState('')
  const [npub, setNpub] = useState('')
  const [loginErr, setLoginErr] = useState<string | null>(null)
  const [core, setCore] = useState<SparkCore | null>(null)
  const [coreErr, setCoreErr] = useState<string | null>(null)
  const [familierUtxo, setFamilierUtxo] = useState<{ txid: string; vout: number } | null>(null)
  const [familiers, setFamiliers] = useState<FamilierEntry[]>([])
  const [importErr, setImportErr] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    ensureSparkCoreReady()
      .then((c) => setCore(c))
      .catch((e) => setCoreErr(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) boot(saved)
    // Only ever auto-boot once, on mount.
  }, [])

  function boot(input: string) {
    setLoginErr(null)
    try {
      const parsed = parseLoginSecret(input)
      setSeed(parsed.sparkSeed)
      setNsec(parsed.nsec)
      setNpub(parsed.npub)
      localStorage.setItem(STORAGE_KEY, parsed.nsec)
      setFamiliers(loadFamiliers())
    } catch (e) {
      setLoginErr(e instanceof Error ? e.message : String(e))
    }
  }

  function generateAndBoot() {
    const sk = generateSecretKey()
    const generatedNsec = nip19.nsecEncode(sk)
    setSecret(generatedNsec)
    boot(generatedNsec)
  }

  function forget() {
    localStorage.removeItem(STORAGE_KEY)
    setSeed(null)
    setNsec('')
    setNpub('')
    setSecret('')
    setFamilierUtxo(null)
    setFamiliers([])
  }

  function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    setImportErr(null)
    const file = e.target.files?.[0]
    if (!file) return
    file
      .text()
      .then((text) => {
        const backup = parseBackup(text)
        restoreFamiliers(backup.familiers)
        boot(backup.nsec)
      })
      .catch((err) => setImportErr(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        if (fileInputRef.current) fileInputRef.current.value = ''
      })
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
            <button onClick={() => fileInputRef.current?.click()}>Restore from backup file</button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              onChange={onImportFile}
              style={{ display: 'none' }}
            />
          </div>
          {loginErr && <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{loginErr}</pre>}
          {importErr && <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{importErr}</pre>}
        </>
      )}

      {seed && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p style={{ fontSize: 11, color: '#888', fontFamily: 'monospace', wordBreak: 'break-all', margin: 0 }}>npub: {npub}</p>
            <button onClick={forget} style={{ fontSize: 10 }}>forget / use different key</button>
          </div>

          <fieldset style={{ marginTop: 8, border: '1px solid #ddd', padding: '6px 10px' }}>
            <legend style={{ fontSize: 12, color: '#666' }}>backup — this is the only copy outside this browser</legend>
            <KV label="nsec (backup)" value={nsec} mono masked />
            <p style={{ fontSize: 11, color: '#a66', marginTop: 4 }}>
              The nsec re-derives your deposit address and lets you sign a future transfer — losing it loses control of the UTXO.
              The minted consignments below are NOT re-derivable from the nsec (re-minting gives a different contractId), so back up both.
            </p>
            <button onClick={() => downloadBackup(nsec)} style={{ fontSize: 11, marginTop: 4 }}>
              download backup (nsec + minted familiers)
            </button>
          </fieldset>

          {coreErr && <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{coreErr}</pre>}

          <FamilierDepositInline rootSeed={seed} disabled={false} onUtxoReady={setFamilierUtxo} />

          <IssueUdaInline
            core={core}
            disabled={false}
            utxo={familierUtxo}
            onIssuance={(contractId, consignmentHex, ticker, name, tokenIndex) => {
              if (!familierUtxo) return
              const entry: FamilierEntry = {
                contractId,
                consignmentHex,
                ticker,
                name,
                tokenIndex,
                utxo: familierUtxo,
                network: 'TESTNET',
                mintedAt: new Date().toISOString(),
              }
              setFamiliers(addFamilier(entry))
            }}
          />

          {familiers.length > 0 && (
            <fieldset style={{ marginTop: 12, border: '1px solid #ddd', padding: '6px 10px' }}>
              <legend style={{ fontSize: 12, color: '#666' }}>minted familiers (this browser, backed up above)</legend>
              {familiers.map((f) => (
                <div
                  key={f.contractId}
                  style={{ marginTop: 6, padding: 6, background: '#e8f5e9', border: '1px solid #a5d6a7', fontSize: 12 }}
                >
                  <strong>{f.ticker} — {f.name}</strong>
                  <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', marginTop: 4 }}>
                    contractId: {f.contractId}
                  </div>
                  <div>consignment: {f.consignmentHex.length / 2} bytes · minted {f.mintedAt}</div>
                </div>
              ))}
            </fieldset>
          )}
        </>
      )}
    </section>
  )
}
