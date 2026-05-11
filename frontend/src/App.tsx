import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { generateSecretKey, nip19 } from 'nostr-tools'
import { addPublicKeys } from '@buildonspark/spark-sdk'
import { parseLoginSecret, type ParsedLogin } from './lib/nostrKey'
import {
  initSparkWallet,
  getBalance,
  disposeSparkWallet,
  listSparkLeaves,
  type WalletInitResult,
  type SparkLeafRow,
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

// "Demo" operator pubkey — pinned to scoping vector v1. Used only by the
// legacy demo mode (v2 envelope, identityPubkey as u_base). Real Spark
// transfers surface the aggregated FROST operator via TreeNode (step 9c).
const DEMO_OPERATOR = '02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27'

const COMPRESSED_PUBKEY_HEX_RE = /^0[23][0-9a-f]{64}$/i

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}
function bytesToHex(u: Uint8Array): string {
  let out = ''
  for (let i = 0; i < u.length; i++) out += u[i].toString(16).padStart(2, '0')
  return out
}

interface LeafReference {
  id: string
  treeId: string
  value: number
  network: string
  // Per-leaf 33-byte compressed verifying key. Receiver re-derives this from
  // (proof.uBase, ZERO_MSG, proof.operator) and compares — match means the
  // proof is mathematically bound to a real leaf the SE knows about.
  verifyingPublicKey: string
}

type ConsignmentEnvelope =
  | {
      v: 2
      sender: string
      senderIdentityPubkey?: string
      createdAt: string
      kind: 'spark-utk-proof'
      proofHex: string
    }
  | {
      v: 3
      sender: string
      senderIdentityPubkey?: string
      createdAt: string
      kind: 'spark-utk-proof'
      proofHex: string
      leafReference: LeafReference
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

type LeafVerification =
  | { kind: 'none' }                                       // v2 envelope, no leaf to verify against
  | { kind: 'ok'; derivedVerifyingKey: string }            // match
  | { kind: 'mismatch'; expected: string; got: string }    // derived ≠ leaf.verifyingPublicKey
  | { kind: 'error'; message: string }                     // derive call threw

interface DecodedConsignment {
  raw: string                  // hex of the raw bytes received
  envelope?: ConsignmentEnvelope
  proofUBase?: string
  proofOperator?: string
  leafVerification?: LeafVerification
  parseError?: string
}

type LabMode = 'demo' | 'leaf'

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

  // ----- leaves (chunk-α: real-Spark-leaf-backed proofs) -----
  const [mode, setMode] = useState<LabMode>('demo')
  const [leaves, setLeaves] = useState<SparkLeafRow[]>([])
  const [leavesErr, setLeavesErr] = useState<string | null>(null)
  const [leavesLoading, setLeavesLoading] = useState(false)
  const [selectedLeafId, setSelectedLeafId] = useState<string>('')

  const refreshLeaves = useCallback(async () => {
    setLeavesLoading(true)
    setLeavesErr(null)
    try {
      const list = await listSparkLeaves()
      setLeaves(list)
      // Clear selection if it now points at a leaf that's gone.
      setSelectedLeafId((prev) => (prev && list.some((l) => l.id === prev) ? prev : (list[0]?.id ?? '')))
    } catch (e) {
      setLeavesErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLeavesLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshLeaves()
  }, [refreshLeaves])

  const selectedLeaf = leaves.find((l) => l.id === selectedLeafId) ?? null

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

      let envelope: ConsignmentEnvelope
      if (mode === 'leaf') {
        if (!selectedLeaf) throw new Error('no leaf selected — fund the wallet or switch to demo mode')
        const uBase = selectedLeaf.ownerSigningPublicKey.toLowerCase()
        const operator = selectedLeaf.operatorPublicKey.toLowerCase()
        if (!COMPRESSED_PUBKEY_HEX_RE.test(uBase)) {
          throw new Error(`leaf.ownerSigningPublicKey is not a 33-byte compressed pubkey: ${uBase}`)
        }
        if (!COMPRESSED_PUBKEY_HEX_RE.test(operator)) {
          throw new Error(`leaf.operatorPublicKey is not a 33-byte compressed pubkey: ${operator}`)
        }
        const proof = new core.SparkUtkProofJs(uBase, operator)
        const proofHex = proof.encode()
        proof.free()
        envelope = {
          v: 3,
          sender: myNpub,
          senderIdentityPubkey: myIdentityPubkey.toLowerCase(),
          createdAt: new Date().toISOString(),
          kind: 'spark-utk-proof',
          proofHex,
          leafReference: {
            id: selectedLeaf.id,
            treeId: selectedLeaf.treeId,
            value: selectedLeaf.value,
            network: selectedLeaf.network,
            verifyingPublicKey: selectedLeaf.verifyingPublicKey.toLowerCase(),
          },
        }
      } else {
        // demo mode: u_base = identityPubkey (wallet-wide), operator = pinned vector v1
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
        envelope = {
          v: 2,
          sender: myNpub,
          senderIdentityPubkey: uBase,
          createdAt: new Date().toISOString(),
          kind: 'spark-utk-proof',
          proofHex,
        }
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
        const proofUBase = proof.uBase
        const proofOperator = proof.operator
        proof.free()
        let leafVerification: LeafVerification = { kind: 'none' }
        if (env.v === 3 && env.leafReference) {
          try {
            // Spark vanilla leaf invariant (matches SDK's own SparkWallet.verifyKey):
            //   verifyingPublicKey === ownerSigningPublicKey + signingKeyshare.publicKey
            // Pure secp256k1 point addition, no Spark-UTK tweak. The non-trivial
            // tagged-hash tweak only kicks in once we inject msg ≠ 0 at leaf
            // creation, which the stock SDK doesn't expose (chunk-α-bis).
            const derivedBytes = addPublicKeys(hexToBytes(proofUBase), hexToBytes(proofOperator))
            const derived = bytesToHex(derivedBytes).toLowerCase()
            const claimed = env.leafReference.verifyingPublicKey.toLowerCase()
            leafVerification = derived === claimed
              ? { kind: 'ok', derivedVerifyingKey: derived }
              : { kind: 'mismatch', expected: claimed, got: derived }
          } catch (e) {
            leafVerification = { kind: 'error', message: e instanceof Error ? e.message : String(e) }
          }
        }
        entry = {
          raw: rawHex,
          envelope: env,
          proofUBase,
          proofOperator,
          leafVerification,
        }
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
        Build a proof → POST → poll inbox → decode → verify. Pick a{' '}
        <strong>mode</strong>, paste a <strong>target npub</strong>, hit{' '}
        <strong>send</strong>.
      </p>
      <details style={{ marginTop: -2, marginBottom: 6 }}>
        <summary style={{ fontSize: 12, color: '#888', cursor: 'pointer' }}>
          what the two modes mean
        </summary>
        <ul style={{ color: '#666', fontSize: 12, marginTop: 4 }}>
          <li>
            <strong>demo</strong> (v2): <code>u_base</code> = wallet
            <code> identityPubkey</code>, operator = scoping vector v1.
            Self-consistent identity binding only. Works without funding.
          </li>
          <li>
            <strong>real leaf</strong> (v3): <code>u_base</code> = leaf's
            <code> ownerSigningPublicKey</code>, operator = leaf's aggregated
            FROST key. Receiver checks the Spark vanilla invariant
            <code> u_base + operator == leaf.verifyingPublicKey</code>{' '}
            (same primitive the SDK uses in <code>SparkWallet.verifyKey</code>).
            Proves the proof material lives on a real Spark leaf the SE
            recognizes. Does <em>not</em> yet prove Spark-UTK binding — that
            needs msg ≠ 0 at leaf creation (chunk-α-bis).
          </li>
        </ul>
      </details>

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
        <legend style={{ fontSize: 12, color: '#666' }}>mode</legend>
        <label style={{ marginRight: 16, fontSize: 13 }}>
          <input
            type="radio"
            name="lab-mode"
            value="demo"
            checked={mode === 'demo'}
            onChange={() => setMode('demo')}
          />{' '}
          demo · identityPubkey + vector-v1 operator
        </label>
        <label style={{ fontSize: 13 }}>
          <input
            type="radio"
            name="lab-mode"
            value="leaf"
            checked={mode === 'leaf'}
            onChange={() => setMode('leaf')}
            disabled={leaves.length === 0}
          />{' '}
          real Spark leaf · per-leaf u_base + FROST operator
        </label>

        {mode === 'leaf' && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select
                value={selectedLeafId}
                onChange={(e) => setSelectedLeafId(e.target.value)}
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, padding: 4 }}
                disabled={leaves.length === 0}
              >
                {leaves.length === 0 && <option value="">— no leaves —</option>}
                {leaves.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.id.slice(0, 8)}… · {l.value} sats · {l.network} · status={l.status}
                  </option>
                ))}
              </select>
              <button onClick={() => void refreshLeaves()} disabled={leavesLoading} style={{ fontSize: 11 }}>
                {leavesLoading ? '…' : 'refresh'}
              </button>
            </div>
            {selectedLeaf && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ fontSize: 11, color: '#666', cursor: 'pointer' }}>
                  leaf hex details
                </summary>
                <div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 11, color: '#555', wordBreak: 'break-all' }}>
                  <div>treeId: {selectedLeaf.treeId}</div>
                  <div>ownerSigningPublicKey (u_base): {selectedLeaf.ownerSigningPublicKey}</div>
                  <div>operatorPublicKey (FROST): {selectedLeaf.operatorPublicKey}</div>
                  <div>verifyingPublicKey (target): {selectedLeaf.verifyingPublicKey}</div>
                </div>
              </details>
            )}
            {leavesErr && <div style={{ color: 'crimson', fontSize: 12, marginTop: 4 }}>{leavesErr}</div>}
            {!leavesErr && leaves.length === 0 && !leavesLoading && (
              <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
                no leaves found — fund the wallet (L1 deposit → claimDeposit, or receive a Spark transfer)
                or stay in demo mode.
              </div>
            )}
          </div>
        )}
      </fieldset>

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
          <button
            onClick={() => void buildAndSend()}
            disabled={!core || sending || !target.trim() || (mode === 'leaf' && !selectedLeaf)}
          >
            {sending
              ? 'sending…'
              : mode === 'leaf'
                ? 'Build proof from leaf and send →'
                : 'Build demo proof and send →'}
          </button>
          {sendErr && <span style={{ color: 'crimson', fontSize: 12 }}>{sendErr}</span>}
        </div>

        {sentLog.length > 0 && (
          <details style={{ marginTop: 10 }}>
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

      <details style={{ marginTop: 10 }}>
        <summary style={{ fontSize: 12, color: '#a06010', cursor: 'pointer' }}>
          caveats · what this demo doesn't yet prove
        </summary>
        <ul style={{ margin: '6px 0 0 0', paddingLeft: 18, fontSize: 12, color: '#665030' }}>
          <li>
            <strong>Spark vanilla, not Spark-UTK</strong>: v3 verifies the
            relation <code>u_base + operator == leaf.verifyingPublicKey</code>{' '}
            — that's Spark's own leaf-key invariant (the SDK calls it
            <code> SparkWallet.verifyKey</code>). It proves the proof refers
            to a real Spark leaf, but the leaf does <em>not</em> yet carry an
            RGB commitment. Real Spark-UTK requires the leaf's verifyingKey
            to encode <code>U_tweaked = u_base + tagged_hash(tag, u_base ‖ msg) · G</code>{' '}
            with <code>msg</code> = an RGB Merkle commitment. The stock SDK
            doesn't expose that hook → SDK fork = chunk-α-bis.
          </li>
          <li>
            <strong>envelope unsigned</strong>: anyone can claim any
            <code> senderIdentityPubkey</code> / leaf reference. Real binding
            needs the envelope signed with the sender's nsec (step 9d).
          </li>
          <li>
            <strong>no RGB validator yet</strong>: rgb-consensus state-transition
            verification (issuance, transfer ops) is chunks β/γ.
          </li>
        </ul>
      </details>
    </div>
  )
}

function DecodedView({ entry }: { entry: DecodedConsignment }) {
  const env = entry.envelope
  const claimed = env?.senderIdentityPubkey?.toLowerCase()
  const got = entry.proofUBase?.toLowerCase()
  let bindingBadge: ReactNode = null
  if (env && got) {
    if (!claimed) {
      bindingBadge = <span style={{ color: '#888' }}>envelope has no senderIdentityPubkey (legacy v1)</span>
    } else if (claimed === got) {
      bindingBadge = <span style={{ color: 'seagreen' }}>OK · proof.u_base matches claimed Spark identity</span>
    } else if (env.v === 3) {
      // v3 binds u_base to the *leaf*, not the wallet identity — so a difference
      // is expected. Don't mark it as MISMATCH; defer the trust badge to leaf
      // verification below.
      bindingBadge = <span style={{ color: '#888' }}>n/a · v3 binds u_base to the leaf, not the wallet identity</span>
    } else {
      bindingBadge = <span style={{ color: '#c80' }}>MISMATCH · proof.u_base ≠ envelope.senderIdentityPubkey</span>
    }
  }

  const lv = entry.leafVerification
  let leafBadge: ReactNode = null
  if (env?.v === 3 && lv) {
    if (lv.kind === 'ok') {
      leafBadge = (
        <span style={{ color: 'seagreen' }}>
          OK · u_base + operator == leaf.verifyingPublicKey (Spark vanilla)
        </span>
      )
    } else if (lv.kind === 'mismatch') {
      leafBadge = (
        <span style={{ color: '#c00' }}>
          MISMATCH · u_base + operator ≠ leaf.verifyingPublicKey
        </span>
      )
    } else if (lv.kind === 'error') {
      leafBadge = <span style={{ color: 'crimson' }}>derive error · {lv.message}</span>
    }
  }

  return (
    <div style={{ marginTop: 6, paddingLeft: 12, borderLeft: '3px solid #6c6', fontSize: 12, fontFamily: 'monospace' }}>
      {entry.parseError && <div style={{ color: 'crimson' }}>parse error: {entry.parseError}</div>}
      {env && (
        <>
          <div><span style={{ color: '#666' }}>envelope v:</span> {env.v}</div>
          <div><span style={{ color: '#666' }}>sender (npub):</span> {env.sender}</div>
          {env.senderIdentityPubkey && (
            <div><span style={{ color: '#666' }}>senderIdentityPubkey:</span> {env.senderIdentityPubkey}</div>
          )}
          <div><span style={{ color: '#666' }}>createdAt:</span> {env.createdAt}</div>
          <div><span style={{ color: '#666' }}>kind:</span> {env.kind}</div>
          <div><span style={{ color: '#666' }}>proof.uBase:</span> {entry.proofUBase}</div>
          <div><span style={{ color: '#666' }}>proof.operator:</span> {entry.proofOperator}</div>
          <div style={{ marginTop: 4 }}>
            <span style={{ color: '#666' }}>identity binding:</span> {bindingBadge}
          </div>
          {env.v === 3 && (
            <>
              <div style={{ marginTop: 6, color: '#666' }}>leafReference:</div>
              <div style={{ paddingLeft: 8 }}>
                <div>id: {env.leafReference.id}</div>
                <div>treeId: {env.leafReference.treeId}</div>
                <div>value: {env.leafReference.value} sats</div>
                <div>network: {env.leafReference.network}</div>
                <div>verifyingPublicKey: {env.leafReference.verifyingPublicKey}</div>
                {lv?.kind === 'ok' && (
                  <div>computed (u_base + operator): {lv.derivedVerifyingKey}</div>
                )}
                {lv?.kind === 'mismatch' && (
                  <>
                    <div>computed (u_base + operator): {lv.got}</div>
                    <div>expected (claimed): {lv.expected}</div>
                  </>
                )}
              </div>
              <div style={{ marginTop: 4 }}>
                <span style={{ color: '#666' }}>leaf binding:</span> {leafBadge}
              </div>
            </>
          )}
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
