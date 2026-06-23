import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react'
import { generateSecretKey, nip19 } from 'nostr-tools'
import { addPublicKeys } from '@buildonspark/spark-sdk'
import { parseLoginSecret, type ParsedLogin } from './lib/nostrKey'
import { deriveFamilierKey, type FamilierKey } from './lib/familierKey'
import { pollDepositStatus, type DepositStatus, type FamilierNetwork } from './lib/utxoLookup'
import {
  readVault,
  writeVault,
  clearVault,
  encryptSecret,
  decryptSecret,
  WrongPinError,
  type EncryptedVault,
} from './lib/secretVault'
import {
  initSparkWallet,
  getBalance,
  disposeSparkWallet,
  listSparkLeaves,
  claimL1Deposit,
  transferToSpark,
  mintViaSelfTransfer,
  getSparkWallet,
  type WalletInitResult,
  type SparkLeafRow,
} from './lib/sparkWallet'
import {
  probeHtlc,
  probeHtlcReveal,
  probeHtlcCrossExpiry,
  pickSmallestLeaf,
  type HtlcProbeResult,
  type HtlcRevealProbeResult,
  type HtlcCrossExpiryProbeResult,
  type InvoiceShape,
} from './lib/htlcProbe'
import {
  runSellerFlow,
  runBuyerFlow,
  resumeBuyerFlow,
  lockUnderHash,
  newPreimagePair,
  queryPendingHtlcs,
  bytesToHex as htlcBytesToHex,
  type SwapState,
} from './lib/htlcSwap'
import {
  postOrder,
  listOrders,
  cancelOrder,
  signOrder,
  uuidV7,
  type OrderPayload,
  type StoredOrder,
  type PlaceResult,
} from './lib/orderbookRelay'
import {
  attachOrderSecrets,
  detachOrderSecrets,
  addOrderSecret,
  getOrderSecret,
  removeOrderSecret,
} from './lib/orderPreimageStash'
import { RgbAwareSparkSigner, clearRgbIntent, listPathTweaks, getPathTweak } from './lib/rgbAwareSigner'
import { planSatsLock } from './lib/leafSelection'
import {
  captureSettlementSnapshot,
  runAutoEmit,
  type AutoEmitOutcome,
  type SettlementSnapshot,
} from './lib/settlementAutoEmit'
import {
  startInboxPoller,
  stopInboxPoller,
  subscribeInbox,
  type InboxStatus,
} from './lib/settlementInbox'
import {
  findBoundLeaf,
  lazyRebindIfNeeded,
} from './lib/assetBinding'
import { attachPathTweakStorage, detachPathTweakStorage } from './lib/pathTweakStorage'
import {
  attachStash,
  detachStash,
  addContract,
  addTransition,
  listContracts,
  listTransitionsFor,
  subscribeStash,
  type StashContract,
  type StashTransition,
} from './lib/rgbStash'
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
import {
  signEnvelope,
  verifyEnvelope,
  type UnsignedEnvelopeV4,
  type SignedEnvelopeV4,
  type SignatureCheck,
} from './lib/envelopeSign'
import './App.css'

type Network = 'MAINNET' | 'REGTEST' | 'TESTNET'
type BootState =
  | { kind: 'idle' }
  | { kind: 'locked'; vault: EncryptedVault }
  | { kind: 'loading'; stage: string }
  | {
      kind: 'ready'
      parsed: ParsedLogin
      wallet: WalletInitResult
      balanceSats: bigint | 'pending' | 'error'
      /** True if this boot came from decrypting a stored vault — disables the
       *  "Save with PIN" prompt and labels Reset accordingly. */
      cameFromVault: boolean
      /** Flips when the user successfully saves the wallet to the vault from
       *  within the ready view; collapses the save prompt. */
      vaultJustSaved: boolean
    }
  | { kind: 'error'; message: string }

interface VaultPayload {
  secret: string
  network: Network
}

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

/**
 * Display-only formatter for the unit price of an order
 * (Phase 1C/clean session 8.2 — orderbook UI for partial fills).
 * Float math is OK here because the orderbook's actual matching uses
 * BigInt cross-multiplication, so this is purely cosmetic. Big amounts
 * lose precision in Number — acceptable for display, never for matching.
 */
function formatUnitPrice(priceSats: number, amountStr: string): string {
  const amount = Number(amountStr)
  if (!Number.isFinite(amount) || amount === 0) return '?'
  const unit = priceSats / amount
  if (unit >= 1000) return Math.round(unit) + ' sats/X'
  if (unit >= 1) return unit.toFixed(2) + ' sats/X'
  if (unit > 0) return unit.toFixed(4) + ' sats/X'
  return '0 sats/X'
}

interface LeafReference {
  id: string
  treeId: string
  value: number
  network: string
  // Per-leaf 33-byte compressed verifying key recorded by the Spark SE.
  verifyingPublicKey: string
  /** When present (32-byte hex), the proof carries a Spark-UTK tweaked binding:
   *  proof.u_base is the PRE-mint vanilla u_base of the source leaf, and the
   *  receiver verifies via deriveVerifyingKey(u_base, msg, operator) == verifyingPublicKey.
   *  When absent, the leaf is vanilla and the receiver verifies via
   *  addPublicKeys(u_base, operator) == verifyingPublicKey. */
  msgHex?: string
  /** When present (hex of a strict-encoded `Consignment<false>`), the RGB
   *  layer comes along for the ride. The receiver runs
   *  `core.validateNiaConsignment(consignmentHex)` to:
   *    1. Validate the consignment against the canonical NIA schema
   *    2. Extract the deterministic contractId
   *    3. Cross-check contractId == msgHex
   *  When all three pass, the receiver knows the Spark leaf is bound to a
   *  validly-issued RGB asset whose contractId they verified themselves. */
  consignmentHex?: string
  /** When present (hex of a strict-encoded `Transition`), the leaf
   *  commits to an NIA state transition rather than the genesis. The
   *  receiver runs `core.validateNiaTransition(transitionHex,
   *  prevGenesisHex)` — pure schema/AluVM replay, no L1 witness, no
   *  resolver — and cross-checks the returned commit_id against msgHex.
   *  `prevGenesisHex` is required: the receiver rebuilds the input state
   *  map from the genesis assignments to feed Schema::validate_state. */
  transitionHex?: string
  prevGenesisHex?: string
  /** When present (hex of a strict-encoded `Transition`), the receiver
   *  validates a depth-3 chain `genesis → prevTransition → transition`
   *  via `core.validateNiaTransitionFromPrev`. Shipped by
   *  settlement-consignment-v1 envelopes; msgHex on those refers to
   *  prevTransition.id() (the seller's pre-swap binding), not the new
   *  transition. See `frontend/src/lib/envelopeSign.ts`. */
  prevTransitionHex?: string
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
  | (SignedEnvelopeV4 & { kind: 'spark-utk-proof' })

function App() {
  const [secret, setSecret] = useState('')
  const [network, setNetwork] = useState<Network>('REGTEST')
  // Lazy initial state: if a vault was previously written, start on the locked
  // screen. Doing this at first-render (instead of in useEffect) avoids a flash
  // of the input form and satisfies react-hooks/set-state-in-effect.
  const [state, setState] = useState<BootState>(() => {
    const v = readVault()
    return v ? { kind: 'locked', vault: v } : { kind: 'idle' }
  })

  async function bootFromInput(input: string, opts?: { network?: Network; cameFromVault?: boolean }) {
    const net = opts?.network ?? network
    const cameFromVault = opts?.cameFromVault ?? false
    setState({ kind: 'loading', stage: 'parsing secret' })
    try {
      const parsed = parseLoginSecret(input)
      // Restore pathTweaks BEFORE initSparkWallet — the SDK's initialize()
      // runs an internal syncWallet() (spark-wallet.ts:472) which iterates
      // leaves and asks the signer for getPublicKeyFromDerivation. If the
      // map is empty at that moment, every tweaked leaf gets filtered out
      // of leafManager.this.leaves (the sync clears and re-populates with
      // valid leaves only), and later restoration of pathTweaks doesn't
      // re-add them — they'd need another sync round to come back.
      attachPathTweakStorage(parsed.npub)
      attachStash(parsed.npub)
      attachOrderSecrets(parsed.npub)
      setState({ kind: 'loading', stage: `initializing Spark wallet on ${net}` })
      const wallet = await initSparkWallet(parsed.sparkSeed, net, new RgbAwareSparkSigner())
      // Settlement inbox poller — auto-stashes settlement-consignment-v1
      // envelopes a counterparty has dropped on our relay queue. Starts
      // AFTER initSparkWallet so the first tick has a chance to overlap
      // the initial sync, and stops in reset() below.
      startInboxPoller(parsed.npub)
      setState({ kind: 'ready', parsed, wallet, balanceSats: 'pending', cameFromVault, vaultJustSaved: false })
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

  async function unlockWithPin(vault: EncryptedVault, pin: string) {
    // Decrypt outside the ready-state machine so a wrong PIN can be retried
    // without bouncing through 'error' (which sends the user back to the input
    // form and asks them to paste a secret).
    const payloadJson = await decryptSecret(vault, pin)
    const payload = JSON.parse(payloadJson) as VaultPayload
    setNetwork(payload.network)
    await bootFromInput(payload.secret, { network: payload.network, cameFromVault: true })
  }

  async function saveCurrentToVault(pin: string) {
    if (state.kind !== 'ready') throw new Error('save: wallet not ready')
    const payload: VaultPayload = { secret: state.parsed.nsec, network: state.wallet.network as Network }
    const vault = await encryptSecret(JSON.stringify(payload), pin, state.parsed.npub)
    writeVault(vault)
    setState((prev) => prev.kind === 'ready' ? { ...prev, vaultJustSaved: true } : prev)
  }

  function generateAndBoot() {
    const sk = generateSecretKey()
    const nsec = nip19.nsecEncode(sk)
    setSecret(nsec)
    void bootFromInput(nsec)
  }

  async function reset() {
    await disposeSparkWallet()
    clearVault()
    detachPathTweakStorage()
    detachStash()
    detachOrderSecrets()
    stopInboxPoller()
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

      {state.kind === 'locked' && (
        <LockedScreen
          vault={state.vault}
          onUnlock={(pin) => unlockWithPin(state.vault, pin)}
          onForget={() => void reset()}
        />
      )}

      {state.kind !== 'ready' && state.kind !== 'locked' && (
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
          <ToastHost />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>booted · {state.wallet.network}</h2>
            <button onClick={() => void reset()}>
              {state.cameFromVault || state.vaultJustSaved ? 'Forget wallet' : 'Reset'}
            </button>
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

          {!state.cameFromVault && !state.vaultJustSaved && (
            <SaveWithPin onSave={saveCurrentToVault} />
          )}
          {state.vaultJustSaved && (
            <div style={{ marginTop: 12, padding: 8, background: '#e8f5e9', border: '1px solid #a5d6a7', fontSize: 13 }}>
              Wallet saved. Next reload will ask for your PIN.
            </div>
          )}
          {state.cameFromVault && (
            <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
              Unlocked from PIN-encrypted vault.
            </div>
          )}

          <ClaimL1DepositVanilla />

          <SendToSpark />

          <RgbStashPanel />

          <details style={{ marginTop: 16, borderTop: '1px solid #ddd', paddingTop: 8 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: '#666' }}>
              Order book
            </summary>
            <OrderBookPanel
              myNpub={state.parsed.npub}
              myNostrPrivkeyHex={state.parsed.nostrPrivkeyHex}
              mySparkIdentityPubkey={state.wallet.identityPubkey}
            />
          </details>

          <details style={{ marginTop: 28, borderTop: '2px solid #ccc', paddingTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: '#666', fontWeight: 'bold' }}>
              Developer lab · Spark-UTK mint + NIA consignment round-trip
            </summary>
            <div style={{ marginTop: 8 }}>
              <PathTweaksDebug />
              <HtlcProbe />
              <HtlcSelfSwap />
              <SettlementAutoEmitProbe
                myNpub={state.parsed.npub}
                myNostrPrivkeyHex={state.parsed.nostrPrivkeyHex}
                mySparkIdentityPubkey={state.wallet.identityPubkey}
              />
              <ConsignmentLab
                myNpub={state.parsed.npub}
                myIdentityPubkey={state.wallet.identityPubkey}
                myNostrPrivkeyHex={state.parsed.nostrPrivkeyHex}
              />
              <SparkUtkMintViaTransfer rootSeed={state.parsed.sparkSeed} />
            </div>
          </details>
        </div>
      )}
    </section>
  )
}

// ---- OrderBook panel (Phase 1C session 3) ----------------------------------
//
// Surfaces the relay's signed orderbook in the wallet UX. Lets the user:
//   - Pick an asset from their RGB stash.
//   - Place an ask (sell asset) or bid (buy asset) signed by their nsec.
//   - See the current book for that asset (open + matched orders).
//   - When their own order matches, kick off the appropriate HTLC swap
//     flow (`runSellerFlow` / `runBuyerFlow`) wired to the counterparty
//     details returned by the relay.
//
// Cross-wallet end-to-end settlement is testable across two devices /
// browsers — the relay refuses self-match by npub, so a single wallet
// can verify all placement / cancellation / signature paths but not
// settlement. Phase 1C session 1 already validated the orchestrator
// state machine via self-receive; combined with the relay smoke test
// (16/16 server-side assertions), the full path is covered piecewise.

interface OrderBookPanelProps {
  myNpub: string
  myNostrPrivkeyHex: string
  mySparkIdentityPubkey: string
}

function OrderBookPanel({
  myNpub,
  myNostrPrivkeyHex,
  mySparkIdentityPubkey,
}: OrderBookPanelProps) {
  const [contracts, setContracts] = useState<StashContract[]>([])
  const [selectedAssetId, setSelectedAssetId] = useState<string>('')
  /** When set, takes precedence over the stash dropdown — lets the user
   *  paste a counterparty's assetId to discover their book entries. */
  const [pastedAssetId, setPastedAssetId] = useState<string>('')
  const [book, setBook] = useState<StoredOrder[]>([])
  const [bookErr, setBookErr] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const effectiveAssetId = pastedAssetId.trim() || selectedAssetId
  const isUsingPasted = pastedAssetId.trim().length > 0

  // Live subscribe to the stash so the asset dropdown picks up new
  // issuances without a page refresh.
  useEffect(() => {
    const unsub = subscribeStash((snap) => {
      setContracts(snap.contracts)
      setSelectedAssetId((prev) => prev || snap.contracts[0]?.contractId || '')
    })
    return () => { unsub() }
  }, [])

  const refresh = useCallback(async () => {
    if (!effectiveAssetId) {
      setBook([])
      return
    }
    if (!/^[0-9a-fA-F]{64}$/.test(effectiveAssetId)) {
      setBook([])
      setBookErr(`bad assetId: expected 64 hex chars, got ${effectiveAssetId.length}`)
      return
    }
    setRefreshing(true)
    setBookErr(null)
    try {
      const list = await listOrders(effectiveAssetId)
      setBook(list)
    } catch (e) {
      setBookErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }, [effectiveAssetId])

  useEffect(() => {
    void refresh()
    // Poll every 5 s while the panel is mounted so match-status flips
    // surface without a manual refresh.
    const t = setInterval(() => void refresh(), 5_000)
    return () => clearInterval(t)
  }, [refresh])

  const selectedContract = contracts.find((c) => c.contractId === effectiveAssetId)

  return (
    <fieldset style={{ marginTop: 16, border: '1px solid #ddd', padding: '8px 12px' }}>
      <legend style={{ fontSize: 12, color: '#666' }}>
        Order book · {book.length} order{book.length === 1 ? '' : 's'}
      </legend>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: '#666' }}>asset:</label>
        <select
          value={selectedAssetId}
          onChange={(e) => {
            setSelectedAssetId(e.target.value)
            setPastedAssetId('')
          }}
          disabled={isUsingPasted || contracts.length === 0}
          style={{ fontSize: 12, padding: 4, fontFamily: 'monospace', flex: 1, minWidth: 200 }}
        >
          {contracts.length === 0 ? (
            <option value="">— no local contracts —</option>
          ) : (
            contracts.map((c) => (
              <option key={c.contractId} value={c.contractId}>
                {c.ticker} · {c.name} · {c.contractId.slice(0, 10)}…
              </option>
            ))
          )}
        </select>
        <button onClick={() => void refresh()} disabled={refreshing || !effectiveAssetId} style={{ fontSize: 11 }}>
          {refreshing ? '…' : 'refresh'}
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 11, color: '#888' }}>or paste asset id (64 hex):</label>
        <input
          value={pastedAssetId}
          onChange={(e) => setPastedAssetId(e.target.value)}
          placeholder="counterparty's contractId for cross-wallet discovery"
          style={{ fontSize: 11, padding: 4, fontFamily: 'monospace', flex: 1, minWidth: 200 }}
        />
        {isUsingPasted && (
          <button onClick={() => setPastedAssetId('')} style={{ fontSize: 11 }}>
            clear
          </button>
        )}
      </div>

      {contracts.length === 0 && !isUsingPasted && (
        <div style={{ fontSize: 12, color: '#888', padding: '6px 0' }}>
          No issued contracts yet — issue an NIA from the Developer lab below,
          or paste a counterparty's assetId above to browse their book.
        </div>
      )}

      {effectiveAssetId && (
        <>
          <PlaceOrderForms
            assetId={effectiveAssetId}
            selectedContract={selectedContract}
            myNpub={myNpub}
            myNostrPrivkeyHex={myNostrPrivkeyHex}
            mySparkIdentityPubkey={mySparkIdentityPubkey}
            onPosted={() => void refresh()}
          />

          {bookErr && (
            <pre style={{ color: 'crimson', fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 8 }}>
              {bookErr}
            </pre>
          )}

          <div style={{ marginTop: 10, fontFamily: 'monospace', fontSize: 11 }}>
            {book.length === 0 ? (
              <div style={{ color: '#888' }}>(no open orders for this asset)</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '50px 80px 80px 90px 110px 80px 1fr', gap: 4, color: '#888', fontWeight: 'bold', borderBottom: '1px solid #eee', paddingBottom: 4 }}>
                  <div>side</div>
                  <div>price</div>
                  <div>amount</div>
                  <div>unit</div>
                  <div>poster</div>
                  <div>status</div>
                  <div>actions</div>
                </div>
                {book.map((so) => (
                  <OrderRow
                    key={so.order.id}
                    so={so}
                    myNpub={myNpub}
                    myNostrPrivkeyHex={myNostrPrivkeyHex}
                    mySparkIdentityPubkey={mySparkIdentityPubkey}
                    onChanged={() => void refresh()}
                  />
                ))}
              </>
            )}
          </div>

          <div style={{ marginTop: 8, fontSize: 11, color: '#888' }}>
            Cross-wallet settlement: relay refuses self-match by npub —
            test the end-to-end swap from a second device with a different
            nsec.
          </div>
        </>
      )}
    </fieldset>
  )
}

function PlaceOrderForms({
  assetId,
  selectedContract,
  myNpub,
  myNostrPrivkeyHex,
  mySparkIdentityPubkey,
  onPosted,
}: {
  assetId: string
  selectedContract: StashContract | undefined
  myNpub: string
  myNostrPrivkeyHex: string
  mySparkIdentityPubkey: string
  onPosted: () => void
}) {
  const [side, setSide] = useState<'ask' | 'bid'>('ask')
  const [amount, setAmount] = useState('')
  const [priceSats, setPriceSats] = useState('')
  const [expiryMin, setExpiryMin] = useState('60')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [lastPlaced, setLastPlaced] = useState<PlaceResult | null>(null)
  // Session 6: status of the lazy-rebind pre-step on ask side. Cleared at
  // the start of each place() call. Surfaces to the user during the
  // mintViaSelfTransfer call that can take a few seconds.
  const [rebindStatus, setRebindStatus] = useState<string | null>(null)

  useEffect(() => {
    if (selectedContract && !amount) setAmount(selectedContract.supply)
  }, [selectedContract, amount])

  async function place() {
    setBusy(true)
    setErr(null)
    setLastPlaced(null)
    setRebindStatus(null)
    try {
      if (!assetId) throw new Error('select an asset first')
      if (!/^[0-9]+$/.test(amount.trim()) || BigInt(amount.trim()) <= 0n) {
        throw new Error('amount must be a positive integer')
      }
      const price = Number(priceSats.trim())
      if (!Number.isSafeInteger(price) || price <= 0) {
        throw new Error('priceSats must be a positive integer')
      }
      const expMin = Number(expiryMin.trim())
      if (!Number.isSafeInteger(expMin) || expMin <= 0 || expMin > 24 * 60) {
        throw new Error('expiry must be 1–1440 minutes')
      }
      const now = new Date()
      const expiry = new Date(now.getTime() + expMin * 60_000).toISOString()

      // Ask side: rebind if needed (Phase 1C/clean session 6). The user
      // might have received this asset via the inbox auto-stash, in which
      // case their leaves are vanilla. Re-sell requires a leaf bound to
      // a fresh T_n+1 over the latest known transition. Silent no-op when
      // a binding already exists.
      if (side === 'ask') {
        setRebindStatus('Preparing your sell order…')
        const outcome = await lazyRebindIfNeeded(assetId)
        if (outcome.status === 'rebound') {
          setRebindStatus('Ready · asset binding refreshed')
        } else if (outcome.status === 'already-bound') {
          setRebindStatus(null)
        } else {
          throw new Error(`rebind ${outcome.status}: ${outcome.reason}`)
        }
      }

      // Ask side: generate paymentHash now (seller controls the preimage).
      // Preimage is persisted in orderPreimageStash so the seller can fire
      // runSellerFlow when a bid matches, even after a browser reload.
      const orderId = uuidV7()
      let paymentHash: string | undefined
      let preimageHex: string | undefined
      if (side === 'ask') {
        const pair = newPreimagePair()
        paymentHash = htlcBytesToHex(pair.paymentHash)
        preimageHex = htlcBytesToHex(pair.preimage)
      }

      const payload: OrderPayload = {
        id: orderId,
        side,
        posterNpub: myNpub,
        posterSparkIdentityPubkey: mySparkIdentityPubkey,
        assetId,
        amount: amount.trim(),
        priceSats: price,
        expiryTime: expiry,
        createdAt: now.toISOString(),
        ...(paymentHash ? { paymentHash } : {}),
      }
      const signed = signOrder(payload, myNostrPrivkeyHex)
      // Save preimage BEFORE posting so a network glitch between
      // post-success and secret-save doesn't strand the preimage.
      // Idempotent if the order id is reused.
      if (preimageHex) addOrderSecret(orderId, preimageHex)
      const result = await postOrder(signed)
      setLastPlaced(result)
      onPosted()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset style={{ marginTop: 8, border: '1px solid #eee', padding: '6px 10px' }}>
      <legend style={{ fontSize: 11, color: '#888' }}>place order</legend>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
        <label>
          <input
            type="radio"
            checked={side === 'ask'}
            onChange={() => setSide('ask')}
          />
          ask (sell)
        </label>
        <label>
          <input
            type="radio"
            checked={side === 'bid'}
            onChange={() => setSide('bid')}
          />
          bid (buy)
        </label>
        <label style={{ color: '#666' }}>amount</label>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="numeric"
          placeholder="units"
          style={{ width: 90, fontSize: 12, padding: 3, fontFamily: 'monospace' }}
          disabled={busy}
        />
        <label style={{ color: '#666' }}>price (sats)</label>
        <input
          value={priceSats}
          onChange={(e) => setPriceSats(e.target.value)}
          inputMode="numeric"
          placeholder="total"
          style={{ width: 80, fontSize: 12, padding: 3, fontFamily: 'monospace' }}
          disabled={busy}
        />
        <label style={{ color: '#666' }}>expiry (min)</label>
        <input
          value={expiryMin}
          onChange={(e) => setExpiryMin(e.target.value)}
          inputMode="numeric"
          style={{ width: 50, fontSize: 12, padding: 3, fontFamily: 'monospace' }}
          disabled={busy}
        />
        <button onClick={() => void place()} disabled={busy || !assetId}>
          {busy ? '…' : `Place ${side}`}
        </button>
      </div>
      {rebindStatus && (
        <div style={{ fontSize: 11, color: '#666', marginTop: 4, fontStyle: 'italic' }}>
          {rebindStatus}
        </div>
      )}
      {err && (
        <pre style={{ color: 'crimson', fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 4 }}>
          {err}
        </pre>
      )}
      {lastPlaced && (
        <div
          style={{
            marginTop: 4,
            padding: 4,
            background: lastPlaced.status === 'matched' ? '#e8f5e9' : '#f0f4ff',
            border: lastPlaced.status === 'matched' ? '1px solid #a5d6a7' : '1px solid #b3c5e3',
            fontSize: 11,
            fontFamily: 'monospace',
          }}
        >
          <div>
            posted · status: <strong>{lastPlaced.status}</strong> · id{' '}
            <code>{lastPlaced.id.slice(0, 8)}…</code>
          </div>
          {lastPlaced.status === 'matched' && (
            <div style={{ color: 'seagreen' }}>
              🟢 matched with {lastPlaced.counterpartyNpub?.slice(0, 16)}…
              {lastPlaced.matchedAmount && (
                <> · <code>{lastPlaced.matchedAmount}</code> units</>
              )}
              {lastPlaced.paymentHash && (
                <> · paymentHash {lastPlaced.paymentHash.slice(0, 16)}…</>
              )}
            </div>
          )}
        </div>
      )}
    </fieldset>
  )
}

function OrderRow({
  so,
  myNpub,
  myNostrPrivkeyHex,
  mySparkIdentityPubkey,
  onChanged,
}: {
  so: StoredOrder
  myNpub: string
  myNostrPrivkeyHex: string
  mySparkIdentityPubkey: string
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [swapLog, setSwapLog] = useState<SwapState[]>([])
  // Phase 1C/clean session 8.2: inline match form. When the user clicks
  // "buy" on someone's ask (or "sell" on someone's bid), the row expands
  // with an amount input and posts a proportional counter-order.
  const [matchOpen, setMatchOpen] = useState(false)
  const [matchAmount, setMatchAmount] = useState('')
  const [matchBusy, setMatchBusy] = useState(false)
  const [matchErr, setMatchErr] = useState<string | null>(null)
  const [matchResult, setMatchResult] = useState<PlaceResult | null>(null)
  const [matchRebindStatus, setMatchRebindStatus] = useState<string | null>(null)

  const isMine = so.order.posterNpub === myNpub
  const isMatched = so.status === 'matched'
  const canMatch = !isMine && so.status === 'open'
  const oppositeSide: 'ask' | 'bid' = so.order.side === 'ask' ? 'bid' : 'ask'

  function toggleMatchForm() {
    if (matchOpen) {
      setMatchOpen(false)
      return
    }
    setMatchOpen(true)
    setMatchErr(null)
    setMatchResult(null)
    setMatchRebindStatus(null)
    // Default to the order's full amount — covers the "I'll take the lot"
    // case in one click. User can edit down for a partial fill.
    if (matchAmount === '') setMatchAmount(so.order.amount)
  }

  async function doCancel() {
    setBusy(true)
    try {
      await cancelOrder(so.order.assetId, so.order.id, myNpub)
      onChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runMySwap() {
    if (!isMine || !isMatched) return
    setBusy(true)
    setSwapLog([])
    try {
      const wallet = getSparkWallet()
      if (!wallet) throw new Error('wallet not initialized')

      // Resolve the counterparty pubkey: it's NOT on `so` directly; the
      // matched counterparty's order is also in `book` (same assetId).
      // Fetch fresh to be safe.
      const list = await listOrders(so.order.assetId)
      const counterpart = list.find((x) => x.order.id === so.matchedWith)
      if (!counterpart) throw new Error('counterparty order not found in book')
      const counterpartyPubkeyHex = counterpart.order.posterSparkIdentityPubkey
      const counterpartyPubkeyBytes = new Uint8Array(33)
      for (let i = 0; i < 33; i++) {
        counterpartyPubkeyBytes[i] = parseInt(counterpartyPubkeyHex.substr(i * 2, 2), 16)
      }

      // T_seller_expiry > T_buyer_expiry per HTLC asymmetry. v0 default:
      // seller 1 h, buyer 30 min — gives buyer a 30-min poll window
      // after reveal.
      if (so.order.side === 'ask') {
        // We're the seller. Recover the preimage we generated at order
        // placement from the orderPreimageStash.
        const secret = getOrderSecret(so.order.id)
        if (!secret) {
          throw new Error(
            `no stored preimage for order ${so.order.id.slice(0, 8)}…. ` +
            'Was the order placed from a different browser/wallet?',
          )
        }
        const preimage = new Uint8Array(32)
        for (let i = 0; i < 32; i++) {
          preimage[i] = parseInt(secret.preimageHex.substr(i * 2, 2), 16)
        }
        const allLeaves = await (wallet as unknown as {
          getLeaves: (b?: boolean) => Promise<Array<{ id: string; value: number }>>
        }).getLeaves(true)
        if (allLeaves.length === 0) throw new Error('no leaves to commit as asset')
        // Session 6: resolve the leaf bound to this contractId via
        // pathTweaks (msg ∈ {contractId} ∪ {transition.commitId}).
        // Falls back to the smallest leaf only when no binding exists —
        // shouldn't happen on the v1 flow since the ask was rebound at
        // place() time, but the fallback keeps legacy / dev-lab paths
        // unblocked.
        const bound = await findBoundLeaf(so.order.assetId)
        const boundRaw = bound
          ? allLeaves.find((l) => l.id === bound.id)
          : undefined
        const assetLeaf = (boundRaw ?? [...allLeaves].sort((a, b) => a.value - b.value)[0]) as unknown as Parameters<typeof lockUnderHash>[1]['leaves'][number]

        // Phase 1C/clean session 8.3: capture the SettlementSnapshot
        // BEFORE the HTLC consumes the source leaf. After runSellerFlow
        // returns, the leaf is gone from listSparkLeaves() and
        // captureSettlementSnapshot would fail. We grab everything we
        // need (operator + verifyingKey + chain bytes) up front.
        const assetLeafIdForSnapshot = (assetLeaf as { id: string }).id
        let preSwapSnapshot: SettlementSnapshot | null = null
        const snapResult = await captureSettlementSnapshot(assetLeafIdForSnapshot)
        if (snapResult.ok) {
          preSwapSnapshot = snapResult.snapshot
        } else {
          // Non-fatal — auto-emit will be skipped but the swap can still
          // proceed. Surface in swapLog so the user knows the chain
          // evidence won't be delivered automatically.
          setSwapLog((p) => [
            ...p,
            {
              phase: 'preparing',
              paymentHashHex: '',
              message:
                `auto-emit unavailable: ${snapResult.reason} — ` +
                'swap will run but no settlement consignment will be sent to the buyer.',
              updatedAt: new Date().toISOString(),
              ourExpiry: new Date(),
            },
          ])
        }

        // sprk.11d pre-flight: refuse the swap if the matched bid's
        // amount exceeds the snapshot's bound asset amount — otherwise
        // Spark settles, buyer locks, but auto-emit can't deliver. The
        // buyer would end up stuck without their asset.
        if (preSwapSnapshot) {
          let bidAmount: bigint | null = null
          try {
            bidAmount = BigInt(counterpart.order.amount)
          } catch {
            bidAmount = null
          }
          if (bidAmount !== null && bidAmount > preSwapSnapshot.amount) {
            throw new Error(
              `matched bid wants ${bidAmount} units but you only hold ` +
              `${preSwapSnapshot.amount} on this contract. Refusing the ` +
              `swap. Cancel and re-post a smaller ask, or wait for a ` +
              `smaller bid.`,
            )
          }
        }

        const sellerExpiry = new Date(Date.now() + 60 * 60_000)
        // sprk.12.1b: with partial fill the buyer locks only their bid's
        // priceSats; the seller's validation must compare against THAT,
        // not the seller's ask priceSats which would refuse every
        // partial fill.
        const result = await runSellerFlow(wallet, {
          assetLeaves: [assetLeaf],
          counterpartyPubkey: counterpartyPubkeyBytes,
          expectedSatsFromBuyer: counterpart.order.priceSats,
          expiryTime: sellerExpiry,
          preimage,
          pollIntervalMs: 3_000,
          onState: (s) => setSwapLog((p) => [...p, s]),
        })
        if (result.outcome === 'completed') {
          // Settlement done — preimage no longer needed; drop from local storage.
          removeOrderSecret(so.order.id)

          // Phase 1C/clean session 8.3: settlement-coupled consignment
          // auto-emit. The buyer's wallet sees this envelope on its inbox
          // poller and auto-stashes the asset state. orderAmount comes
          // from the COUNTERPARTY's order (= the bid amount = the actual
          // transacted amount, since asks are consumed in full per session
          // 8.1's partial-fill model).
          if (preSwapSnapshot) {
            let orderAmount: bigint
            try {
              orderAmount = BigInt(counterpart.order.amount)
            } catch {
              orderAmount = preSwapSnapshot.amount
            }
            const emitOutcome = await runAutoEmit({
              snapshot: preSwapSnapshot,
              myNpub,
              myNostrPrivkeyHex,
              mySparkIdentityPubkey,
              buyerNpub: counterpart.order.posterNpub,
              orderAmount,
            })
            const emitMessage =
              emitOutcome.status === 'emitted'
                ? `settlement consignment posted (envelope ${emitOutcome.envelopeId.slice(0, 8)}…` +
                  (emitOutcome.outputCount > 1
                    ? `, split ${orderAmount} → buyer / ${emitOutcome.changeAmount} → change`
                    : '') +
                  (emitOutcome.changeLeafId
                    ? `, change leaf ${emitOutcome.changeLeafId.slice(0, 10)}…`
                    : '') +
                  (emitOutcome.postEmitWarning
                    ? ` · ⚠ ${emitOutcome.postEmitWarning}`
                    : '') +
                  ')'
                : `auto-emit failed: ${emitOutcome.reason}`
            setSwapLog((p) => [
              ...p,
              {
                phase: emitOutcome.status === 'emitted' ? 'completed' : 'failed',
                paymentHashHex: '',
                message: emitMessage,
                updatedAt: new Date().toISOString(),
                ourExpiry: new Date(),
              },
            ])
          }
        }
      } else {
        // We're the buyer. Counterparty is the seller; their paymentHash
        // is on counterpart.order.
        const paymentHashHex = counterpart.order.paymentHash
        if (!paymentHashHex) throw new Error('matched ask has no paymentHash')
        const paymentHashBytes = new Uint8Array(32)
        for (let i = 0; i < 32; i++) {
          paymentHashBytes[i] = parseInt(paymentHashHex.substr(i * 2, 2), 16)
        }
        const buyerExpiry = new Date(Date.now() + 30 * 60_000)

        // Resumability: if we already locked sats under this paymentHash
        // (e.g., a previous Run swap that the UI lost between locking and
        // claiming because of a reload), skip the lock step entirely.
        // Otherwise leaf-selection would refuse — the leaf sufficient for
        // priceSats is the one already locked, hence missing from getLeaves.
        const existingLocks = await queryPendingHtlcs(wallet, {
          role: 'sender',
          paymentHashes: [paymentHashBytes],
        })
        const activeLock = existingLocks.find(
          (r) => r.status === 'waiting' || r.status === 'shared',
        )

        if (activeLock) {
          await resumeBuyerFlow(wallet, {
            paymentHash: paymentHashBytes,
            counterpartyPubkey: counterpartyPubkeyBytes,
            expiryTime: buyerExpiry,
            pollIntervalMs: 3_000,
            onState: (s) => setSwapLog((p) => [...p, s]),
          })
        } else {
          // sprk.12.2: subset-sum exact-lock; fall back to smallest
          // covering with overpay log if no exact subset exists.
          // wallet.getLeaves(true) returns native TreeNode (Uint8Array
          // fields) — listSparkLeaves' hex projection breaks the FROST
          // signer.
          const sdkLeaves = await (wallet as { getLeaves: (b?: boolean) => Promise<Array<{ id: string; value: number }>> }).getLeaves(true)
          const boundLeafIds = new Set(listPathTweaks().map((t) => t.currentLeafId))
          const vanilla = sdkLeaves.filter((l) => !boundLeafIds.has(l.id))
          const plan = planSatsLock(vanilla, so.order.priceSats)
          if (plan.mode === 'insufficient') {
            throw new Error(
              `wallet's vanilla leaves total ${plan.totalAvailable} sats — ` +
              `not enough to cover priceSats ${so.order.priceSats}.`,
            )
          }
          if (plan.mode === 'exact') {
            setSwapLog((p) => [
              ...p,
              { stage: 'plan', message:
                `lock plan: ${plan.leaves.length} leaf(es) summing to exactly ${plan.lockSats} sats — zero overpay.` } as never,
            ])
          } else {
            setSwapLog((p) => [
              ...p,
              { stage: 'overpay', message:
                `lock plan: ${plan.leaves.length} leaf(es) summing to ${plan.lockSats} sats for ${so.order.priceSats}-sat trade ` +
                `(overpay ${plan.overpay} sats).` } as never,
            ])
          }
          const satsLeaves = plan.leaves as unknown as Parameters<typeof lockUnderHash>[1]['leaves']
          await runBuyerFlow(wallet, {
            satsLeaves,
            counterpartyPubkey: counterpartyPubkeyBytes,
            paymentHash: paymentHashBytes,
            expiryTime: buyerExpiry,
            pollIntervalMs: 3_000,
            onState: (s) => setSwapLog((p) => [...p, s]),
          })
        }
      }
    } catch (e) {
      setSwapLog((p) => [
        ...p,
        {
          phase: 'failed',
          paymentHashHex: so.order.paymentHash ?? '',
          message: `swap failed to start: ${e instanceof Error ? e.message : String(e)}`,
          updatedAt: new Date().toISOString(),
          ourExpiry: new Date(),
          cause: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        },
      ])
    } finally {
      setBusy(false)
    }
  }

  /**
   * Phase 1C/clean session 8.2: post a counter-order that takes some
   * units off this row's order. Computes the proportional priceSats so
   * the unit price matches exactly (cross-multiplication, no rounding).
   * Generates a fresh paymentHash + persists the preimage if we end up
   * posting as ask side. Runs lazyRebindIfNeeded on ask side so the
   * counter-order is backed by a properly bound leaf.
   */
  async function postMatchCounter() {
    setMatchBusy(true)
    setMatchErr(null)
    setMatchResult(null)
    setMatchRebindStatus(null)
    try {
      if (!/^[0-9]+$/.test(matchAmount.trim())) {
        throw new Error('amount must be a positive integer')
      }
      const want = BigInt(matchAmount.trim())
      if (want <= 0n) throw new Error('amount must be > 0')
      const orderAmt = BigInt(so.order.amount)
      if (want > orderAmt) {
        throw new Error(`amount ${want} exceeds order's offer of ${so.order.amount}`)
      }
      // Proportional priceSats: want * orderPrice / orderAmount, exact integer.
      const product = BigInt(so.order.priceSats) * want
      if (product % orderAmt !== 0n) {
        throw new Error(
          `amount ${want} doesn't divide evenly at this price level — try a different value`,
        )
      }
      const priceSats = Number(product / orderAmt)
      if (!Number.isSafeInteger(priceSats)) {
        throw new Error('computed priceSats is too large for a safe integer')
      }

      // Ask side: ensure a leaf is bound to this asset (same as
      // PlaceOrderForms.place). Buy-side bids don't need a binding.
      if (oppositeSide === 'ask') {
        setMatchRebindStatus('Preparing your sell order…')
        const outcome = await lazyRebindIfNeeded(so.order.assetId)
        if (outcome.status === 'rebound') {
          setMatchRebindStatus('Ready · asset binding refreshed')
        } else if (outcome.status === 'already-bound') {
          setMatchRebindStatus(null)
        } else {
          throw new Error(`rebind ${outcome.status}: ${outcome.reason}`)
        }
      }

      const orderId = uuidV7()
      let paymentHash: string | undefined
      let preimageHex: string | undefined
      if (oppositeSide === 'ask') {
        const pair = newPreimagePair()
        paymentHash = htlcBytesToHex(pair.paymentHash)
        preimageHex = htlcBytesToHex(pair.preimage)
      }
      const expiry = new Date(Date.now() + 60 * 60_000).toISOString()
      const payload: OrderPayload = {
        id: orderId,
        side: oppositeSide,
        posterNpub: myNpub,
        posterSparkIdentityPubkey: mySparkIdentityPubkey,
        assetId: so.order.assetId,
        amount: want.toString(),
        priceSats,
        expiryTime: expiry,
        createdAt: new Date().toISOString(),
        ...(paymentHash ? { paymentHash } : {}),
      }
      const signed = signOrder(payload, myNostrPrivkeyHex)
      // Save preimage BEFORE posting so a network glitch between
      // post-success and secret-save doesn't strand the preimage.
      if (preimageHex) addOrderSecret(orderId, preimageHex)
      const result = await postOrder(signed)
      setMatchResult(result)
      onChanged()
    } catch (e) {
      setMatchErr(e instanceof Error ? e.message : String(e))
    } finally {
      setMatchBusy(false)
    }
  }

  const statusColor: Record<typeof so.status, string> = {
    open: '#444',
    matched: 'seagreen',
    cancelled: '#888',
    expired: '#888',
  }

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '50px 80px 80px 90px 110px 80px 1fr',
          gap: 4,
          padding: '3px 0',
          borderBottom: '1px dashed #eee',
          color: statusColor[so.status],
          alignItems: 'center',
        }}
      >
        <div>{so.order.side}</div>
        <div>{so.order.priceSats}</div>
        <div>{so.order.amount}</div>
        <div style={{ color: '#666' }}>{formatUnitPrice(so.order.priceSats, so.order.amount)}</div>
        <div title={so.order.posterNpub}>
          {isMine ? <strong>me</strong> : so.order.posterNpub.slice(0, 10) + '…'}
        </div>
        <div>{so.status}</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {isMine && so.status === 'open' && (
            <button onClick={() => void doCancel()} disabled={busy} style={{ fontSize: 10 }}>
              cancel
            </button>
          )}
          {isMine && isMatched && (
            <button onClick={() => void runMySwap()} disabled={busy} style={{ fontSize: 10 }}>
              {busy ? '…' : 'Run swap →'}
            </button>
          )}
          {canMatch && (
            <button onClick={toggleMatchForm} style={{ fontSize: 10 }}>
              {matchOpen ? 'close' : oppositeSide === 'bid' ? 'buy' : 'sell'}
            </button>
          )}
        </div>
      </div>
      {matchOpen && canMatch && (
        <div
          style={{
            paddingLeft: 12,
            paddingTop: 4,
            paddingBottom: 6,
            fontSize: 11,
            background: '#fafafa',
            borderBottom: '1px dashed #eee',
          }}
        >
          <div style={{ marginBottom: 4, color: '#666' }}>
            Take {so.order.side === 'ask' ? 'asset' : 'sats'} from this {so.order.side} ·{' '}
            unit price <strong>{formatUnitPrice(so.order.priceSats, so.order.amount)}</strong>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <label style={{ color: '#888' }}>amount</label>
            <input
              value={matchAmount}
              onChange={(e) => setMatchAmount(e.target.value)}
              inputMode='numeric'
              style={{ width: 90, fontSize: 11, padding: 3, fontFamily: 'monospace' }}
              disabled={matchBusy}
            />
            <span style={{ color: '#888' }}>
              of <code>{so.order.amount}</code>
            </span>
            {matchAmount.trim() !== '' && /^[0-9]+$/.test(matchAmount.trim()) && (() => {
              try {
                const want = BigInt(matchAmount.trim())
                const orderAmt = BigInt(so.order.amount)
                if (want <= 0n || want > orderAmt) return null
                const product = BigInt(so.order.priceSats) * want
                if (product % orderAmt !== 0n) {
                  return (
                    <span style={{ color: '#c80' }}>
                      ⚠ doesn't divide evenly
                    </span>
                  )
                }
                const priceSats = Number(product / orderAmt)
                return (
                  <span style={{ color: '#666' }}>
                    → priceSats <code>{priceSats}</code>
                  </span>
                )
              } catch {
                return null
              }
            })()}
            <button onClick={() => void postMatchCounter()} disabled={matchBusy} style={{ fontSize: 10 }}>
              {matchBusy ? '…' : `Place ${oppositeSide}`}
            </button>
          </div>
          {matchRebindStatus && (
            <div style={{ marginTop: 4, color: '#666', fontStyle: 'italic' }}>
              {matchRebindStatus}
            </div>
          )}
          {matchErr && (
            <div style={{ marginTop: 4, color: 'crimson' }}>{matchErr}</div>
          )}
          {matchResult && (
            <div
              style={{
                marginTop: 4,
                padding: 4,
                background: matchResult.status === 'matched' ? '#e8f5e9' : '#f0f4ff',
                border: matchResult.status === 'matched' ? '1px solid #a5d6a7' : '1px solid #b3c5e3',
                fontFamily: 'monospace',
              }}
            >
              posted · status <strong>{matchResult.status}</strong>
              {matchResult.status === 'matched' && (
                <>
                  {' '}· matched <code>{matchResult.matchedAmount}</code> units
                  {matchResult.paymentHash && (
                    <> · paymentHash <code>{matchResult.paymentHash.slice(0, 12)}…</code></>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {swapLog.length > 0 && (
        <div style={{ paddingLeft: 12, fontSize: 10, color: '#444' }}>
          {swapLog.map((s, i) => (
            <div key={i}>
              <strong>{s.phase}</strong> · {s.message}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ---- Toast host (UX-2) ------------------------------------------------------
//
// Lightweight notification banner: subscribes to the inbox status, fires
// a transient toast whenever `acceptedCount` increments. Each toast auto-
// dismisses after 4 s. Positioned fixed at top-center so it doesn't shift
// the page layout. No close button — the auto-fade is the only dismiss.

interface Toast {
  id: number
  message: string
}

function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const prevAcceptedRef = useRef(0)
  const nextIdRef = useRef(1)

  useEffect(() => {
    const unsub = subscribeInbox((s) => {
      if (!s.attached) {
        // Reset baseline when wallet disconnects so a reconnect with
        // a non-zero acceptedCount doesn't pop a phantom toast.
        prevAcceptedRef.current = 0
        return
      }
      if (s.acceptedCount > prevAcceptedRef.current) {
        const delta = s.acceptedCount - prevAcceptedRef.current
        prevAcceptedRef.current = s.acceptedCount
        const id = nextIdRef.current++
        const message = delta === 1
          ? '+1 asset received'
          : `+${delta} assets received`
        setToasts((prev) => [...prev, { id, message }])
        setTimeout(() => {
          setToasts((p) => p.filter((t) => t.id !== id))
        }, 4_000)
      }
    })
    return () => unsub()
  }, [])

  if (toasts.length === 0) return null
  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            padding: '8px 16px',
            background: 'seagreen',
            color: '#fff',
            borderRadius: 4,
            fontSize: 13,
            boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
          }}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}

// ---- RGB stash panel (product surface) -------------------------------------
//
// Lists the NIA contracts this wallet has issued plus the transitions built
// over each. Data comes from `rgbStash.ts` (localStorage, npub-scoped).
// Issuance and transition building still happens in the Developer lab —
// this panel is read-only and exists so a user can see "what RGB state does
// my wallet hold" without diving into the lab UI.

function RgbStashPanel() {
  const [contracts, setContracts] = useState<StashContract[]>([])
  const [transitions, setTransitions] = useState<StashTransition[]>([])
  const [openContractId, setOpenContractId] = useState<string | null>(null)
  const [inbox, setInbox] = useState<InboxStatus | null>(null)

  useEffect(() => {
    const unsubscribe = subscribeStash((snap) => {
      setContracts(snap.contracts)
      setTransitions(snap.transitions)
    })
    return () => { unsubscribe() }
  }, [])

  useEffect(() => {
    const unsub = subscribeInbox((s) => { setInbox(s) })
    return () => { unsub() }
  }, [])

  // Discrete inbox dot: shows only on errors or while a tick is in
  // progress. Successful idle state is invisible — the user is notified
  // of accepted assets via <ToastHost />, not via this badge.
  function inboxDot() {
    if (!inbox || !inbox.attached) return null
    if (inbox.lastError) {
      return (
        <span
          style={{ fontSize: 11, marginLeft: 8, color: 'crimson' }}
          title={inbox.lastError}
        >
          ⚠ inbox error
        </span>
      )
    }
    if (inbox.inProgress) {
      return (
        <span
          style={{ fontSize: 11, marginLeft: 8, color: '#888' }}
          title='Checking for incoming assets'
        >
          ↻
        </span>
      )
    }
    return null
  }

  return (
    <fieldset style={{ marginTop: 16, border: '1px solid #ddd', padding: '8px 12px' }}>
      <legend style={{ fontSize: 12, color: '#666' }}>
        RGB assets · {contracts.length} contract{contracts.length === 1 ? '' : 's'}
        {transitions.length > 0 && (
          <> · {transitions.length} transition{transitions.length === 1 ? '' : 's'}</>
        )}
        {inboxDot()}
      </legend>
      {contracts.length === 0 ? (
        <div style={{ fontSize: 12, color: '#888', padding: '6px 0' }}>
          No RGB assets yet — issue a NIA contract from the Developer lab below.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {contracts.map((c) => {
            const txns = listTransitionsFor(c.contractId)
            const isOpen = openContractId === c.contractId
            return (
              <div
                key={c.contractId}
                style={{
                  border: '1px solid #eee',
                  padding: '6px 8px',
                  background: isOpen ? '#fafafa' : '#fff',
                }}
              >
                <div
                  onClick={() => setOpenContractId(isOpen ? null : c.contractId)}
                  style={{ cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}
                >
                  <span style={{ fontWeight: 'bold', fontSize: 13 }}>{c.ticker}</span>
                  <span style={{ fontSize: 12, color: '#666' }}>{c.name}</span>
                  <span style={{ fontSize: 11, color: '#888' }}>supply {c.supply}</span>
                  {txns.length > 0 && (
                    <span style={{ fontSize: 11, color: '#2a6' }}>
                      · {txns.length} transition{txns.length === 1 ? '' : 's'}
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#aaa' }}>{isOpen ? '▾' : '▸'}</span>
                </div>
                {isOpen && (
                  <div style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 11, color: '#555' }}>
                    <div style={{ wordBreak: 'break-all' }}>
                      <span style={{ color: '#888' }}>contractId:</span> {c.contractId}
                    </div>
                    <div>
                      <span style={{ color: '#888' }}>issued:</span> {c.createdAt}
                      {' · '}
                      <span style={{ color: '#888' }}>genesis:</span> {c.consignmentHex.length / 2} B
                    </div>
                    {txns.length > 0 && (
                      <div style={{ marginTop: 4 }}>
                        <div style={{ color: '#888' }}>transitions:</div>
                        {txns.map((t) => {
                          const outputsLabel = t.outputs.length === 1
                            ? `amount ${t.outputs[0].amount}`
                            : `outputs [${t.outputs.map((o) => o.amount).join(', ')}]`
                          return (
                            <div key={t.commitId} style={{ paddingLeft: 8, wordBreak: 'break-all' }}>
                              · {t.commitId.slice(0, 16)}… {outputsLabel}
                              {' · '}{t.transitionHex.length / 2} B
                              {' · '}{t.createdAt}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}

// ---- HTLC probe (Phase 1C R&D session 0) -----------------------------------
//
// Click-and-see test: does Spark's swapNodesForPreimage accept a call
// without a valid LN invoice? If yes, we have access to a generic HTLC
// primitive usable for trustless P2P atomic swap (the missing piece per
// feedback_trustless_is_non_negotiable). If no, the verbatim coordinator
// error tells us exactly what's being validated, narrowing the search.

function HtlcProbe() {
  const [smallestLeaf, setSmallestLeaf] = useState<
    { id: string; value: number } | null
  >(null)
  const [scanning, setScanning] = useState(false)
  const [scanErr, setScanErr] = useState<string | null>(null)
  const [probing, setProbing] = useState<InvoiceShape | 'reveal' | 'crossExpiry' | null>(null)
  const [crossPhase, setCrossPhase] = useState<string | null>(null)
  const [results, setResults] = useState<HtlcProbeResult[]>([])
  const [revealResults, setRevealResults] = useState<HtlcRevealProbeResult[]>([])
  const [crossResults, setCrossResults] = useState<HtlcCrossExpiryProbeResult[]>([])

  const scanForLeaf = useCallback(async () => {
    setScanning(true)
    setScanErr(null)
    try {
      const wallet = getSparkWallet()
      if (!wallet) throw new Error('wallet not initialized')
      const leaf = await pickSmallestLeaf(wallet)
      if (!leaf) {
        setSmallestLeaf(null)
        setScanErr('no leaves found — fund the wallet first')
      } else {
        setSmallestLeaf({ id: leaf.id, value: leaf.value })
      }
    } catch (e) {
      setScanErr(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void scanForLeaf()
  }, [scanForLeaf])

  async function runCrossExpiryProbe() {
    setProbing('crossExpiry')
    setCrossPhase('starting')
    try {
      const wallet = getSparkWallet()
      if (!wallet) throw new Error('wallet not initialized')
      const leaf = await pickSmallestLeaf(wallet)
      if (!leaf) throw new Error('no leaves available — fund the wallet first')
      const result = await probeHtlcCrossExpiry(wallet, leaf, setCrossPhase)
      setCrossResults((r) => [result, ...r].slice(0, 4))
    } catch (e) {
      setCrossResults((r) => [
        {
          leafId: '',
          leafValueSats: 0,
          recipientPubkeyHex: '',
          paymentHashHex: '',
          swapAccepted: false,
          swapError: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
          elapsedMs: 0,
          waitedMs: 0,
        },
        ...r,
      ].slice(0, 4))
    } finally {
      setProbing(null)
      setCrossPhase(null)
    }
  }

  async function runRevealProbe() {
    setProbing('reveal')
    try {
      const wallet = getSparkWallet()
      if (!wallet) throw new Error('wallet not initialized')
      const leaf = await pickSmallestLeaf(wallet)
      if (!leaf) throw new Error('no leaves available — fund the wallet first')
      const result = await probeHtlcReveal(wallet, leaf)
      setRevealResults((r) => [result, ...r].slice(0, 4))
    } catch (e) {
      setRevealResults((r) => [
        {
          leafId: '',
          leafValueSats: 0,
          paymentHashHex: '',
          preimageHex: '',
          swapAccepted: false,
          swapError: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
          elapsedMs: 0,
        },
        ...r,
      ].slice(0, 4))
    } finally {
      setProbing(null)
    }
  }

  async function runProbe(shape: InvoiceShape) {
    setProbing(shape)
    try {
      const wallet = getSparkWallet()
      if (!wallet) throw new Error('wallet not initialized')
      const leaf = await pickSmallestLeaf(wallet)
      if (!leaf) throw new Error('no leaves available — fund the wallet first')
      const result = await probeHtlc(wallet, leaf, shape)
      setResults((r) => [result, ...r].slice(0, 8))
    } catch (e) {
      // Top-level failure (e.g., wallet missing). Render as a synthetic result row.
      setResults((r) => [
        {
          shape,
          invoiceString: '',
          leafId: '',
          leafValueSats: 0,
          paymentHashHex: '',
          swapAccepted: false,
          swapError: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
          elapsedMs: 0,
        },
        ...r,
      ].slice(0, 8))
    } finally {
      setProbing(null)
    }
  }

  return (
    <fieldset style={{ marginTop: 10, border: '1px solid #ddd', padding: '8px 12px' }}>
      <legend style={{ fontSize: 12, color: '#666' }}>HTLC probe · Phase 1C R&D</legend>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        Tests whether <code>swapNodesForPreimage</code> accepts a non-LN call.
        Picks the smallest leaf; if probe succeeds, immediately unlocks with{' '}
        <code>providePreimage</code>. Worst case if both fail: leaf locked
        for ≤ 60 s.
      </div>

      <div style={{ fontSize: 12 }}>
        target leaf:{' '}
        {scanning ? (
          'scanning…'
        ) : scanErr ? (
          <span style={{ color: 'crimson' }}>{scanErr}</span>
        ) : smallestLeaf ? (
          <>
            <code>{smallestLeaf.id.slice(0, 10)}…</code> · {smallestLeaf.value}{' '}
            sats
          </>
        ) : (
          'unknown'
        )}{' '}
        <button onClick={() => void scanForLeaf()} disabled={scanning} style={{ fontSize: 11 }}>
          {scanning ? '…' : 'rescan'}
        </button>
      </div>

      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={() => void runProbe('empty')}
          disabled={probing !== null || !smallestLeaf}
        >
          {probing === 'empty' ? 'probing…' : 'Probe empty invoice'}
        </button>
        <button
          onClick={() => void runProbe('garbage')}
          disabled={probing !== null || !smallestLeaf}
        >
          {probing === 'garbage' ? 'probing…' : 'Probe garbage invoice'}
        </button>
        <button
          onClick={() => void runRevealProbe()}
          disabled={probing !== null || !smallestLeaf}
        >
          {probing === 'reveal' ? 'probing…' : 'Probe reveal + read-back'}
        </button>
        <button
          onClick={() => void runCrossExpiryProbe()}
          disabled={probing !== null || !smallestLeaf}
          title="Locks smallest leaf to a throwaway recipient for 60s; verifies auto-refund."
        >
          {probing === 'crossExpiry' ? 'probing…' : 'Probe cross-recv + expiry (~70s)'}
        </button>
      </div>
      {crossPhase && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#666' }}>
          phase: <em>{crossPhase}</em>
        </div>
      )}

      {results.length > 0 && (
        <div style={{ marginTop: 10, fontFamily: 'monospace', fontSize: 11 }}>
          {results.map((r, i) => (
            <div
              key={i}
              style={{
                borderTop: i === 0 ? 'none' : '1px dashed #eee',
                padding: '6px 0',
                color: r.swapAccepted ? 'seagreen' : '#444',
              }}
            >
              <div>
                <strong>{r.shape}</strong> · {r.elapsedMs} ms ·{' '}
                {r.swapAccepted ? '🟢 swap ACCEPTED' : '🔴 swap rejected'}
              </div>
              <div style={{ color: '#888' }}>
                paymentHash: {r.paymentHashHex.slice(0, 16)}…
              </div>
              {r.swapAccepted && (
                <div>
                  unlock:{' '}
                  {r.unlockAccepted
                    ? '🟢 providePreimage OK'
                    : `🔴 providePreimage failed (${r.unlockError ?? '?'})`}
                </div>
              )}
              {r.swapError && (
                <div style={{ wordBreak: 'break-all', color: '#a00' }}>
                  error: {r.swapError}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {revealResults.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 6, borderTop: '1px solid #ccc', fontFamily: 'monospace', fontSize: 11 }}>
          <div style={{ fontWeight: 'bold', marginBottom: 4 }}>reveal probes:</div>
          {revealResults.map((r, i) => (
            <div
              key={i}
              style={{
                borderTop: i === 0 ? 'none' : '1px dashed #eee',
                padding: '6px 0',
              }}
            >
              <div>
                <strong>reveal</strong> · {r.elapsedMs} ms ·{' '}
                {r.swapAccepted
                  ? r.unlockAccepted
                    ? '🟢 swap + unlock OK'
                    : '🟡 swap OK, unlock failed'
                  : '🔴 swap rejected'}
              </div>
              <div style={{ color: '#888' }}>
                paymentHash: {r.paymentHashHex.slice(0, 16)}…
              </div>
              {r.swapError && (
                <div style={{ color: '#a00', wordBreak: 'break-all' }}>swap error: {r.swapError}</div>
              )}
              {r.unlockError && (
                <div style={{ color: '#a00', wordBreak: 'break-all' }}>unlock error: {r.unlockError}</div>
              )}
              {r.queryPreimageReturnedRaw !== undefined && (
                <div style={{ color: r.queryPreimageReturnedSameP ? 'seagreen' : '#c80' }}>
                  query_preimage: {r.queryPreimageReturnedSameP
                    ? '🟢 returned matching P'
                    : `⚠ returned ${r.queryPreimageReturnedRaw.slice(0, 16)}… vs expected ${r.preimageHex.slice(0, 16)}…`}
                </div>
              )}
              {r.queryPreimageError && (
                <div style={{ color: '#a00', wordBreak: 'break-all' }}>query_preimage error: {r.queryPreimageError}</div>
              )}
              {r.queryHtlcCount !== undefined && (
                <div>
                  query_htlc: count={r.queryHtlcCount}
                  {r.queryHtlcStatus && <> · {r.queryHtlcStatus}</>}
                </div>
              )}
              {r.queryHtlcError && (
                <div style={{ color: '#a00', wordBreak: 'break-all' }}>query_htlc error: {r.queryHtlcError}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {crossResults.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 6, borderTop: '1px solid #ccc', fontFamily: 'monospace', fontSize: 11 }}>
          <div style={{ fontWeight: 'bold', marginBottom: 4 }}>cross-receiver + expiry probes:</div>
          {crossResults.map((r, i) => {
            const statusLabel = r.postExpiryStatus === 0 ? 'WAITING'
              : r.postExpiryStatus === 1 ? 'PREIMAGE_SHARED'
              : r.postExpiryStatus === 2 ? 'RETURNED'
              : `unknown(${r.postExpiryStatus})`
            return (
              <div
                key={i}
                style={{
                  borderTop: i === 0 ? 'none' : '1px dashed #eee',
                  padding: '6px 0',
                }}
              >
                <div>
                  <strong>cross+expiry</strong> · {r.elapsedMs} ms ·{' '}
                  {r.swapAccepted
                    ? '🟢 cross-receiver lock accepted'
                    : '🔴 cross-receiver lock rejected'}
                </div>
                {r.swapError && (
                  <div style={{ color: '#a00', wordBreak: 'break-all' }}>swap error: {r.swapError}</div>
                )}
                {r.swapAccepted && (
                  <>
                    <div style={{ color: '#888' }}>
                      recipient: {r.recipientPubkeyHex.slice(0, 16)}… (throwaway)
                    </div>
                    {r.postExpiryStatus !== undefined && (
                      <div style={{ color: r.postExpiryStatus === 2 ? 'seagreen' : '#c80' }}>
                        post-expiry status: {statusLabel}
                        {r.postExpiryStatus === 2 ? ' 🟢' : ' ⚠'}
                      </div>
                    )}
                    {r.postExpiryStatusError && (
                      <div style={{ color: '#a00' }}>status query error: {r.postExpiryStatusError}</div>
                    )}
                    {r.leafBackInWallet !== undefined && (
                      <div style={{ color: r.leafBackInWallet ? 'seagreen' : '#c80' }}>
                        leaf back in wallet: {r.leafBackInWallet ? '🟢 yes' : '⚠ no'}
                      </div>
                    )}
                    {r.leafBackError && (
                      <div style={{ color: '#a00' }}>leaf check error: {r.leafBackError}</div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}

// ---- Self-swap smoke test (Phase 1C session 1) -----------------------------
//
// Walks the seller-side state machine end-to-end on a single wallet by
// using SELF-RECEIVE: the seller locks her leaf to her OWN identity pubkey.
// The same lock is then discovered by `queryPendingHtlcs(role='receiver')`
// (because we ARE the receiver), and revealed via `revealAndClaim`.
//
// Why self-receive and not two locks under the same H: the Spark coordinator
// enforces `(senderIdentityPublicKey, paymentHash)` uniqueness — a single
// sender can't post two preimage requests under the same H. Multiple senders
// under the same H is fine (and required for the real cross-wallet flow,
// Lightning-routing style). See reference_spark_htlc_primitive memory.
//
// What this test proves:
//   - The state machine transitions phases correctly (preparing → locking
//     → locked → awaiting-counterparty → revealing → completed).
//   - `lockUnderHash` accepts a self-receive call.
//   - `queryPendingHtlcs(role='receiver', paymentHashes=[H])` finds the
//     just-created lock.
//   - `revealAndClaim` succeeds on a self-receive lock.
// Cross-wallet semantics (different sender + receiver pubkeys) were already
// validated in HTLC probe 3 (cross-receiver + expiry). This test focuses
// on the state machine plumbing of the orchestrator module.

function HtlcSelfSwap() {
  const [running, setRunning] = useState(false)
  const [stateLog, setStateLog] = useState<SwapState[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)

  async function runTest() {
    setRunning(true)
    setErr(null)
    setOutcome(null)
    setStateLog([])
    try {
      const wallet = getSparkWallet()
      if (!wallet) throw new Error('wallet not initialized')

      const allLeaves = await (wallet as unknown as {
        getLeaves: (b?: boolean) => Promise<Array<{ id: string; value: number }>>
      }).getLeaves(true)
      if (allLeaves.length === 0) {
        throw new Error('no leaves available — fund the wallet first')
      }
      const assetLeaf = ([...allLeaves].sort((a, b) => a.value - b.value)[0] as unknown) as Parameters<typeof lockUnderHash>[1]['leaves'][number]

      const { preimage } = newPreimagePair()
      const identityPubkeyBytes = await (wallet as unknown as {
        config: { signer: { getIdentityPublicKey: () => Promise<Uint8Array> } }
      }).config.signer.getIdentityPublicKey()

      // T_seller_expiry kept short (5 min) for this single-wallet test;
      // the real cross-wallet flow uses larger values with a delta of ~30
      // min between seller and buyer expiries.
      const sellerExpiry = new Date(Date.now() + 5 * 60_000)

      const result = await runSellerFlow(wallet, {
        assetLeaves: [assetLeaf],
        // Self-receive: the seller's lock counts as her own incoming HTLC,
        // letting the awaiting-counterparty polling loop close immediately.
        counterpartyPubkey: identityPubkeyBytes,
        expectedSatsFromBuyer: (assetLeaf as { value: number }).value,
        expiryTime: sellerExpiry,
        preimage,
        pollIntervalMs: 1_500,
        onState: (s) => {
          setStateLog((prev) => [...prev, s])
        },
      })
      setOutcome(result.outcome)
      // Log the preimage match for verification.
      if (result.outcome === 'completed') {
        const expectedHex = htlcBytesToHex(preimage)
        if (result.state.revealedPreimageHex === expectedHex) {
          setStateLog((prev) => [
            ...prev,
            {
              ...result.state,
              message: `🟢 revealed preimage matches generated preimage (${expectedHex.slice(0, 16)}…)`,
              updatedAt: new Date().toISOString(),
            },
          ])
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <fieldset style={{ marginTop: 10, border: '1px solid #ddd', padding: '8px 12px' }}>
      <legend style={{ fontSize: 12, color: '#666' }}>
        Self-swap smoke test · Phase 1C session 1
      </legend>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        Runs <code>runSellerFlow</code> end-to-end with self-receive:
        the seller locks one leaf to her own identity, the same lock is
        seen as "incoming" by the polling loop, then reveal+claim closes
        it. Validates the orchestrator state machine without needing
        two wallets. ~5 s for the full state walk.
      </div>
      <button onClick={() => void runTest()} disabled={running}>
        {running ? 'running…' : 'Run seller-flow self-swap'}
      </button>
      {err && (
        <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 11 }}>
          {err}
        </pre>
      )}
      {stateLog.length > 0 && (
        <div style={{ marginTop: 10, fontFamily: 'monospace', fontSize: 11 }}>
          <div style={{ fontWeight: 'bold', marginBottom: 4 }}>
            state transitions · paymentHash:{' '}
            <span style={{ fontWeight: 'normal', color: '#666' }}>
              {stateLog[0].paymentHashHex.slice(0, 16)}…
            </span>
          </div>
          {stateLog.map((s, i) => (
            <div
              key={i}
              style={{
                borderTop: i === 0 ? 'none' : '1px dashed #eee',
                padding: '3px 0',
                color:
                  s.phase === 'completed' ? 'seagreen' :
                  s.phase === 'expired' ? '#c80' :
                  s.phase === 'failed' ? 'crimson' :
                  '#444',
              }}
            >
              <strong>{s.phase}</strong> · {s.message}
            </div>
          ))}
          {outcome && (
            <div
              style={{
                marginTop: 6,
                padding: 6,
                background:
                  outcome === 'completed' ? '#e8f5e9' :
                  outcome === 'expired' ? '#fff8e1' : '#ffebee',
                border:
                  outcome === 'completed' ? '1px solid #a5d6a7' :
                  outcome === 'expired' ? '1px solid #ffe082' : '1px solid #ef9a9a',
              }}
            >
              outcome: <strong>{outcome}</strong>
            </div>
          )}
        </div>
      )}
    </fieldset>
  )
}

// ---- Settlement auto-emit probe (Phase 1C/clean session 5.1) ----------------
//
// Bridge-readiness probe for the upcoming "settlement-coupled consignment
// auto-emit" path. Given a leafId the wallet still has a pathTweak entry
// for + a buyer's npub, displays:
//   - Whether the pathTweak entry carries the RGB payload we'd need to
//     build T_2 over T_1 (transitionHex + prevGenesisHex) OR the genesis
//     consignment for a depth-2 chain (consignmentHex).
//   - The exact relay URL that would receive the auto-emitted envelope
//     after `runSellerFlow` completes on a matched ask.
// NO emission yet — this is read-only state inspection to confirm the
// post-settlement lookup returns what session 5.2 needs to build T_2.
//
// Why a standalone panel instead of hooking into OrderRow's `runMySwap`:
// the post-settlement window in a real swap is brief and depends on a live
// matched order. A standalone probe lets us validate the lookup in isolation
// against the persisted pathTweaks, including across reloads.

interface SettlementAutoEmitProbeProps {
  myNpub: string
  myNostrPrivkeyHex: string
  mySparkIdentityPubkey: string
}

function SettlementAutoEmitProbe({
  myNpub,
  myNostrPrivkeyHex,
  mySparkIdentityPubkey,
}: SettlementAutoEmitProbeProps) {
  const [allTweaks, setAllTweaks] = useState(() => listPathTweaks())
  const [selectedLeafId, setSelectedLeafId] = useState<string>('')
  const [buyerNpub, setBuyerNpub] = useState<string>('')
  const [npubError, setNpubError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<SettlementSnapshot | null>(null)
  const [snapshotErr, setSnapshotErr] = useState<string | null>(null)
  const [emitting, setEmitting] = useState(false)
  const [emitResult, setEmitResult] = useState<AutoEmitOutcome | null>(null)
  // Phase 1C/clean session 7.3b: user input for the partial-fill amount.
  // String form so empty input stays distinguishable from 0. On submit we
  // parse to bigint and validate against snapshot.amount.
  const [buyerAmountInput, setBuyerAmountInput] = useState<string>('')
  const [buyerAmountErr, setBuyerAmountErr] = useState<string | null>(null)

  useEffect(() => {
    // Same polling cadence as PathTweaksDebug — pathTweaks is module-level
    // state with no subscription exposed.
    const t = setInterval(() => setAllTweaks(listPathTweaks()), 2_000)
    return () => clearInterval(t)
  }, [])

  // Monotonic counter via ref — discards stale captures when the user picks a
  // new leaf before the previous capture resolves. A useState counter would
  // hit closure-staleness because the handler re-renders before the await.
  const captureGenRef = useRef(0)

  async function onLeafChange(newId: string) {
    const myGen = ++captureGenRef.current
    setSelectedLeafId(newId)
    setSnapshot(null)
    setSnapshotErr(null)
    setEmitResult(null)
    setBuyerAmountInput('')
    setBuyerAmountErr(null)
    if (!newId) return
    const r = await captureSettlementSnapshot(newId)
    if (myGen !== captureGenRef.current) return // a newer capture started
    if (r.ok) {
      setSnapshot(r.snapshot)
      setSnapshotErr(null)
      // Default to a full transfer; user can edit down for partial fill.
      setBuyerAmountInput(r.snapshot.amount.toString())
    } else {
      setSnapshot(null)
      setSnapshotErr(r.reason)
    }
  }

  function onBuyerAmountChange(s: string) {
    setBuyerAmountInput(s)
    if (!snapshot || s.trim() === '') {
      setBuyerAmountErr(null)
      return
    }
    if (!/^[0-9]+$/.test(s.trim())) {
      setBuyerAmountErr('must be a non-negative integer')
      return
    }
    const v = BigInt(s.trim())
    if (v <= 0n) {
      setBuyerAmountErr('must be > 0')
      return
    }
    if (v > snapshot.amount) {
      setBuyerAmountErr(`exceeds leaf holding (${snapshot.amount})`)
      return
    }
    setBuyerAmountErr(null)
  }

  const buyerAmountOk =
    snapshot !== null &&
    buyerAmountInput.trim() !== '' &&
    buyerAmountErr === null

  const splitPreview: { buyer: bigint; change: bigint } | null =
    snapshot && buyerAmountOk
      ? (() => {
          const buyer = BigInt(buyerAmountInput.trim())
          return { buyer, change: snapshot.amount - buyer }
        })()
      : null

  // Only entries with an RGB payload are emit-ready. A pathTweak with neither
  // transitionHex nor consignmentHex means the leaf was bound to some msg the
  // wallet doesn't know how to forward as a stash mutation.
  const emitReady = allTweaks.filter(
    (t) => t.transitionHex !== undefined || t.consignmentHex !== undefined,
  )

  function bytesToHex(b: Uint8Array): string {
    let s = ''
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
    return s
  }

  function validateNpub(s: string): { ok: true; npub: string } | { ok: false; err: string } {
    try {
      const decoded = nip19.decode(s.trim())
      if (decoded.type !== 'npub') {
        return { ok: false, err: `expected npub-prefixed key, got ${decoded.type}` }
      }
      return { ok: true, npub: s.trim() }
    } catch (e) {
      return { ok: false, err: e instanceof Error ? e.message : String(e) }
    }
  }

  function onNpubChange(s: string) {
    setBuyerNpub(s)
    if (s.trim() === '') {
      setNpubError(null)
      return
    }
    const v = validateNpub(s)
    setNpubError(v.ok ? null : v.err)
  }

  const selected = selectedLeafId
    ? (getPathTweak(selectedLeafId) ?? null)
    : null

  // Compute the relay base URL the same way consignmentRelay.ts does, so what
  // the probe displays matches what a future emitter would actually POST to.
  const relayBase =
    typeof window !== 'undefined' && window.location.hostname === 'localhost'
      ? 'http://localhost:5180'
      : '/relay'
  const buyerNpubOk = buyerNpub.trim() !== '' && npubError === null
  const wouldPostUrl = buyerNpubOk
    ? `${relayBase}/consignment/${buyerNpub.trim()}`
    : null

  const payloadKind: 'transition' | 'genesis' | 'none' = selected
    ? selected.transitionHex
      ? 'transition'
      : selected.consignmentHex
        ? 'genesis'
        : 'none'
    : 'none'

  return (
    <fieldset style={{ marginTop: 10, border: '1px solid #ddd', padding: '8px 12px' }}>
      <legend style={{ fontSize: 12, color: '#666' }}>
        Settlement auto-emit probe · Phase 1C/clean session 5.2
      </legend>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        Given a leaf still bound by pathTweaks + a target buyer npub,
        simulate the settlement auto-emit: build T_new on top of the
        recovered chain, compose a BIP-340-signed envelope v4 with{' '}
        <code>kind: settlement-consignment-v1</code>, POST to{' '}
        <code>/consignment/&lt;buyerNpub&gt;</code>. The leaf does NOT need
        to have been sold — this is a dry-run-flavored real emission so
        session 5.3's buyer-side poll can validate its end-to-end shape.
      </div>

      <div style={{ fontSize: 11, color: '#555', marginBottom: 6 }}>
        Bound leaves with emit-ready payload: <strong>{emitReady.length}</strong>{' '}
        / {allTweaks.length} pathTweak entries.
      </div>

      <label style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
        leafId (pick a bound leaf to inspect)
      </label>
      <select
        value={selectedLeafId}
        onChange={(e) => void onLeafChange(e.target.value)}
        style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, padding: 4 }}
      >
        <option value=''>— select —</option>
        {emitReady.map((t) => {
          const payload = t.transitionHex ? 'transition' : 'genesis'
          return (
            <option key={t.currentLeafId} value={t.currentLeafId}>
              {t.currentLeafId.slice(0, 12)}…{t.currentLeafId.slice(-6)} · {payload} · msg={bytesToHex(t.msg).slice(0, 12)}…
            </option>
          )
        })}
        {allTweaks.length > emitReady.length && (
          <optgroup label='entries without RGB payload (not emit-ready)'>
            {allTweaks
              .filter((t) => !t.transitionHex && !t.consignmentHex)
              .map((t) => (
                <option key={t.currentLeafId} value={t.currentLeafId}>
                  {t.currentLeafId.slice(0, 12)}…{t.currentLeafId.slice(-6)} · no payload
                </option>
              ))}
          </optgroup>
        )}
      </select>

      <label style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
        buyer npub (paste from a matched order's counterparty)
      </label>
      <input
        value={buyerNpub}
        onChange={(e) => onNpubChange(e.target.value)}
        placeholder='npub1…'
        style={{
          width: '100%',
          fontFamily: 'monospace',
          fontSize: 11,
          padding: 4,
          boxSizing: 'border-box',
          borderColor: npubError ? 'crimson' : undefined,
        }}
      />
      {npubError && (
        <div style={{ fontSize: 11, color: 'crimson', marginTop: 2 }}>{npubError}</div>
      )}

      {selected && (
        <div
          style={{
            marginTop: 10,
            padding: 8,
            background:
              payloadKind === 'none' ? '#fff8e1' : '#e8f5e9',
            border:
              payloadKind === 'none'
                ? '1px solid #ffe082'
                : '1px solid #a5d6a7',
            fontSize: 11,
            fontFamily: 'monospace',
            wordBreak: 'break-all',
          }}
        >
          <div style={{ marginBottom: 4, fontWeight: 'bold' }}>
            {payloadKind === 'none'
              ? '⚠ pathTweak found but no RGB payload — bridge NOT ready'
              : '🟢 bridge ready · payload kind: ' + payloadKind}
          </div>
          <div>sourcePath: {selected.sourcePath.slice(0, 16)}…{selected.sourcePath.slice(-6)}</div>
          <div>msg ({selected.msg.length}B): {bytesToHex(selected.msg)}</div>
          <div>uBase ({selected.uBase.length}B): {bytesToHex(selected.uBase).slice(0, 32)}…{bytesToHex(selected.uBase).slice(-8)}</div>
          {selected.transitionHex && (
            <div>
              transitionHex: {selected.transitionHex.length / 2} bytes (hex
              len {selected.transitionHex.length})
            </div>
          )}
          {selected.prevGenesisHex && (
            <div>
              prevGenesisHex: {selected.prevGenesisHex.length / 2} bytes (hex
              len {selected.prevGenesisHex.length})
            </div>
          )}
          {selected.consignmentHex && (
            <div>
              consignmentHex: {selected.consignmentHex.length / 2} bytes (hex
              len {selected.consignmentHex.length})
            </div>
          )}
        </div>
      )}

      {wouldPostUrl && selected && payloadKind !== 'none' && (
        <div
          style={{
            marginTop: 8,
            padding: 6,
            background: '#f5f5f5',
            border: '1px dashed #bbb',
            fontSize: 11,
            fontFamily: 'monospace',
            color: '#444',
            wordBreak: 'break-all',
          }}
        >
          <div style={{ marginBottom: 2, color: '#666' }}>relay URL the emit will hit:</div>
          {wouldPostUrl}
        </div>
      )}

      {snapshotErr && selectedLeafId && (
        <div
          style={{
            marginTop: 8,
            padding: 6,
            background: '#ffebee',
            border: '1px solid #ef9a9a',
            fontSize: 11,
            color: 'crimson',
          }}
        >
          snapshot failed: {snapshotErr}
        </div>
      )}

      {snapshot && (
        <div
          style={{
            marginTop: 8,
            padding: 6,
            background: '#f1f8e9',
            border: '1px solid #c5e1a5',
            fontSize: 11,
            fontFamily: 'monospace',
            wordBreak: 'break-all',
          }}
        >
          <div style={{ marginBottom: 4, color: '#33691e', fontWeight: 'bold' }}>
            snapshot captured · ready to emit
          </div>
          <div>contractId: {snapshot.contractId}</div>
          <div>leaf holding: {snapshot.amount.toString()} units</div>
          <div>operator: {snapshot.operatorPublicKeyHex.slice(0, 16)}…{snapshot.operatorPublicKeyHex.slice(-8)}</div>
          <div>verifyingKey: {snapshot.verifyingPublicKeyHex.slice(0, 16)}…{snapshot.verifyingPublicKeyHex.slice(-8)}</div>
          <div>
            chain: genesis ({snapshot.genesisHex.length / 2}B)
            {snapshot.prevTransitionHex && (
              <>
                {' '}→ prevTransition ({snapshot.prevTransitionHex.length / 2}B)
              </>
            )}
            {' '}→ T_new (built on emit)
          </div>
        </div>
      )}

      {snapshot && (
        <>
          <label style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
            buyer amount (units to transfer · ≤ leaf holding)
          </label>
          <input
            value={buyerAmountInput}
            onChange={(e) => onBuyerAmountChange(e.target.value)}
            inputMode='numeric'
            placeholder={snapshot.amount.toString()}
            style={{
              width: 200,
              fontFamily: 'monospace',
              fontSize: 11,
              padding: 4,
              borderColor: buyerAmountErr ? 'crimson' : undefined,
            }}
          />
          {buyerAmountErr && (
            <div style={{ fontSize: 11, color: 'crimson', marginTop: 2 }}>{buyerAmountErr}</div>
          )}
          {splitPreview && splitPreview.change > 0n && (
            <div style={{ fontSize: 11, color: '#666', marginTop: 4, fontFamily: 'monospace' }}>
              split: <strong>{splitPreview.buyer.toString()}</strong> to buyer ·{' '}
              <strong>{splitPreview.change.toString()}</strong> change leaf for you
            </div>
          )}
          {splitPreview && splitPreview.change === 0n && (
            <div style={{ fontSize: 11, color: '#666', marginTop: 4, fontFamily: 'monospace' }}>
              full transfer: no change leaf
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 10 }}>
        <button
          onClick={() => {
            if (!snapshot || !buyerNpubOk || !buyerAmountOk) return
            const orderAmount = BigInt(buyerAmountInput.trim())
            setEmitting(true)
            setEmitResult(null)
            void (async () => {
              const r = await runAutoEmit({
                snapshot,
                myNpub,
                myNostrPrivkeyHex,
                mySparkIdentityPubkey,
                buyerNpub: buyerNpub.trim(),
                orderAmount,
              })
              setEmitResult(r)
              setEmitting(false)
            })()
          }}
          disabled={emitting || !snapshot || !buyerNpubOk || !buyerAmountOk}
          style={{ fontSize: 12 }}
        >
          {emitting ? 'emitting…' : 'Simulate emit (build + sign + POST)'}
        </button>
        {!snapshot && selectedLeafId && !snapshotErr && (
          <span style={{ marginLeft: 8, fontSize: 11, color: '#999' }}>capturing…</span>
        )}
      </div>

      {emitResult && emitResult.status === 'emitted' && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            background: '#e8f5e9',
            border: '1px solid #a5d6a7',
            fontSize: 11,
            fontFamily: 'monospace',
            wordBreak: 'break-all',
          }}
        >
          <div style={{ marginBottom: 4, color: 'seagreen', fontWeight: 'bold' }}>
            🟢 emitted · envelope queued at relay
          </div>
          <div>envelopeId: {emitResult.envelopeId}</div>
          <div>bytes posted: {emitResult.bytesPosted}</div>
          <div>newCommitIdHex: {emitResult.newCommitIdHex}</div>
          <div>payload: {emitResult.payloadKind}</div>
          <div>
            outputs: {emitResult.outputCount}
            {emitResult.outputCount > 1 && (
              <>
                {' · buyerIndex='}{emitResult.buyerOutputIndex}
                {' · change='}{emitResult.changeAmount.toString()}
              </>
            )}
          </div>
          {emitResult.changeLeafId && (
            <div style={{ color: '#33691e' }}>
              ↳ change leaf minted: {emitResult.changeLeafId.slice(0, 12)}…{emitResult.changeLeafId.slice(-6)}
            </div>
          )}
          {emitResult.postEmitWarning && (
            <div style={{ color: '#c80', marginTop: 4 }}>
              ⚠ {emitResult.postEmitWarning}
            </div>
          )}
        </div>
      )}

      {emitResult && emitResult.status === 'failed' && (
        <div
          style={{
            marginTop: 8,
            padding: 6,
            background: '#ffebee',
            border: '1px solid #ef9a9a',
            fontSize: 11,
            color: 'crimson',
          }}
        >
          emit failed: {emitResult.reason}
        </div>
      )}
    </fieldset>
  )
}

// ---- Path tweaks debug panel ------------------------------------------------
//
// Displays the current pathTweaks map. Useful to check that persistence is
// loading entries at boot — a count of 0 right after reload means
// localStorage wasn't read or was empty.

function PathTweaksDebug() {
  const [tweaks, setTweaks] = useState(() => listPathTweaks())

  useEffect(() => {
    // Re-poll every 2s — pathTweaks is a module-level Map with no event
    // subscription exposed here, so polling is the simplest way to keep the
    // debug view in sync without coupling to the signer's listener API.
    const t = setInterval(() => setTweaks(listPathTweaks()), 2000)
    return () => clearInterval(t)
  }, [])

  const raw = (() => {
    try {
      return localStorage.getItem('rgbspark.pathTweaks.v1') ?? '(empty)'
    } catch {
      return '(localStorage error)'
    }
  })()

  return (
    <details style={{ marginTop: 8, fontSize: 12 }}>
      <summary>pathTweaks debug · in-memory: {tweaks.length} entries</summary>
      <div style={{ marginTop: 6, padding: 6, background: '#fafafa', border: '1px solid #eee' }}>
        <div style={{ marginBottom: 4, color: '#666' }}>in-memory entries:</div>
        {tweaks.length === 0 && <div style={{ color: '#999' }}>(none)</div>}
        {tweaks.map((t) => (
          <div key={t.currentLeafId} style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' }}>
            {t.currentLeafId.slice(0, 10)}…{t.currentLeafId.slice(-4)} ← from{' '}
            {t.sourcePath.slice(0, 10)}…{t.sourcePath.slice(-4)}
          </div>
        ))}
        <div style={{ marginTop: 6, color: '#666' }}>localStorage raw (truncated):</div>
        <div style={{ fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all' }}>
          {raw.length > 300 ? raw.slice(0, 300) + '…' : raw}
        </div>
      </div>
    </details>
  )
}

// ---- Claim L1 Deposit (vanilla, no RGB intent) ------------------------------
//
// Materializes an L1 deposit as a regular Spark leaf without applying any
// Spark-UTK tweak. Used for two purposes: (a) sanity-test that the deposit
// path itself works end-to-end on this wallet, (b) recover funds after a
// failed UTK-at-claim attempt (see project_spark_deposit_owner_check.md —
// the SE rejects tweaks during finalize_deposit_tree_creation, so the
// intent-active claim aborts and the deposit must be re-claimed clean).

function ClaimL1DepositVanilla() {
  const [txid, setTxid] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ totalSats: number; leafCount: number } | null>(null)

  async function claim() {
    setErr(null)
    setResult(null)
    setBusy(true)
    try {
      clearRgbIntent()
      const cleanTxid = txid.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
      if (cleanTxid.length !== 64) {
        throw new Error(`txid must be 64 hex chars — got ${cleanTxid.length} after stripping non-hex`)
      }
      const c = await claimL1Deposit(cleanTxid)
      setResult({ totalSats: c.totalSats, leafCount: c.leafCount })
      setTxid('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{ marginTop: 24, borderTop: '1px solid #ddd', paddingTop: 12 }}>
      <h2 style={{ margin: '0 0 4px' }}>Claim L1 deposit (no intent)</h2>
      <p style={{ color: '#666', marginTop: 0, fontSize: 13 }}>
        Materialize a confirmed L1 deposit as a vanilla Spark leaf — no
        Spark-UTK tweak. Use this to recover funds after an aborted Mint, or
        to seed a leaf for a later transfer-based UTK experiment.
      </p>

      <label style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
        funding txid (64 hex)
      </label>
      <input
        value={txid}
        onChange={(e) => setTxid(e.target.value)}
        placeholder="txid of the confirmed L1 deposit"
        style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: 6, boxSizing: 'border-box' }}
        disabled={busy}
      />

      <div style={{ marginTop: 10 }}>
        <button onClick={() => void claim()} disabled={busy || !txid.trim()}>
          {busy ? 'claiming…' : 'Claim (no intent)'}
        </button>
      </div>

      {err && (
        <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 12 }}>
          {err}
        </pre>
      )}

      {result && (
        <div style={{ marginTop: 10, padding: 8, background: '#e8f5e9', border: '1px solid #a5d6a7', fontSize: 13 }}>
          claimed <b>{result.totalSats} sats</b> across <b>{result.leafCount}</b> leaf
          {result.leafCount === 1 ? '' : 's'}. Balance should refresh; drain via Send to Spark if you want to evacuate.
        </div>
      )}
    </section>
  )
}

// ---- Send to Spark ----------------------------------------------------------
//
// Lets the user evacuate sats out of this wallet to any other Spark address
// (e.g. back to a ppwallet sparkAddress) without going through L1. Useful
// after dropping a few ksats into the depositAddress for testing — the leaves
// remain spendable and can be drained at any time.

function SendToSpark() {
  const [receiver, setReceiver] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [transferId, setTransferId] = useState<string | null>(null)

  async function send() {
    setErr(null)
    setTransferId(null)
    setBusy(true)
    try {
      const r = receiver.trim()
      if (!r) throw new Error('receiver sparkAddress is empty')
      const sats = Number(amount)
      if (!Number.isInteger(sats) || sats <= 0) {
        throw new Error('amount must be a positive integer (sats)')
      }
      const id = await transferToSpark(sats, r)
      setTransferId(id)
      setAmount('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{ marginTop: 24, borderTop: '1px solid #ddd', paddingTop: 12 }}>
      <h2 style={{ margin: '0 0 4px' }}>Send to Spark</h2>
      <p style={{ color: '#666', marginTop: 0, fontSize: 13 }}>
        Spark → Spark transfer (no L1 hop). Drain leaves to another wallet —
        e.g. a ppwallet sparkAddress — after testing.
      </p>

      <label style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
        receiver sparkAddress
      </label>
      <input
        value={receiver}
        onChange={(e) => setReceiver(e.target.value)}
        placeholder="sp1…"
        style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: 6, boxSizing: 'border-box' }}
        disabled={busy}
      />

      <label style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
        amount (sats)
      </label>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="1000"
        inputMode="numeric"
        style={{ width: 160, fontFamily: 'monospace', fontSize: 12, padding: 6 }}
        disabled={busy}
      />

      <div style={{ marginTop: 10 }}>
        <button
          onClick={() => void send()}
          disabled={busy || !receiver.trim() || !amount.trim()}
        >
          {busy ? 'sending…' : 'Send'}
        </button>
      </div>

      {err && (
        <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 12 }}>
          {err}
        </pre>
      )}

      {transferId && (
        <div style={{ marginTop: 10, padding: 8, background: '#e8f5e9', border: '1px solid #a5d6a7', fontSize: 13 }}>
          sent · transferId{' '}
          <code style={{ fontSize: 12 }}>{transferId}</code>
        </div>
      )}
    </section>
  )
}

// ---- Spark-UTK Mint via self-transfer (chunk-α-bis rev v2) ------------------
//
// Picks an existing vanilla leaf, sends it to our own sparkAddress, and during
// the receiver-side claim the RgbAwareSparkSigner applies the Spark-UTK tweak
// to the destination key. The SE persists a new leaf with
//   verifyingPublicKey = U_tweaked + operator
//        where U_tweaked = U_base + tagged_hash("Spark-RGB-UTK-v1", U_base‖msg)·G
// which we re-derive client-side and compare to confirm the binding.
//
// We use this path (not claimDeposit) because tweaking during L1 deposit
// finalization is rejected by the SE — see project_spark_deposit_owner_check.md.

interface MintViaTransferResult {
  leafBefore: { uBase: string; verifyingKey: string }
  leaf: SparkLeafRow
  msgHex: string
  expectedVerifyingKey: string
  match: boolean
  vanillaWouldMatch: boolean
  transferId: string
}

// Payload shape produced by IssueNiaInline / BuildTransitionInline and
// consumed by the mint flow when stitching together the persistent
// pathTweaks entry.
type PendingRgbPayload =
  | { kind: 'genesis'; consignmentHex: string; assetKind?: 'nia' | 'uda' }
  | { kind: 'transition'; transitionHex: string; prevGenesisHex: string }

function SparkUtkMintViaTransfer({ rootSeed }: { rootSeed: Uint8Array }) {
  const [core, setCore] = useState<SparkCore | null>(null)
  const [coreErr, setCoreErr] = useState<string | null>(null)
  const [leaves, setLeaves] = useState<SparkLeafRow[]>([])
  const [selectedLeafId, setSelectedLeafId] = useState('')
  const [msgHex, setMsgHex] = useState('')
  // When the msg came from an NIA issuance or a NIA transition, this holds
  // the bytes that need to travel with the proof so the receiver can replay
  // the RGB layer client-side. Cleared whenever the user touches msg manually.
  const [pendingRgb, setPendingRgb] = useState<PendingRgbPayload | null>(null)
  // Last successful NIA issuance kept here so the transition panel can chain
  // on top of it without the user having to paste the hex around. Hydrated
  // from the persisted stash on mount so the chain survives reloads.
  // Real L1 UTXO funded via FamilierDepositInline, once confirmed. Feeds
  // IssueUdaInline as the genesis-seal outpoint instead of a placeholder.
  const [familierUtxo, setFamilierUtxo] = useState<{ txid: string; vout: number } | null>(null)
  const [lastIssuance, setLastIssuance] = useState<
    { contractId: string; consignmentHex: string; supply: bigint } | null
  >(() => {
    const contracts = listContracts()
    if (contracts.length === 0) return null
    const latest = contracts[contracts.length - 1]
    return {
      contractId: latest.contractId,
      consignmentHex: latest.consignmentHex,
      supply: BigInt(latest.supply),
    }
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<MintViaTransferResult | null>(null)

  useEffect(() => {
    ensureSparkCoreReady()
      .then((c) => setCore(c))
      .catch((e) => setCoreErr(e instanceof Error ? e.message : String(e)))
  }, [])

  const refreshLeaves = useCallback(async () => {
    try {
      const list = await listSparkLeaves()
      setLeaves(list)
      if (list.length > 0 && !list.find((l) => l.id === selectedLeafId)) {
        setSelectedLeafId(list[0].id)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [selectedLeafId])

  useEffect(() => {
    void refreshLeaves()
  }, [refreshLeaves])

  function randomMsg() {
    const b = new Uint8Array(32)
    crypto.getRandomValues(b)
    setMsgHex(bytesToHex(b))
    setPendingRgb(null)
  }

  async function mint() {
    setErr(null)
    setResult(null)
    setBusy(true)
    try {
      if (!core) throw new Error('WASM not ready')
      if (!selectedLeafId) throw new Error('select a leaf first')

      const cleanMsg = msgHex.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
      if (cleanMsg.length !== 64) {
        throw new Error(`msg must be 64 hex chars (32 bytes) — got ${cleanMsg.length} after stripping non-hex`)
      }
      const msgBytes = hexToBytes(cleanMsg)

      const sourceLeaf = leaves.find((l) => l.id === selectedLeafId)
      if (!sourceLeaf) throw new Error(`selected leaf ${selectedLeafId} not in cached list`)
      const leafBefore = {
        uBase: sourceLeaf.ownerSigningPublicKey.toLowerCase(),
        verifyingKey: sourceLeaf.verifyingPublicKey.toLowerCase(),
      }

      const rgbPayload =
        pendingRgb?.kind === 'genesis'
          ? { consignmentHex: pendingRgb.consignmentHex }
          : pendingRgb?.kind === 'transition'
            ? {
                transitionHex: pendingRgb.transitionHex,
                prevGenesisHex: pendingRgb.prevGenesisHex,
              }
            : undefined
      // Phase 1C/clean session 7.2: derive `amount` from the bound chain
      // when we have one. Dev-lab raw-msg mints with no RGB payload have
      // no meaningful asset amount — use 1 as a token placeholder so the
      // pathTweak entry is still valid.
      let mintAmount: bigint = 1n
      if (pendingRgb?.kind === 'genesis' && pendingRgb.assetKind === 'uda') {
        // UDA genesis always carries exactly one indivisible token —
        // no GS_ISSUED_SUPPLY to read back, unlike NIA.
        mintAmount = 1n
      } else if (pendingRgb?.kind === 'genesis') {
        const meta = core.niaGenesisMetadata(pendingRgb.consignmentHex)
        try {
          mintAmount = BigInt(meta.supply)
        } finally {
          meta.free()
        }
      } else if (pendingRgb?.kind === 'transition') {
        const meta = core.niaGenesisMetadata(pendingRgb.prevGenesisHex)
        try {
          mintAmount = BigInt(meta.supply)
        } finally {
          meta.free()
        }
      }
      const { transferId, leaf } = await mintViaSelfTransfer(
        selectedLeafId,
        msgBytes,
        mintAmount,
        0,
        rgbPayload,
      )

      // Verification math:
      //   expected = deriveVerifyingKey(entry.uBase, msg, operator)
      //            = (entry.uBase + t(entry.uBase, msg)·G) + operator
      //            = U_tweaked + operator
      //   actual   = leaf.verifyingPublicKey (SE-persisted)
      // entry.uBase is the vanilla HD derivation for the DESTINATION leaf id
      // (the path the SDK used in claimTransferCore's newKeyDerivation).
      // It is NOT necessarily the source leaf's pre-mint ownerSigningPublicKey:
      // when the destination id differs from the source id (or when the source
      // was already tweaked), those values diverge.
      const entry = getPathTweak(leaf.id)
      if (!entry) {
        throw new Error(
          `pathTweaks missing entry for new leaf ${leaf.id} after mint — ` +
          'mintViaSelfTransfer post-condition violated',
        )
      }
      const uBasePre = bytesToHex(entry.uBase).toLowerCase()
      const operator = leaf.operatorPublicKey.toLowerCase()
      const realVk = leaf.verifyingPublicKey.toLowerCase()
      const expectedVk = core.deriveVerifyingKey(uBasePre, cleanMsg, operator).toLowerCase()
      const vanillaVk = bytesToHex(
        (await import('@buildonspark/spark-sdk')).addPublicKeys(
          hexToBytes(uBasePre),
          hexToBytes(operator),
        ),
      ).toLowerCase()

      setResult({
        leafBefore,
        leaf,
        msgHex: cleanMsg,
        expectedVerifyingKey: expectedVk,
        match: expectedVk === realVk,
        vanillaWouldMatch: vanillaVk === realVk,
        transferId,
      })
      // Refresh the list so the post-mint state is visible.
      void refreshLeaves()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{ marginTop: 32, borderTop: '1px solid #ddd', paddingTop: 16 }}>
      <h2 style={{ margin: '0 0 4px' }}>Spark-UTK Mint (via self-transfer)</h2>
      <p style={{ color: '#666', marginTop: 0, fontSize: 13 }}>
        Pick an existing leaf, supply a 32-byte msg, and click Mint. The leaf is
        self-transferred Spark→Spark; during the receiver-side claim the signer
        injects the Spark-UTK tweak so the new leaf's verifyingKey
        cryptographically commits to msg.
      </p>

      {coreErr && <pre style={{ color: 'crimson' }}>{coreErr}</pre>}

      <label style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
        source leaf
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        <select
          value={selectedLeafId}
          onChange={(e) => setSelectedLeafId(e.target.value)}
          disabled={busy || leaves.length === 0}
          style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, padding: 6 }}
        >
          {leaves.length === 0 && <option value="">— no leaves —</option>}
          {leaves.map((l) => (
            <option key={l.id} value={l.id}>
              {l.id.slice(0, 10)}…{l.id.slice(-4)} · {l.value} sat · {l.status}
            </option>
          ))}
        </select>
        <button onClick={() => void refreshLeaves()} disabled={busy} style={{ fontSize: 11 }}>
          refresh
        </button>
      </div>

      <label style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
        msg (32 bytes / 64 hex) — would be the RGB Merkle root
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={msgHex}
          onChange={(e) => {
            setMsgHex(e.target.value)
            setPendingRgb(null)
          }}
          placeholder="random 32-byte commitment, or issue / transition an NIA below"
          style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, padding: 6 }}
          disabled={busy}
        />
        <button onClick={randomMsg} disabled={busy}>random</button>
      </div>
      {pendingRgb?.kind === 'genesis' && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#2a6' }}>
          RGB genesis ({pendingRgb.consignmentHex.length / 2} bytes) will travel
          with the proof — receiver re-validates the issuance client-side.
        </div>
      )}
      {pendingRgb?.kind === 'transition' && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#2a6' }}>
          NIA transition ({pendingRgb.transitionHex.length / 2} B)
          {' + '}prev genesis ({pendingRgb.prevGenesisHex.length / 2} B)
          {' '}will travel — receiver replays the schema validator.
        </div>
      )}

      <IssueNiaInline
        core={core}
        disabled={busy}
        onIssuance={(contractId, consignmentHex, supply) => {
          setMsgHex(contractId)
          setPendingRgb({ kind: 'genesis', consignmentHex, assetKind: 'nia' })
          setLastIssuance({ contractId, consignmentHex, supply })
        }}
      />

      <FamilierDepositInline
        rootSeed={rootSeed}
        disabled={busy}
        onUtxoReady={setFamilierUtxo}
      />

      <IssueUdaInline
        core={core}
        disabled={busy}
        utxo={familierUtxo}
        onIssuance={(contractId, consignmentHex) => {
          setMsgHex(contractId)
          setPendingRgb({ kind: 'genesis', consignmentHex, assetKind: 'uda' })
        }}
      />

      <BuildTransitionInline
        core={core}
        disabled={busy}
        lastIssuance={lastIssuance}
        onTransition={(commitId, transitionHex, prevGenesisHex) => {
          setMsgHex(commitId)
          setPendingRgb({ kind: 'transition', transitionHex, prevGenesisHex })
        }}
      />

      <div style={{ marginTop: 10 }}>
        <button
          onClick={() => void mint()}
          disabled={busy || !core || !selectedLeafId || !msgHex.trim()}
        >
          {busy ? 'minting…' : 'Mint via self-transfer'}
        </button>
      </div>

      {err && (
        <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 12 }}>
          {err}
        </pre>
      )}

      {result && (
        <div style={{ marginTop: 14, padding: 10, border: '1px solid #ccc', background: '#fafafa' }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            transferId <code style={{ fontSize: 11 }}>{result.transferId}</code>
          </div>
          <KV label="leaf.id"                value={result.leaf.id} mono />
          <KV label="leaf.value"             value={String(result.leaf.value)} />
          <KV label="u_base (pre-mint)"      value={result.leafBefore.uBase} mono />
          <KV label="u_base (post-mint)"     value={result.leaf.ownerSigningPublicKey} mono />
          <KV label="operator"               value={result.leaf.operatorPublicKey} mono />
          <KV label="msg"                    value={result.msgHex} mono />
          <KV label="leaf.verifyingKey"      value={result.leaf.verifyingPublicKey} mono />
          <KV label="expected (UTK)"         value={result.expectedVerifyingKey} mono />
          <div
            style={{
              marginTop: 8,
              padding: 6,
              background: result.match ? '#e8f5e9' : '#ffebee',
              border: `1px solid ${result.match ? '#a5d6a7' : '#ef9a9a'}`,
              fontSize: 13,
            }}
          >
            {result.match
              ? 'OK · leaf.verifyingKey == deriveVerifyingKey(u_base, msg, operator) — Spark-UTK binding holds'
              : 'FAIL · the leaf does NOT carry the Spark-UTK tweak for this msg'}
          </div>
          {!result.match && result.vanillaWouldMatch && (
            <div style={{ marginTop: 6, padding: 6, background: '#fff8e1', border: '1px solid #ffe082', fontSize: 12 }}>
              diagnosis: leaf is vanilla (addPublicKeys(u_base, operator) == verifyingKey).
              The signer's tweak gate didn't fire on the claim's newKeyDerivation —
              check that pathTweaks is set on the right leafId at the right moment.
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ---- Issue NIA inline (chunk-β session 2) -----------------------------------
//
// Builds a Non-Inflatable Asset genesis via the wasm primitive and pipes
// the 32-byte contractId back into the parent's msg field, binding the
// next Spark-UTK mint to a real RGB issuance. The beneficiary txid is a
// constant placeholder (all-0xab) — we care about the contractId, not the
// L1 outpoint; in a real flow this would be a deposit/swap outpoint.

const NIA_PLACEHOLDER_TXID = 'ab'.repeat(32) // 32 bytes of 0xab, valid hex

function IssueNiaInline({
  core,
  disabled,
  onIssuance,
}: {
  core: SparkCore | null
  disabled: boolean
  /** Called when an NIA issuance succeeds. `contractId` is the 32-byte hex
   *  to use as Spark-UTK msg; `consignmentHex` is the strict-encoded
   *  Consignment<false> bytes that the receiver will validate. `supply`
   *  flows through so the transition panel can default to a same-amount
   *  full transfer (NIA `transfer` is conservation-checked, no split yet). */
  onIssuance: (contractId: string, consignmentHex: string, supply: bigint) => void
}) {
  const [ticker, setTicker] = useState('TEST')
  const [name, setName] = useState('Test asset')
  const [supply, setSupply] = useState('1000000')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{
    contractId: string
    consignmentSize: number
  } | null>(null)

  async function issue() {
    setErr(null)
    setBusy(true)
    try {
      if (!core) throw new Error('WASM not ready')
      const supplyTrim = supply.trim()
      if (!/^\d+$/.test(supplyTrim)) throw new Error('supply must be a non-negative integer')
      const supplyBig = BigInt(supplyTrim)
      if (supplyBig <= 0n) throw new Error('supply must be > 0')

      const tickerTrim = ticker.trim()
      const nameTrim = name.trim()
      if (!tickerTrim) throw new Error('ticker required')
      if (!nameTrim) throw new Error('name required')

      const nowSecs = BigInt(Math.floor(Date.now() / 1000))
      const issuance = core.issueNiaContract(
        tickerTrim,
        nameTrim,
        supplyBig,
        NIA_PLACEHOLDER_TXID,
        0,
        nowSecs,
      )
      const contractId = issuance.contractId
      const consignmentHex = issuance.consignmentHex
      issuance.free()
      setLastResult({ contractId, consignmentSize: consignmentHex.length / 2 })
      addContract({
        contractId,
        ticker: tickerTrim,
        name: nameTrim,
        supply: supplyTrim,
        consignmentHex,
        createdAt: new Date().toISOString(),
      })
      onIssuance(contractId, consignmentHex, supplyBig)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const allDisabled = disabled || busy || !core

  return (
    <fieldset style={{ marginTop: 12, border: '1px solid #ddd', padding: '6px 10px' }}>
      <legend style={{ fontSize: 12, color: '#666' }}>or issue an NIA contract & use its contractId as msg</legend>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
        <label style={{ fontSize: 11, color: '#666' }}>ticker</label>
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          placeholder="TEST"
          style={{ width: 70, fontSize: 12, padding: 4, fontFamily: 'monospace' }}
          disabled={allDisabled}
        />
        <label style={{ fontSize: 11, color: '#666' }}>name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Test asset"
          style={{ flex: 1, minWidth: 100, fontSize: 12, padding: 4 }}
          disabled={allDisabled}
        />
        <label style={{ fontSize: 11, color: '#666' }}>supply</label>
        <input
          value={supply}
          onChange={(e) => setSupply(e.target.value)}
          placeholder="1000000"
          inputMode="numeric"
          style={{ width: 100, fontSize: 12, padding: 4, fontFamily: 'monospace' }}
          disabled={allDisabled}
        />
        <button onClick={() => void issue()} disabled={allDisabled}>
          {busy ? 'issuing…' : 'issue & use as msg'}
        </button>
      </div>
      {lastResult && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#666' }}>
          <div style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
            contractId: {lastResult.contractId}
          </div>
          <div>consignment: {lastResult.consignmentSize} bytes (will be attached to the proof)</div>
        </div>
      )}
      {err && (
        <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', marginTop: 4, fontSize: 11 }}>
          {err}
        </pre>
      )}
    </fieldset>
  )
}

// ---- Familier deposit inline -----------------------------------------------
//
// The player funds their own UTXO instead of the game sponsoring one — see
// FROGNESIS DESIGN.md section 4bis. Derives a dedicated L1 address (separate
// from the Spark depositAddress, which gets swept into the Spark statechain
// and wouldn't stay solo-resignable for a later RGB transfer), polls a
// public Esplora until 1 confirmation, then hands the real txid:vout up to
// IssueUdaInline. TESTNET only for now — see lib/utxoLookup.ts for why
// REGTEST isn't supported here.

const FAMILIER_MIN_SATS = 3000
const FAMILIER_POLL_MS = 15000

export function FamilierDepositInline({
  rootSeed,
  disabled,
  onUtxoReady,
}: {
  rootSeed: Uint8Array
  disabled: boolean
  onUtxoReady: (utxo: { txid: string; vout: number } | null) => void
}) {
  const [network, setNetwork] = useState<FamilierNetwork>('TESTNET')
  const [status, setStatus] = useState<DepositStatus>({ utxo: null, confirmations: 0 })
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const notifiedRef = useRef(false)

  // Pure derivation from rootSeed+network — no effect needed, useMemo keeps
  // it render-time instead of a setState-in-effect round trip.
  const keyResult = useMemo<{ key: FamilierKey | null; err: string | null }>(() => {
    try {
      return { key: deriveFamilierKey(rootSeed, network), err: null }
    } catch (e) {
      return { key: null, err: e instanceof Error ? e.message : String(e) }
    }
  }, [rootSeed, network])
  const key = keyResult.key

  useEffect(() => {
    notifiedRef.current = false
    onUtxoReady(null)
    setStatus({ utxo: null, confirmations: 0 })
    setErr(null)
    if (!key) return
    let stopped = false
    const tick = async () => {
      try {
        const s = await pollDepositStatus(key.address, network)
        if (stopped) return
        setStatus(s)
        setErr(null)
        if (s.utxo && s.confirmations >= 1 && !notifiedRef.current) {
          notifiedRef.current = true
          onUtxoReady({ txid: s.utxo.txid, vout: s.utxo.vout })
        }
      } catch (e) {
        if (!stopped) setErr(e instanceof Error ? e.message : String(e))
      }
    }
    void tick()
    const id = setInterval(() => void tick(), FAMILIER_POLL_MS)
    return () => {
      stopped = true
      clearInterval(id)
    }
    // onUtxoReady is a setState passed from the parent — stable enough not
    // to belong in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, network])

  async function copyAddress() {
    if (!key) return
    await navigator.clipboard.writeText(key.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const ready = status.utxo !== null && status.confirmations >= 1

  return (
    <fieldset style={{ marginTop: 12, border: '1px solid #ddd', padding: '6px 10px' }}>
      <legend style={{ fontSize: 12, color: '#666' }}>familier UTXO — deposit real BTC, player-funded</legend>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
        <label style={{ fontSize: 11, color: '#666' }}>network</label>
        {(['TESTNET', 'MAINNET'] as FamilierNetwork[]).map((n) => (
          <label key={n} style={{ fontSize: 11 }}>
            <input
              type="radio"
              name="familierNetwork"
              checked={network === n}
              onChange={() => setNetwork(n)}
              disabled={disabled}
            />{' '}
            {n}
          </label>
        ))}
      </div>

      {key && (
        <div style={{ marginTop: 6, fontSize: 11 }}>
          <div style={{ color: '#666' }}>
            send at least <strong>{FAMILIER_MIN_SATS} sats</strong> to (and only to — this address is single-use):
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
            <code style={{ wordBreak: 'break-all' }}>{key.address}</code>
            <button onClick={() => void copyAddress()} disabled={disabled} style={{ fontSize: 10 }}>
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 6, fontSize: 11, color: ready ? '#2a6' : '#666' }}>
        {status.utxo === null && 'waiting for deposit…'}
        {status.utxo !== null && !ready && `seen, unconfirmed — waiting for 1 confirmation (${status.confirmations}/1)`}
        {ready &&
          `confirmed: ${status.utxo!.txid}:${status.utxo!.vout} (${status.utxo!.value} sats) — ready to mint below`}
      </div>

      {(keyResult.err ?? err) && (
        <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', marginTop: 4, fontSize: 11 }}>
          {keyResult.err ?? err}
        </pre>
      )}
    </fieldset>
  )
}

// ---- Issue UDA inline -------------------------------------------------------
//
// Same pattern as IssueNiaInline, but for a Unique Digital Asset: a single
// indivisible token (no supply field — always 1 unit) identified by a
// `tokenIndex`. There's no transition support for UDA yet, so unlike NIA
// this doesn't feed into BuildTransitionInline — it's mint-only.

export function IssueUdaInline({
  core,
  disabled,
  utxo,
  onIssuance,
}: {
  core: SparkCore | null
  disabled: boolean
  /** Real L1 outpoint to seal the genesis to, from FamilierDepositInline.
   *  No placeholder fallback — minting without a real player-funded UTXO
   *  would seal the familier to a make-believe outpoint, which is exactly
   *  what the deposit flow exists to avoid. */
  utxo: { txid: string; vout: number } | null
  /** Called when a UDA issuance succeeds. `contractId` is the 32-byte hex
   *  to use as Spark-UTK msg; `consignmentHex` is the strict-encoded
   *  Consignment<false> bytes that the receiver will validate; `ticker`/
   *  `name`/`tokenIndex` echo back what was actually minted, for callers
   *  that want to persist a human-readable record (see FamilierPage). */
  onIssuance: (contractId: string, consignmentHex: string, ticker: string, name: string, tokenIndex: number) => void
}) {
  const [ticker, setTicker] = useState('TEST')
  const [name, setName] = useState('Test UDA')
  const [tokenIndex, setTokenIndex] = useState('0')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{
    contractId: string
    consignmentSize: number
  } | null>(null)

  async function issue() {
    setErr(null)
    setBusy(true)
    try {
      if (!core) throw new Error('WASM not ready')
      if (!utxo) throw new Error('deposit a real UTXO first (FamilierDepositInline above)')
      const tokenIndexTrim = tokenIndex.trim()
      if (!/^\d+$/.test(tokenIndexTrim)) throw new Error('token index must be a non-negative integer')

      const tickerTrim = ticker.trim()
      const nameTrim = name.trim()
      if (!tickerTrim) throw new Error('ticker required')
      if (!nameTrim) throw new Error('name required')

      const nowSecs = BigInt(Math.floor(Date.now() / 1000))
      const issuance = core.issueUdaContract(
        tickerTrim,
        nameTrim,
        Number(tokenIndexTrim),
        utxo.txid,
        utxo.vout,
        nowSecs,
      )
      const contractId = issuance.contractId
      const consignmentHex = issuance.consignmentHex
      issuance.free()
      setLastResult({ contractId, consignmentSize: consignmentHex.length / 2 })
      onIssuance(contractId, consignmentHex, tickerTrim, nameTrim, Number(tokenIndexTrim))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const allDisabled = disabled || busy || !core || !utxo

  return (
    <fieldset style={{ marginTop: 12, border: '1px solid #ddd', padding: '6px 10px' }}>
      <legend style={{ fontSize: 12, color: '#666' }}>or issue a UDA contract & use its contractId as msg</legend>
      {!utxo && (
        <div style={{ fontSize: 11, color: '#a66' }}>deposit a real UTXO above first — minting needs a real outpoint to seal to</div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
        <label style={{ fontSize: 11, color: '#666' }}>ticker</label>
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          placeholder="TEST"
          style={{ width: 70, fontSize: 12, padding: 4, fontFamily: 'monospace' }}
          disabled={allDisabled}
        />
        <label style={{ fontSize: 11, color: '#666' }}>name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Test UDA"
          style={{ flex: 1, minWidth: 100, fontSize: 12, padding: 4 }}
          disabled={allDisabled}
        />
        <label style={{ fontSize: 11, color: '#666' }}>token index</label>
        <input
          value={tokenIndex}
          onChange={(e) => setTokenIndex(e.target.value)}
          placeholder="0"
          inputMode="numeric"
          style={{ width: 60, fontSize: 12, padding: 4, fontFamily: 'monospace' }}
          disabled={allDisabled}
        />
        <button onClick={() => void issue()} disabled={allDisabled}>
          {busy ? 'issuing…' : 'issue & use as msg'}
        </button>
      </div>
      {lastResult && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#666' }}>
          <div style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
            contractId: {lastResult.contractId}
          </div>
          <div>consignment: {lastResult.consignmentSize} bytes (will be attached to the proof)</div>
        </div>
      )}
      {err && (
        <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', marginTop: 4, fontSize: 11 }}>
          {err}
        </pre>
      )}
    </fieldset>
  )
}

// ---- Build NIA transition inline (chunk-γ session 2) -----------------------
//
// Builds a NIA `transfer` state transition on top of the most recent genesis
// issued through IssueNiaInline. The transition is conservation-checked
// (svs OS_ASSET = sum-inputs-vs-sum-outputs) so we default `amount` to the
// genesis supply: no split/merge in this binding yet.
//
// The msg fed into the next Spark-UTK mint becomes `transition.id()` (32-byte
// hex) instead of the genesis contractId. Receiver replays the schema
// validator client-side via `core.validateNiaTransition(transitionHex,
// prevGenesisHex)` and cross-checks against msgHex.

const NIA_TRANSFER_PLACEHOLDER_TXID = 'cd'.repeat(32)

function BuildTransitionInline({
  core,
  disabled,
  lastIssuance,
  onTransition,
}: {
  core: SparkCore | null
  disabled: boolean
  lastIssuance: { contractId: string; consignmentHex: string; supply: bigint } | null
  onTransition: (commitId: string, transitionHex: string, prevGenesisHex: string) => void
}) {
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{
    commitId: string
    transitionSize: number
    prevGenesisSize: number
  } | null>(null)

  // Auto-fill amount from the most recent issuance — conservation requires
  // input == output total, so default to full transfer.
  useEffect(() => {
    if (lastIssuance) setAmount(lastIssuance.supply.toString())
  }, [lastIssuance])

  async function buildTransition() {
    setErr(null)
    setBusy(true)
    try {
      if (!core) throw new Error('WASM not ready')
      if (!lastIssuance) throw new Error('issue a NIA contract first — the transition consumes its genesis')
      const supplyTrim = amount.trim()
      if (!/^\d+$/.test(supplyTrim)) throw new Error('amount must be a non-negative integer')
      const amt = BigInt(supplyTrim)
      if (amt <= 0n) throw new Error('amount must be > 0')

      const trn = core.buildNiaTransition(
        lastIssuance.consignmentHex,
        0,
        amt,
        NIA_TRANSFER_PLACEHOLDER_TXID,
        1,
      )
      const commitId = trn.commitIdHex
      const transitionHex = trn.transitionHex
      trn.free()
      setLastResult({
        commitId,
        transitionSize: transitionHex.length / 2,
        prevGenesisSize: lastIssuance.consignmentHex.length / 2,
      })
      addTransition({
        commitId,
        prevContractId: lastIssuance.contractId,
        outputs: [{ amount: supplyTrim }],
        transitionHex,
        createdAt: new Date().toISOString(),
      })
      onTransition(commitId, transitionHex, lastIssuance.consignmentHex)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const allDisabled = disabled || busy || !core || !lastIssuance

  return (
    <fieldset style={{ marginTop: 8, border: '1px solid #ddd', padding: '6px 10px' }}>
      <legend style={{ fontSize: 12, color: '#666' }}>
        or transition on top of the last issuance & use commit_id as msg
      </legend>
      {!lastIssuance && (
        <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
          Issue a NIA contract above first — this panel consumes its genesis.
        </div>
      )}
      {lastIssuance && (
        <>
          <div style={{ fontSize: 11, color: '#666', marginTop: 4, fontFamily: 'monospace', wordBreak: 'break-all' }}>
            prev contract: {lastIssuance.contractId.slice(0, 16)}… · supply {String(lastIssuance.supply)}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <label style={{ fontSize: 11, color: '#666' }}>amount</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="numeric"
              style={{ width: 120, fontSize: 12, padding: 4, fontFamily: 'monospace' }}
              disabled={allDisabled}
            />
            <span style={{ fontSize: 11, color: '#888' }}>
              must equal prev allocation (no split yet)
            </span>
            <button onClick={() => void buildTransition()} disabled={allDisabled}>
              {busy ? 'building…' : 'build transition & use commit_id as msg'}
            </button>
          </div>
        </>
      )}
      {lastResult && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#666' }}>
          <div style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
            commit_id: {lastResult.commitId}
          </div>
          <div>
            transition: {lastResult.transitionSize} B
            {' · '}prev genesis: {lastResult.prevGenesisSize} B
            {' '}(both attached to the proof)
          </div>
        </div>
      )}
      {err && (
        <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', marginTop: 4, fontSize: 11 }}>
          {err}
        </pre>
      )}
    </fieldset>
  )
}

// ---- Consignment Lab --------------------------------------------------------

interface SentRecord {
  to: string
  meta: ConsignmentMeta
  envelope: ConsignmentEnvelope
}

type LeafVerifyAlgo = 'vanilla' | 'spark-utk'

type LeafVerification =
  | { kind: 'none' }                                                    // v2 envelope, no leaf to verify against
  | { kind: 'ok'; derivedVerifyingKey: string; algo: LeafVerifyAlgo }   // match
  | { kind: 'mismatch'; expected: string; got: string; algo: LeafVerifyAlgo }
  | { kind: 'error'; message: string }                                  // derive call threw

// Receiver-side validation of the optional RGB payload carried by the
// envelope. Two flavors:
//   - `genesis`: validates a `Consignment<false>` against the canonical NIA
//                schema; expected msg == validated contractId.
//   - `transition`: replays `Schema::validate_state(OrdOpRef::Transition, ...)`
//                   on a strict-encoded Transition, with the input state map
//                   rebuilt from a prev-genesis consignment. No witness
//                   resolver, no L1 — see feedback_no_synthetic_l1_witness.
//                   Expected msg == returned transition.id().
type RgbBindingKind = 'genesis' | 'transition' | 'transition-on-transition'

type RgbValidation =
  | { kind: 'none' }                                                        // no RGB payload attached
  | { kind: 'ok'; binding: RgbBindingKind; committed: string }              // validator OK + committed == msgHex
  | { kind: 'msg-mismatch'; binding: RgbBindingKind; committed: string; msgHex: string }
  | { kind: 'missing-msg'; binding: RgbBindingKind }                        // payload present but envelope has no msgHex to cross-check
  | { kind: 'fail'; binding: RgbBindingKind; message: string }              // validator rejected

interface DecodedConsignment {
  raw: string                  // hex of the raw bytes received
  envelope?: ConsignmentEnvelope
  proofUBase?: string
  proofOperator?: string
  leafVerification?: LeafVerification
  rgbValidation?: RgbValidation
  signatureCheck?: SignatureCheck
  parseError?: string
}

type LabMode = 'demo' | 'leaf'

function ConsignmentLab({
  myNpub,
  myIdentityPubkey,
  myNostrPrivkeyHex,
}: {
  myNpub: string
  myIdentityPubkey: string
  myNostrPrivkeyHex: string
}) {
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

      let unsigned: UnsignedEnvelopeV4
      if (mode === 'leaf') {
        if (!selectedLeaf) throw new Error('no leaf selected — fund the wallet or switch to demo mode')
        const operator = selectedLeaf.operatorPublicKey.toLowerCase()
        if (!COMPRESSED_PUBKEY_HEX_RE.test(operator)) {
          throw new Error(`leaf.operatorPublicKey is not a 33-byte compressed pubkey: ${operator}`)
        }

        // If the leaf is in pathTweaks, it's a Spark-UTK tweaked leaf — use
        // the PRE-MINT u_base (entry.uBase) for the proof, NOT the post-mint
        // leaf.ownerSigningPublicKey (which is U_tweaked). Carry msgHex on
        // the leafReference so the receiver verifies via deriveVerifyingKey.
        // Otherwise use the leaf's own pubkey and emit a vanilla envelope.
        const tweakEntry = getPathTweak(selectedLeaf.id)
        let proofUBase: string
        let msgHex: string | undefined
        let consignmentHex: string | undefined
        let transitionHex: string | undefined
        let prevGenesisHex: string | undefined
        if (tweakEntry) {
          proofUBase = bytesToHex(tweakEntry.uBase).toLowerCase()
          msgHex = bytesToHex(tweakEntry.msg).toLowerCase()
          consignmentHex = tweakEntry.consignmentHex
          transitionHex = tweakEntry.transitionHex
          prevGenesisHex = tweakEntry.prevGenesisHex
        } else {
          proofUBase = selectedLeaf.ownerSigningPublicKey.toLowerCase()
          msgHex = undefined
          consignmentHex = undefined
          transitionHex = undefined
          prevGenesisHex = undefined
        }
        if (!COMPRESSED_PUBKEY_HEX_RE.test(proofUBase)) {
          throw new Error(`proof u_base is not a 33-byte compressed pubkey: ${proofUBase}`)
        }

        const proof = new core.SparkUtkProofJs(proofUBase, operator)
        const proofHex = proof.encode()
        proof.free()
        unsigned = {
          v: 4,
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
            ...(msgHex ? { msgHex } : {}),
            ...(consignmentHex ? { consignmentHex } : {}),
            ...(transitionHex ? { transitionHex } : {}),
            ...(prevGenesisHex ? { prevGenesisHex } : {}),
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
        unsigned = {
          v: 4,
          sender: myNpub,
          senderIdentityPubkey: uBase,
          createdAt: new Date().toISOString(),
          kind: 'spark-utk-proof',
          proofHex,
        }
      }
      const senderSignature = signEnvelope(unsigned, myNostrPrivkeyHex)
      const envelope: ConsignmentEnvelope = { ...unsigned, senderSignature, kind: 'spark-utk-proof' }

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
        const leafRef =
          env.v === 3 ? env.leafReference :
          env.v === 4 ? env.leafReference :
          undefined
        let leafVerification: LeafVerification = { kind: 'none' }
        if (leafRef) {
          try {
            // Two verification modes:
            //   - vanilla (msgHex absent): verifyingPublicKey === u_base + operator
            //     Plain secp256k1 point addition; matches the SDK's SparkWallet.verifyKey.
            //   - Spark-UTK tweaked (msgHex present): verifyingPublicKey ===
            //     deriveVerifyingKey(u_base, msg, operator). u_base is the pre-mint
            //     vanilla pubkey of the source leaf; the wasm primitive applies the
            //     tagged-hash tweak before adding operator.
            const claimed = leafRef.verifyingPublicKey.toLowerCase()
            let derived: string
            let algo: LeafVerifyAlgo
            if (leafRef.msgHex) {
              const cleanMsg = leafRef.msgHex.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
              if (cleanMsg.length !== 64) {
                throw new Error(`msgHex must be 64 hex chars, got ${cleanMsg.length}`)
              }
              derived = core.deriveVerifyingKey(proofUBase, cleanMsg, proofOperator).toLowerCase()
              algo = 'spark-utk'
            } else {
              const derivedBytes = addPublicKeys(hexToBytes(proofUBase), hexToBytes(proofOperator))
              derived = bytesToHex(derivedBytes).toLowerCase()
              algo = 'vanilla'
            }
            leafVerification = derived === claimed
              ? { kind: 'ok', derivedVerifyingKey: derived, algo }
              : { kind: 'mismatch', expected: claimed, got: derived, algo }
          } catch (e) {
            leafVerification = { kind: 'error', message: e instanceof Error ? e.message : String(e) }
          }
        }
        let rgbValidation: RgbValidation = { kind: 'none' }
        if (leafRef?.transitionHex && leafRef?.prevGenesisHex && leafRef?.prevTransitionHex) {
          // Depth-3 chain: genesis → prevTransition → transition. Shipped
          // by settlement-consignment-v1 envelopes (Phase 1C/clean session 5.2).
          // Validation contract:
          //   - validateNiaTransitionFromPrev(transition, prevTransition, genesis)
          //     re-runs schema on every link, returns transition.id() — this is
          //     the NEW state the buyer is being handed (T_new).
          //   - msgHex carried on the envelope refers to the SELLER's pre-swap
          //     binding (= prevTransition.id() = T_n.id()), NOT T_new. So the
          //     cross-check we expose to the user is `prevTransition.id() ==
          //     msgHex`, derived via a separate validateNiaTransition call on
          //     prevTransitionHex against the genesis.
          try {
            // First confirm the full chain validates — without this the
            // prevTransition could be in isolation but unrelated to genesis.
            core
              .validateNiaTransitionFromPrev(
                leafRef.transitionHex,
                leafRef.prevTransitionHex,
                leafRef.prevGenesisHex,
              )
              .toLowerCase()
            // Then recover prevTransition.id() so we can cross-check msgHex
            // against the seller's pre-swap binding.
            const prevCommitted = core
              .validateNiaTransition(leafRef.prevTransitionHex, leafRef.prevGenesisHex)
              .toLowerCase()
            if (!leafRef.msgHex) {
              rgbValidation = { kind: 'missing-msg', binding: 'transition-on-transition' }
            } else if (leafRef.msgHex.toLowerCase() === prevCommitted) {
              rgbValidation = {
                kind: 'ok',
                binding: 'transition-on-transition',
                committed: prevCommitted,
              }
            } else {
              rgbValidation = {
                kind: 'msg-mismatch',
                binding: 'transition-on-transition',
                committed: prevCommitted,
                msgHex: leafRef.msgHex.toLowerCase(),
              }
            }
          } catch (e) {
            rgbValidation = {
              kind: 'fail',
              binding: 'transition-on-transition',
              message: e instanceof Error ? e.message : String(e),
            }
          }
        } else if (leafRef?.transitionHex && leafRef?.prevGenesisHex) {
          // Spark-native transition validation: schema-only, no resolver,
          // no synthetic L1 witness. The returned hex is transition.id(),
          // which must match msgHex to close the chunk-α leaf-binding loop.
          try {
            const committed = core
              .validateNiaTransition(leafRef.transitionHex, leafRef.prevGenesisHex)
              .toLowerCase()
            if (!leafRef.msgHex) {
              rgbValidation = { kind: 'missing-msg', binding: 'transition' }
            } else if (leafRef.msgHex.toLowerCase() === committed) {
              rgbValidation = { kind: 'ok', binding: 'transition', committed }
            } else {
              rgbValidation = {
                kind: 'msg-mismatch',
                binding: 'transition',
                committed,
                msgHex: leafRef.msgHex.toLowerCase(),
              }
            }
          } catch (e) {
            rgbValidation = {
              kind: 'fail',
              binding: 'transition',
              message: e instanceof Error ? e.message : String(e),
            }
          }
        } else if (leafRef?.consignmentHex) {
          try {
            const committed = core
              .validateNiaConsignment(leafRef.consignmentHex)
              .toLowerCase()
            if (!leafRef.msgHex) {
              rgbValidation = { kind: 'missing-msg', binding: 'genesis' }
            } else if (leafRef.msgHex.toLowerCase() === committed) {
              rgbValidation = { kind: 'ok', binding: 'genesis', committed }
            } else {
              rgbValidation = {
                kind: 'msg-mismatch',
                binding: 'genesis',
                committed,
                msgHex: leafRef.msgHex.toLowerCase(),
              }
            }
          } catch (e) {
            rgbValidation = {
              kind: 'fail',
              binding: 'genesis',
              message: e instanceof Error ? e.message : String(e),
            }
          }
        }
        const signatureCheck: SignatureCheck =
          env.v === 4 ? verifyEnvelope(env) : { kind: 'missing' }
        entry = {
          raw: rawHex,
          envelope: env,
          proofUBase,
          proofOperator,
          leafVerification,
          rgbValidation,
          signatureCheck,
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
            <strong>real leaf</strong> (v3/v4): if the selected leaf was
            minted via Spark-UTK (entry in pathTweaks), the proof carries the
            <em> pre-mint</em> <code>u_base</code> and the envelope's
            <code>leafReference</code> includes <code>msgHex</code>; the
            receiver verifies via
            <code> deriveVerifyingKey(u_base, msg, operator) == verifyingPublicKey</code>
            (the full Spark-UTK binding). Otherwise it falls back to the
            vanilla Spark invariant
            <code> u_base + operator == verifyingPublicKey</code> for
            non-tweaked leaves.
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
            {selectedLeaf && (() => {
              const tweak = getPathTweak(selectedLeaf.id)
              return (
                <>
                  {tweak && (
                    <div style={{
                      marginTop: 6, padding: '6px 8px',
                      background: '#e8f5e9', border: '1px solid #a5d6a7',
                      fontSize: 12,
                    }}>
                      Spark-UTK tweaked leaf · msg ={' '}
                      <code style={{ fontSize: 11 }}>{bytesToHex(tweak.msg).slice(0, 16)}…</code>
                      . The proof will carry the pre-mint u_base and msg so the
                      receiver verifies via deriveVerifyingKey (not vanilla add).
                    </div>
                  )}
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ fontSize: 11, color: '#666', cursor: 'pointer' }}>
                      leaf hex details
                    </summary>
                    <div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 11, color: '#555', wordBreak: 'break-all' }}>
                      <div>treeId: {selectedLeaf.treeId}</div>
                      <div>ownerSigningPublicKey: {selectedLeaf.ownerSigningPublicKey}</div>
                      <div>operatorPublicKey (FROST): {selectedLeaf.operatorPublicKey}</div>
                      <div>verifyingPublicKey (target): {selectedLeaf.verifyingPublicKey}</div>
                      {tweak && (
                        <>
                          <div>pre-mint u_base: {bytesToHex(tweak.uBase)}</div>
                          <div>msg: {bytesToHex(tweak.msg)}</div>
                          <div>sourcePath: {tweak.sourcePath}</div>
                        </>
                      )}
                    </div>
                  </details>
                </>
              )
            })()}
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
            <strong>Spark vanilla, not Spark-UTK</strong>: leaf-backed envelopes
            verify <code>u_base + operator == leaf.verifyingPublicKey</code>{' '}
            — that's Spark's own leaf-key invariant (the SDK calls it
            <code> SparkWallet.verifyKey</code>). It proves the proof refers
            to a real Spark leaf, but the leaf does <em>not</em> yet carry an
            RGB commitment. Real Spark-UTK requires the leaf's verifyingKey
            to encode <code>U_tweaked = u_base + tagged_hash(tag, u_base ‖ msg) · G</code>{' '}
            with <code>msg</code> = an RGB Merkle commitment. The stock SDK
            doesn't expose that hook → SDK fork = chunk-α-bis.
          </li>
          <li>
            <strong>signature scope</strong>: v4's BIP-340 schnorr signature
            covers the canonical bytes of every envelope field except the
            signature itself. It proves the holder of the sender's nsec
            authored this exact envelope (incl. proofHex + leaf reference).
            It does <em>not</em> prove the leaf belongs to that nsec — that's
            still the leaf-binding check above.
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
  const leafRef =
    env?.v === 3 ? env.leafReference :
    env?.v === 4 ? env.leafReference :
    undefined
  const claimed = env?.senderIdentityPubkey?.toLowerCase()
  const got = entry.proofUBase?.toLowerCase()
  let bindingBadge: ReactNode = null
  if (env && got) {
    if (!claimed) {
      bindingBadge = <span style={{ color: '#888' }}>envelope has no senderIdentityPubkey (legacy v1)</span>
    } else if (claimed === got) {
      bindingBadge = <span style={{ color: 'seagreen' }}>OK · proof.u_base matches claimed Spark identity</span>
    } else if (leafRef) {
      // Leaf-backed envelopes bind u_base to the *leaf*, not the wallet identity —
      // a difference is expected. Defer the trust badge to leaf verification below.
      bindingBadge = <span style={{ color: '#888' }}>n/a · leaf-backed envelope binds u_base to the leaf, not the wallet identity</span>
    } else {
      bindingBadge = <span style={{ color: '#c80' }}>MISMATCH · proof.u_base ≠ envelope.senderIdentityPubkey</span>
    }
  }

  const lv = entry.leafVerification
  let leafBadge: ReactNode = null
  if (leafRef && lv) {
    if (lv.kind === 'ok') {
      leafBadge = (
        <span style={{ color: 'seagreen' }}>
          OK ·{' '}
          {lv.algo === 'spark-utk'
            ? <>deriveVerifyingKey(u_base, msg, operator) == leaf.verifyingPublicKey <strong>(Spark-UTK)</strong></>
            : <>u_base + operator == leaf.verifyingPublicKey <strong>(Spark vanilla)</strong></>
          }
        </span>
      )
    } else if (lv.kind === 'mismatch') {
      leafBadge = (
        <span style={{ color: '#c00' }}>
          MISMATCH ({lv.algo === 'spark-utk' ? 'Spark-UTK' : 'Spark vanilla'}) · derived {lv.got.slice(0, 12)}… ≠ claimed {lv.expected.slice(0, 12)}…
        </span>
      )
    } else if (lv.kind === 'error') {
      leafBadge = <span style={{ color: 'crimson' }}>derive error · {lv.message}</span>
    }
  }

  const rv = entry.rgbValidation
  let rgbBadge: ReactNode = null
  if (rv && rv.kind !== 'none') {
    const label = rv.kind === 'ok' || rv.kind === 'msg-mismatch' || rv.kind === 'missing-msg' || rv.kind === 'fail'
      ? rv.binding === 'transition-on-transition'
        ? 'NIA chain (genesis → T_n → T_new)'
        : rv.binding === 'transition'
          ? 'NIA transition'
          : 'NIA genesis'
      : ''
    const committedLabel = (binding: RgbBindingKind) =>
      binding === 'transition' || binding === 'transition-on-transition'
        ? 'transition.id()'
        : 'contractId'
    if (rv.kind === 'ok') {
      rgbBadge = (
        <span style={{ color: 'seagreen' }}>
          OK · {label} validates (schema replay){' '}
          AND {committedLabel(rv.binding)} == msg (<code>{rv.committed.slice(0, 16)}…</code>)
        </span>
      )
    } else if (rv.kind === 'msg-mismatch') {
      rgbBadge = (
        <span style={{ color: '#c00' }}>
          MISMATCH · {label} validates but {committedLabel(rv.binding)} {rv.committed.slice(0, 12)}… ≠ msg {rv.msgHex.slice(0, 12)}…
        </span>
      )
    } else if (rv.kind === 'missing-msg') {
      rgbBadge = (
        <span style={{ color: '#c80' }}>
          {label} present but envelope has no msgHex to cross-check
        </span>
      )
    } else if (rv.kind === 'fail') {
      rgbBadge = (
        <span style={{ color: '#c00' }}>FAIL · {label} · {rv.message}</span>
      )
    }
  }

  const sc = entry.signatureCheck
  let signatureBadge: ReactNode = null
  if (sc) {
    if (sc.kind === 'ok') {
      signatureBadge = (
        <span style={{ color: 'seagreen' }}>
          OK · BIP-340 schnorr signature verified against sender npub
        </span>
      )
    } else if (sc.kind === 'fail') {
      signatureBadge = (
        <span style={{ color: '#c00' }}>FAIL · {sc.reason}</span>
      )
    } else if (sc.kind === 'missing') {
      signatureBadge = (
        <span style={{ color: '#888' }}>n/a · pre-v4 envelope, no signature field</span>
      )
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
          {leafRef && (
            <>
              <div style={{ marginTop: 6, color: '#666' }}>leafReference:</div>
              <div style={{ paddingLeft: 8 }}>
                <div>id: {leafRef.id}</div>
                <div>treeId: {leafRef.treeId}</div>
                <div>value: {leafRef.value} sats</div>
                <div>network: {leafRef.network}</div>
                <div>verifyingPublicKey: {leafRef.verifyingPublicKey}</div>
                {leafRef.msgHex && <div>msg: {leafRef.msgHex}</div>}
                {lv?.kind === 'ok' && (
                  <div>
                    computed ({lv.algo === 'spark-utk' ? 'deriveVerifyingKey(u_base, msg, operator)' : 'u_base + operator'}):{' '}
                    {lv.derivedVerifyingKey}
                  </div>
                )}
                {lv?.kind === 'mismatch' && (
                  <>
                    <div>
                      computed ({lv.algo === 'spark-utk' ? 'deriveVerifyingKey(u_base, msg, operator)' : 'u_base + operator'}):{' '}
                      {lv.got}
                    </div>
                    <div>expected (claimed): {lv.expected}</div>
                  </>
                )}
              </div>
              <div style={{ marginTop: 4 }}>
                <span style={{ color: '#666' }}>leaf binding:</span> {leafBadge}
              </div>
              {rgbBadge && (
                <div style={{ marginTop: 4 }}>
                  <span style={{ color: '#666' }}>rgb binding:</span> {rgbBadge}
                </div>
              )}
              {leafRef.consignmentHex && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ color: '#666', cursor: 'pointer', fontSize: 12 }}>
                    consignment ({leafRef.consignmentHex.length / 2} B)
                  </summary>
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#555', wordBreak: 'break-all' }}>
                    {leafRef.consignmentHex.slice(0, 200)}…
                  </div>
                </details>
              )}
              {leafRef.transitionHex && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ color: '#666', cursor: 'pointer', fontSize: 12 }}>
                    transition ({leafRef.transitionHex.length / 2} B)
                    {leafRef.prevGenesisHex && (
                      <> + prev genesis ({leafRef.prevGenesisHex.length / 2} B)</>
                    )}
                  </summary>
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#555', wordBreak: 'break-all' }}>
                    {leafRef.transitionHex.slice(0, 200)}…
                  </div>
                </details>
              )}
            </>
          )}
          {env.v === 4 && (
            <div style={{ marginTop: 6, color: '#666', wordBreak: 'break-all' }}>
              senderSignature: <span style={{ color: '#222' }}>{env.senderSignature}</span>
            </div>
          )}
          <div style={{ marginTop: 4 }}>
            <span style={{ color: '#666' }}>signature:</span> {signatureBadge}
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

// ---- Locked screen (vault present, awaiting PIN) ---------------------------

function LockedScreen({
  vault,
  onUnlock,
  onForget,
}: {
  vault: EncryptedVault
  onUnlock: (pin: string) => Promise<void>
  onForget: () => void
}) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    if (!pin) return
    setBusy(true)
    setErr(null)
    try {
      await onUnlock(pin)
    } catch (e) {
      if (e instanceof WrongPinError) {
        setErr('Wrong PIN')
      } else {
        setErr(e instanceof Error ? e.message : String(e))
      }
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <h2 style={{ margin: '0 0 6px 0' }}>Locked</h2>
      <p style={{ color: '#666', fontSize: 13, margin: '0 0 12px 0' }}>
        Vault present for npub <code>{vault.npubFp ?? '???????'}…</code> · enter PIN to unlock.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          placeholder="PIN"
          style={{ flex: 1, fontFamily: 'monospace', fontSize: 14, padding: '6px 8px' }}
          disabled={busy}
        />
        <button onClick={() => void submit()} disabled={busy || !pin}>
          {busy ? 'unlocking…' : 'Unlock'}
        </button>
      </div>
      {err && <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', marginTop: 8 }}>{err}</pre>}
      <button
        onClick={onForget}
        style={{ marginTop: 16, fontSize: 12, color: '#a06010', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
      >
        Forget this wallet (clears the vault)
      </button>
    </div>
  )
}

// ---- Save with PIN (offered in ready view when no vault exists) ------------

function SaveWithPin({ onSave }: { onSave: (pin: string) => Promise<void> }) {
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    setErr(null)
    if (!pin) return
    if (pin !== pin2) {
      setErr('PINs do not match')
      return
    }
    setBusy(true)
    try {
      await onSave(pin)
      setPin('')
      setPin2('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset style={{ marginTop: 16, border: '1px solid #ddd', padding: '10px 12px' }}>
      <legend style={{ fontSize: 12, color: '#666' }}>persist with PIN (optional)</legend>
      <p style={{ fontSize: 12, color: '#666', margin: '0 0 8px 0' }}>
        Encrypts your nsec with the chosen PIN (PBKDF2-SHA256 600k + AES-GCM) and
        stores it in this browser's localStorage. Next reload asks for the PIN
        instead of regenerating.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="PIN"
          style={{ flex: '1 1 120px', fontFamily: 'monospace', fontSize: 13, padding: '6px 8px' }}
          disabled={busy}
        />
        <input
          type="password"
          inputMode="numeric"
          value={pin2}
          onChange={(e) => setPin2(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          placeholder="confirm PIN"
          style={{ flex: '1 1 120px', fontFamily: 'monospace', fontSize: 13, padding: '6px 8px' }}
          disabled={busy}
        />
        <button onClick={() => void submit()} disabled={busy || !pin}>
          {busy ? 'saving…' : 'Save with PIN'}
        </button>
      </div>
      {err && <div style={{ color: 'crimson', fontSize: 12, marginTop: 6 }}>{err}</div>}
    </fieldset>
  )
}

// ---- Small KV row -----------------------------------------------------------

export function KV({ label, value, mono, masked }: { label: string; value: string; mono?: boolean; masked?: boolean }) {
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
