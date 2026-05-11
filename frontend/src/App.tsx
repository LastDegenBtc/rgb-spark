import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { generateSecretKey, nip19 } from 'nostr-tools'
import { parseLoginSecret, type ParsedLogin } from './lib/nostrKey'
import {
  initSparkWallet,
  getBalance,
  disposeSparkWallet,
  type WalletInitResult,
} from './lib/sparkWallet'
import { ensureSparkCoreReady, type SparkCore } from './lib/sparkCore'
import {
  postConsignment,
  listConsignments,
  fetchConsignment,
  ackConsignment,
  checkRelayHealth,
  type ConsignmentMeta,
  type RelayHealth,
} from './lib/consignmentRelay'
import './App.css'

type Network = 'MAINNET' | 'REGTEST' | 'TESTNET'
type BootState =
  | { kind: 'idle' }
  | { kind: 'loading'; stage: string }
  | { kind: 'ready'; parsed: ParsedLogin; wallet: WalletInitResult; balanceSats: bigint | 'pending' | 'error' }
  | { kind: 'error'; message: string }

// Operator pubkey is still a placeholder pinned to vector v1. The real
// Spark SE operator (aggregated FROST key) is fetched from a Spark transfer
// event — that's step 9c. For now, only u_base reflects real identity.
const DEMO_OPERATOR = '02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27'

const COMPRESSED_PUBKEY_HEX_RE = /^0[23][0-9a-f]{64}$/i

interface ConsignmentEnvelope {
  v: 2
  sender: string                    // sender's npub (informational; relay doesn't verify)
  senderIdentityPubkey?: string     // claimed Spark identityPubkey (33-byte compressed hex)
  createdAt: string
  kind: 'spark-utk-proof'
  proofHex: string                  // SparkUtkProofJs.encode()
}

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
    <section id="center" style={{ maxWidth: 880, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>rgb-spark · wallet boot</h1>
      <p style={{ color: '#666', marginTop: -8 }}>
        Phase 1B / step 5+6 — Nostr seed → Spark wallet → SparkUtkProofJs round-trip via relay.
        No persistence: reload regenerates.
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
          <KV label="login kind"          value={state.parsed.kind} />
          <KV label="npub"                value={state.parsed.npub} mono />
          <KV label="nsec (backup)"       value={state.parsed.nsec} mono masked />
          <KV label="identityPubkey"      value={state.wallet.identityPubkey} mono />
          <KV label="sparkAddress"        value={state.wallet.sparkAddress} mono />
          <KV label="depositAddress (L1)" value={state.wallet.depositAddress} mono />
          <KV
            label="balance (sats)"
            value={
              state.balanceSats === 'pending' ? 'loading…' :
              state.balanceSats === 'error'   ? 'failed to fetch' :
              state.balanceSats.toString()
            }
          />

          <ConsignmentLab
            myNpub={state.parsed.npub}
            myIdentityPubkey={state.wallet.identityPubkey}
          />
        </div>
      )}
    </section>
  )
}

// ---- Consignment Lab --------------------------------------------------------

interface SentRecord {
  to: string
  meta: ConsignmentMeta
  envelope: ConsignmentEnvelope
}

interface DecodedConsignment {
  raw: string                  // hex of the raw bytes received
  envelope?: ConsignmentEnvelope
  proofUBase?: string
  proofOperator?: string
  parseError?: string
}

function ConsignmentLab({ myNpub, myIdentityPubkey }: { myNpub: string; myIdentityPubkey: string }) {
  const [core, setCore] = useState<SparkCore | null>(null)
  const [coreErr, setCoreErr] = useState<string | null>(null)
  const [health, setHealth] = useState<RelayHealth | null>(null)
  const [healthErr, setHealthErr] = useState<string | null>(null)

  const [target, setTarget] = useState('')
  const [sending, setSending] = useState(false)
  const [sentLog, setSentLog] = useState<SentRecord[]>([])
  const [sendErr, setSendErr] = useState<string | null>(null)

  const [inbox, setInbox] = useState<ConsignmentMeta[]>([])
  const [inboxErr, setInboxErr] = useState<string | null>(null)
  const [decoded, setDecoded] = useState<Record<string, DecodedConsignment>>({})

  useEffect(() => {
    ensureSparkCoreReady()
      .then((c) => setCore(c))
      .catch((e) => setCoreErr(e instanceof Error ? e.message : String(e)))
    checkRelayHealth()
      .then((h) => setHealth(h))
      .catch((e) => setHealthErr(e instanceof Error ? e.message : String(e)))
  }, [])

  const refreshInbox = useCallback(async () => {
    try {
      const list = await listConsignments(myNpub)
      setInbox(list)
      setInboxErr(null)
    } catch (e) {
      setInboxErr(e instanceof Error ? e.message : String(e))
    }
  }, [myNpub])

  useEffect(() => {
    void refreshInbox()
    const t = setInterval(() => { void refreshInbox() }, 5000)
    return () => clearInterval(t)
  }, [refreshInbox])

  async function buildAndSend() {
    if (!core) return
    setSendErr(null)
    setSending(true)
    try {
      const t = target.trim()
      if (!t) throw new Error('target npub is empty')
      // 9a: u_base = the sender's Spark identityPubkey. Operator is still
      // a placeholder pending 9c (real Spark transfer → real leaf data).
      const uBase = myIdentityPubkey.toLowerCase()
      if (!COMPRESSED_PUBKEY_HEX_RE.test(uBase)) {
        throw new Error(
          `wallet.identityPubkey is not a 33-byte compressed pubkey ` +
          `(got ${uBase.length / 2} bytes, starts with ${uBase.slice(0, 2)}). ` +
          `SparkUtkProofJs needs 02/03-prefixed 66-hex.`,
        )
      }
      const proof = new core.SparkUtkProofJs(uBase, DEMO_OPERATOR)
      const proofHex = proof.encode()
      proof.free()
      const envelope: ConsignmentEnvelope = {
        v: 2,
        sender: myNpub,
        senderIdentityPubkey: uBase,
        createdAt: new Date().toISOString(),
        kind: 'spark-utk-proof',
        proofHex,
      }
      const bytes = new TextEncoder().encode(JSON.stringify(envelope))
      const meta = await postConsignment(t, bytes)
      setSentLog((log) => [{ to: t, meta, envelope }, ...log].slice(0, 10))
      // If sender is also recipient (testing in one tab), refresh inbox now.
      if (t === myNpub) void refreshInbox()
    } catch (e) {
      setSendErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  async function decodeRow(id: string) {
    if (!core) return
    try {
      const bytes = await fetchConsignment(myNpub, id)
      const rawHex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
      let entry: DecodedConsignment = { raw: rawHex }
      try {
        const text = new TextDecoder().decode(bytes)
        const env = JSON.parse(text) as ConsignmentEnvelope
        const proof = core.SparkUtkProofJs.decode(env.proofHex)
        entry = {
          raw: rawHex,
          envelope: env,
          proofUBase: proof.uBase,
          proofOperator: proof.operator,
        }
        proof.free()
      } catch (e) {
        entry.parseError = e instanceof Error ? e.message : String(e)
      }
      setDecoded((d) => ({ ...d, [id]: entry }))
    } catch (e) {
      setDecoded((d) => ({ ...d, [id]: { raw: '', parseError: e instanceof Error ? e.message : String(e) } }))
    }
  }

  async function ackRow(id: string) {
    try {
      await ackConsignment(myNpub, id)
      setDecoded((d) => {
        const next = { ...d }
        delete next[id]
        return next
      })
      void refreshInbox()
    } catch (e) {
      setInboxErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div style={{ marginTop: 28, borderTop: '2px solid #333', paddingTop: 16 }}>
      <h2 style={{ margin: '0 0 6px 0' }}>Consignment Lab</h2>
      <p style={{ color: '#666', fontSize: 13, marginTop: 0 }}>
        Two-tab demo: build a <code>SparkUtkProofJs</code> where{' '}
        <code>u_base</code> = your Spark <code>identityPubkey</code>, wrap it
        in a JSON envelope (npub + claimed identityPubkey + timestamp), POST
        to relay, retrieve in another tab, <code>decode()</code>, check that
        the proof is bound to the claimed identity.
      </p>
      <p style={{ color: '#999', fontSize: 11, marginTop: -4 }}>
        Caveat: the envelope is <em>not signed</em>. Anyone can claim any
        identityPubkey. Real binding requires the sender to sign with their
        nsec (step 9d). For now, treat the badge as "self-consistent" not
        "cryptographically proven". Operator stays pinned to vector v1 — real
        operator key comes from a Spark transfer event (step 9c).
      </p>

      <div style={{ fontSize: 12, color: '#888' }}>
        relay health:{' '}
        {healthErr
          ? <span style={{ color: 'crimson' }}>{healthErr}</span>
          : health
            ? `ok · ${health.npubs} npubs · ${health.pending} pending blobs`
            : 'checking…'}
        {' · '}
        wasm:{' '}
        {coreErr
          ? <span style={{ color: 'crimson' }}>{coreErr}</span>
          : core ? 'ready' : 'loading…'}
      </div>

      <fieldset style={{ marginTop: 12, border: '1px solid #ddd', padding: '8px 12px' }}>
        <legend style={{ fontSize: 12, color: '#666' }}>compose</legend>
        <label style={{ display: 'block', fontSize: 12, color: '#666' }}>
          target npub (paste from another tab, or your own to self-test)
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <input
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="npub1…"
            style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, padding: 6 }}
          />
          <button onClick={() => setTarget(myNpub)} type="button" style={{ fontSize: 11 }}>
            use mine
          </button>
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => void buildAndSend()} disabled={!core || sending || !target.trim()}>
            {sending ? 'sending…' : 'Build SparkUtkProofJs and send →'}
          </button>
          {sendErr && <span style={{ color: 'crimson', fontSize: 12 }}>{sendErr}</span>}
        </div>

        {sentLog.length > 0 && (
          <details style={{ marginTop: 10 }} open>
            <summary style={{ fontSize: 12, color: '#666', cursor: 'pointer' }}>
              sent log ({sentLog.length})
            </summary>
            <div style={{ fontFamily: 'monospace', fontSize: 11, marginTop: 6 }}>
              {sentLog.map((s, i) => (
                <div key={`${s.meta.id}-${i}`} style={{ padding: '4px 0', borderTop: i === 0 ? 'none' : '1px dashed #eee' }}>
                  → <strong>{s.to.slice(0, 14)}…</strong>{' '}
                  id <code>{s.meta.id.slice(0, 8)}</code> · {s.meta.size} B · {s.meta.receivedAt}<br/>
                  proofHex: <code style={{ wordBreak: 'break-all' }}>{s.envelope.proofHex}</code>
                </div>
              ))}
            </div>
          </details>
        )}
      </fieldset>

      <fieldset style={{ marginTop: 12, border: '1px solid #ddd', padding: '8px 12px' }}>
        <legend style={{ fontSize: 12, color: '#666' }}>
          inbox · poll 5s · {myNpub.slice(0, 14)}…
        </legend>
        {inboxErr && <pre style={{ color: 'crimson', fontSize: 12 }}>{inboxErr}</pre>}
        {!inboxErr && inbox.length === 0 && (
          <p style={{ color: '#888', fontSize: 12, margin: '6px 0' }}>empty</p>
        )}
        {inbox.map((m) => (
          <div key={m.id} style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, fontFamily: 'monospace' }}>
              <span>
                id <code>{m.id.slice(0, 8)}</code> · {m.size} B · {m.receivedAt}
              </span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => void decodeRow(m.id)} disabled={!core} style={{ fontSize: 11 }}>
                  decode
                </button>
                <button onClick={() => void ackRow(m.id)} style={{ fontSize: 11 }}>
                  ack
                </button>
              </span>
            </div>
            {decoded[m.id] && <DecodedView entry={decoded[m.id]!} />}
          </div>
        ))}
      </fieldset>
    </div>
  )
}

function DecodedView({ entry }: { entry: DecodedConsignment }) {
  const claimed = entry.envelope?.senderIdentityPubkey?.toLowerCase()
  const got = entry.proofUBase?.toLowerCase()
  let bindingBadge: ReactNode = null
  if (entry.envelope && got) {
    if (!claimed) {
      bindingBadge = <span style={{ color: '#888' }}>envelope has no senderIdentityPubkey (legacy v1)</span>
    } else if (claimed === got) {
      bindingBadge = <span style={{ color: 'seagreen' }}>OK · proof.u_base matches claimed Spark identity</span>
    } else {
      bindingBadge = <span style={{ color: '#c80' }}>MISMATCH · proof.u_base ≠ envelope.senderIdentityPubkey</span>
    }
  }
  return (
    <div style={{ marginTop: 6, paddingLeft: 12, borderLeft: '3px solid #6c6', fontSize: 12, fontFamily: 'monospace' }}>
      {entry.parseError && <div style={{ color: 'crimson' }}>parse error: {entry.parseError}</div>}
      {entry.envelope && (
        <>
          <div><span style={{ color: '#666' }}>sender (npub):</span> {entry.envelope.sender}</div>
          {entry.envelope.senderIdentityPubkey && (
            <div><span style={{ color: '#666' }}>senderIdentityPubkey:</span> {entry.envelope.senderIdentityPubkey}</div>
          )}
          <div><span style={{ color: '#666' }}>createdAt:</span> {entry.envelope.createdAt}</div>
          <div><span style={{ color: '#666' }}>kind:</span> {entry.envelope.kind}</div>
          <div><span style={{ color: '#666' }}>proof.uBase:</span> {entry.proofUBase}</div>
          <div><span style={{ color: '#666' }}>proof.operator:</span> {entry.proofOperator}</div>
          <div style={{ marginTop: 4 }}>
            <span style={{ color: '#666' }}>identity binding:</span> {bindingBadge}
          </div>
        </>
      )}
      <details style={{ marginTop: 4 }}>
        <summary style={{ color: '#666', cursor: 'pointer' }}>raw hex ({entry.raw.length / 2} B)</summary>
        <div style={{ wordBreak: 'break-all' }}>{entry.raw}</div>
      </details>
    </div>
  )
}

// ---- Small KV row -----------------------------------------------------------

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
