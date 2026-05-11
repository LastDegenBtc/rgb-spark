import { useState } from 'react'
import { generateSecretKey, nip19 } from 'nostr-tools'
import { parseLoginSecret, type ParsedLogin } from './lib/nostrKey'
import {
  initSparkWallet,
  getBalance,
  disposeSparkWallet,
  type WalletInitResult,
} from './lib/sparkWallet'
import './App.css'

type Network = 'MAINNET' | 'REGTEST' | 'TESTNET'
type BootState =
  | { kind: 'idle' }
  | { kind: 'loading'; stage: string }
  | { kind: 'ready'; parsed: ParsedLogin; wallet: WalletInitResult; balanceSats: bigint | 'pending' | 'error' }
  | { kind: 'error'; message: string }

function App() {
  const [secret, setSecret] = useState('')
  const [network, setNetwork] = useState<Network>('REGTEST')
  const [state, setState] = useState<BootState>({ kind: 'idle' })

  async function bootFromInput(input: string) {
    setState({ kind: 'loading', stage: 'parsing secret' })
    try {
      const parsed = parseLoginSecret(input)
      setState({ kind: 'loading', stage: `initializing Spark wallet on ${network}` })
      const wallet = await initSparkWallet(parsed.sparkSeed, network)
      setState({ kind: 'ready', parsed, wallet, balanceSats: 'pending' })
      try {
        const sats = await getBalance()
        setState((prev) => prev.kind === 'ready' ? { ...prev, balanceSats: sats } : prev)
      } catch {
        setState((prev) => prev.kind === 'ready' ? { ...prev, balanceSats: 'error' } : prev)
      }
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  function generateAndBoot() {
    const sk = generateSecretKey()
    const nsec = nip19.nsecEncode(sk)
    setSecret(nsec)
    void bootFromInput(nsec)
  }

  async function reset() {
    await disposeSparkWallet()
    setSecret('')
    setState({ kind: 'idle' })
  }

  const busy = state.kind === 'loading'

  return (
    <section id="center" style={{ maxWidth: 760, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>rgb-spark · wallet boot</h1>
      <p style={{ color: '#666', marginTop: -8 }}>
        Phase 1B / step 5 — Nostr seed → Spark wallet. No persistence: reload regenerates.
      </p>

      {state.kind !== 'ready' && (
        <>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 4, marginTop: 16 }}>
            Mnemonic (12/24 words), nsec1…, or 64 hex
          </label>
          <textarea
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="paste an nsec / mnemonic, or click ‘Generate fresh’"
            rows={3}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: 8, boxSizing: 'border-box' }}
            disabled={busy}
          />

          <fieldset style={{ marginTop: 12, border: '1px solid #ddd', padding: '6px 10px' }}>
            <legend style={{ fontSize: 12, color: '#666' }}>network</legend>
            {(['REGTEST', 'TESTNET', 'MAINNET'] as Network[]).map((n) => (
              <label key={n} style={{ marginRight: 12, fontSize: 13 }}>
                <input
                  type="radio"
                  name="net"
                  value={n}
                  checked={network === n}
                  onChange={() => setNetwork(n)}
                  disabled={busy}
                />{' '}
                {n}
              </label>
            ))}
          </fieldset>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={() => void bootFromInput(secret)} disabled={busy || !secret.trim()}>
              {busy ? '…' : 'Load wallet'}
            </button>
            <button onClick={generateAndBoot} disabled={busy}>Generate fresh</button>
          </div>

          {state.kind === 'loading' && (
            <p style={{ color: '#888', marginTop: 12 }}>{state.stage}…</p>
          )}
          {state.kind === 'error' && (
            <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', marginTop: 12 }}>{state.message}</pre>
          )}
        </>
      )}

      {state.kind === 'ready' && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>booted · {state.wallet.network}</h2>
            <button onClick={() => void reset()}>Reset</button>
          </div>
          <KV label="login kind"        value={state.parsed.kind} />
          <KV label="npub"              value={state.parsed.npub} mono />
          <KV label="nsec (backup)"     value={state.parsed.nsec} mono masked />
          <KV label="identityPubkey"    value={state.wallet.identityPubkey} mono />
          <KV label="sparkAddress"      value={state.wallet.sparkAddress} mono />
          <KV label="depositAddress (L1)" value={state.wallet.depositAddress} mono />
          <KV
            label="balance (sats)"
            value={
              state.balanceSats === 'pending' ? 'loading…' :
              state.balanceSats === 'error'   ? 'failed to fetch' :
              state.balanceSats.toString()
            }
          />
        </div>
      )}
    </section>
  )
}

function KV({ label, value, mono, masked }: { label: string; value: string; mono?: boolean; masked?: boolean }) {
  const [revealed, setRevealed] = useState(false)
  const display = masked && !revealed ? '•'.repeat(Math.min(value.length, 40)) : value
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, padding: '6px 0', borderTop: '1px solid #eee' }}>
      <div style={{ color: '#666', fontSize: 13 }}>{label}</div>
      <div style={{ fontFamily: mono ? 'monospace' : 'inherit', fontSize: mono ? 12 : 14, wordBreak: 'break-all' }}>
        {display}
        {masked && (
          <button
            onClick={() => setRevealed((r) => !r)}
            style={{ marginLeft: 8, fontSize: 11, padding: '1px 6px' }}
          >
            {revealed ? 'hide' : 'reveal'}
          </button>
        )}
      </div>
    </div>
  )
}

export default App
