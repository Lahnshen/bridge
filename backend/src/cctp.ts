import {
  BaseError,
  ContractFunctionRevertedError,
  erc20Abi,
  formatUnits,
  hexToBigInt,
  hexToNumber,
  InsufficientFundsError,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  size,
  slice,
  toHex,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import {
  chainOf,
  chains,
  domainName,
  injective,
  INJECTIVE_DOMAIN,
  IRIS_API,
  MESSAGE_TRANSMITTER,
  minRedeemAmount,
  relayer,
  SOLANA_DOMAIN,
  TOKEN_MESSENGER,
  txUrl,
} from './config'
import {
  burnTime,
  dequeue,
  doneTransfers,
  domainOf,
  enqueue,
  historyRows,
  indexReceipt,
  linkMint,
  markRedeemed,
  mintOf,
  queuedTxs,
  redeemTxOf,
  saveRedeem,
  unredeemedTxs,
  type MintRow,
} from './indexer'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type Transfer = {
  sourceDomain: number
  sourceChain: string
  destinationDomain: number
  destinationChain: string
  txHash: string
  txUrl?: string
  nonce?: Hex
  amount?: string
  fee?: string
  sender?: string
  recipient?: string
  status: 'pending' | 'ready' | 'redeemed' | 'restricted'
  note?: string
  redeemTx?: string
  redeemTxUrl?: string
  message?: Hex
  attestation?: Hex
  time?: number // burn's block time (unix seconds), once the indexer has it
}

type Burn = NonNullable<ReturnType<typeof decodeBurn>>
type Found = { transfer: Transfer; burn?: Burn; message?: Hex; attestation?: Hex; iris?: IrisMessage }
type IrisMessage = {
  message: Hex | null
  eventNonce: Hex
  attestation: string | null
  status: string
  cctpVersion: number
  forwardState?: string | null
  forwardTxHash?: string | null
  destinationMintTxHash?: string | null
}

const transmitterAbi = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
  'function usedNonces(bytes32 nonce) view returns (uint256)',
])
const MessageSent = parseAbiItem('event MessageSent(bytes message)')
// Hook data that asks Circle's Forwarding Service to mint on the destination chain: https://developers.circle.com/cctp/concepts/forwarding-service
const FORWARD_HOOK = toHex('cctp-forward')
// Circle's average wait for a standard attestation, on the sources where it's more than a few seconds:
// https://developers.circle.com/cctp/required-block-confirmations
const SLOW_FINALITY: Record<number, string> = {
  0: '~20 min', 2: '~20 min', 3: '~20 min', 6: '~20 min', 10: '~20 min', 11: '6–32 h', 12: '~20 min',
  14: '~20 min', 21: '~30 min', 22: '~20 min', 25: '2–4 h', 28: '~20 min', 30: '~30 min', 37: '~20 min',
}
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

// ---- Input parsing --------------------------------------------------------------------------------

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

// inj1… and 0x… are two encodings of the same Injective account.
function injToHex(address: string): Hex | undefined {
  const data = [...address.slice(4)].map((ch) => BECH32.indexOf(ch))
  if (!address.startsWith('inj1') || data.length !== 38 || data.includes(-1)) return
  let checksum = 1
  for (const value of [3, 3, 3, 0, 9, 14, 10, ...data]) { // expanded "inj" prefix + data
    const top = checksum >> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    GENERATORS.forEach((g, i) => { if ((top >> i) & 1) checksum ^= g })
  }
  if (checksum !== 1) return
  const bytes: number[] = []
  let acc = 0
  let bits = 0
  for (const value of data.slice(0, -6)) {
    acc = ((acc << 5) | value) & 0xfff
    bits += 5
    if (bits >= 8) bytes.push((acc >> (bits -= 8)) & 0xff)
  }
  return toHex(new Uint8Array(bytes))
}

function parseAddress(input: string): Hex {
  const value = input.trim().toLowerCase()
  const address = /^0x[0-9a-f]{40}$/.test(value) ? (value as Hex) : injToHex(value)
  if (!address) throw new HttpError(400, 'Invalid address. Use a 0x… or inj1… wallet address.')
  return address
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{43,90}$/

function parseTx(input: string, domain?: number) {
  const value = input.trim()
  if (domain !== undefined && !domainName(domain)) throw new HttpError(400, `Unsupported source domain ${domain}.`)
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return { hash: value.toLowerCase() as Hex, domain }
  // With an explicit domain, other chains' hash formats (Stellar, Starknet, Sui…) go to Circle as-is.
  if (domain !== undefined && (/^(0x)?[0-9a-fA-F]{40,64}$/.test(value) || BASE58.test(value))) return { hash: value as Hex, domain }
  if (BASE58.test(value)) return { hash: value as Hex, domain: SOLANA_DOMAIN }
  throw new HttpError(400, 'Invalid transaction hash.')
}

// ---- Circle attestation API (Iris) ----------------------------------------------------------------

let nextIrisSlot = 0

async function iris(path: string, init?: RequestInit) {
  // Circle blocks clients that exceed 40 requests/second for 5 minutes, so pace all calls to ≤ 20/s.
  const wait = nextIrisSlot - Date.now()
  nextIrisSlot = Math.max(nextIrisSlot, Date.now()) + 50
  if (wait > 0) await Bun.sleep(wait)
  const res = await fetch(IRIS_API + path, { ...init, signal: AbortSignal.timeout(10_000) }).catch(() => {
    throw new HttpError(502, 'Could not reach the Circle attestation API.')
  })
  if (res.status === 429) throw new HttpError(503, 'The Circle attestation API is rate limiting us, try again in a few minutes.')
  return res
}

async function fetchMessages(domain: number, txHash: string): Promise<IrisMessage[]> {
  const res = await iris(`/v2/messages/${domain}?transactionHash=${txHash}`)
  if (res.status === 404) return []
  if (!res.ok) throw new HttpError(502, `Circle attestation API error (${res.status}).`)
  const { messages = [] } = (await res.json()) as { messages?: IrisMessage[] }
  return messages.filter((m) => m.cctpVersion === 2) // Injective is on CCTP V2 only
}

const isAttested = (m?: IrisMessage): m is IrisMessage & { message: Hex } =>
  m?.status === 'complete' && !!m.message && m.message !== '0x' && !!m.attestation?.startsWith('0x')

// ---- Messages -------------------------------------------------------------------------------------

// bytes32 → 0x address when it holds an EVM address (Solana & co. keep all 32 bytes)
const word = (b: Hex) => (b.startsWith('0x000000000000000000000000') ? `0x${b.slice(26)}` : b).toLowerCase()

// MessageV2 header (148 bytes) + BurnMessageV2 body: https://developers.circle.com/cctp/references/technical-guide
// Only USDC moving to or from Injective decodes: on that side of the message, sender (outbound) or recipient (inbound) is the TokenMessenger.
function decodeBurn(message: Hex) {
  const field = (offset: number, length: number) => slice(message, offset, offset + length)
  if (size(message) < 376) return
  const sourceDomain = hexToNumber(field(4, 4))
  const destinationDomain = hexToNumber(field(8, 4))
  const local = sourceDomain === INJECTIVE_DOMAIN ? field(44, 32) : destinationDomain === INJECTIVE_DOMAIN ? field(76, 32) : undefined
  if (!local || !same(word(local), TOKEN_MESSENGER)) return
  return {
    destinationDomain,
    destinationCaller: word(field(108, 32)),
    fast: hexToNumber(field(140, 4)) <= 1000,
    recipient: word(field(184, 32)),
    amount: hexToBigInt(field(216, 32)),
    sender: word(field(248, 32)),
    feeExecuted: hexToBigInt(field(312, 32)),
    expirationBlock: hexToBigInt(field(344, 32)),
    forward: size(message) >= 388 && same(field(376, 12), FORWARD_HOOK),
  }
}

// Finds the EVM chain a tx hash belongs to.
async function locate(hash: Hex): Promise<{ domain: number; receipt?: TransactionReceipt }> {
  const indexed = domainOf(hash)
  if (indexed !== undefined) return { domain: indexed }
  try {
    return await Promise.any(
      chains.map(async ({ domain, client }) => {
        const receipt = await Promise.race([client.getTransactionReceipt({ hash }), Bun.sleep(8000).then(() => Promise.reject())])
        indexReceipt(domain, receipt)
        return { domain, receipt }
      }),
    )
  } catch {
    throw new HttpError(404, 'Transaction not found on any supported chain.')
  }
}

// CCTP messages emitted on the source chain, in log order.
async function sentMessages(domain: number, hash: Hex, receipt?: TransactionReceipt): Promise<Hex[]> {
  receipt ??= await chainOf(domain)?.client.getTransactionReceipt({ hash }).catch(() => undefined)
  if (!receipt) return []
  return parseEventLogs({ abi: [MessageSent], logs: receipt.logs })
    .filter((log) => same(log.address, MESSAGE_TRANSMITTER))
    .map((log) => log.args.message)
}

// Whether the destination chain already minted a message (undefined for chains we can't read).
async function minted(domain: number, nonce: Hex) {
  const chain = chainOf(domain)
  if (!chain) return
  const used = await chain.client.readContract({ address: MESSAGE_TRANSMITTER, abi: transmitterAbi, functionName: 'usedNonces', args: [nonce] }).catch(() => {
    throw new HttpError(502, `Could not reach ${chain.name}, try again.`)
  })
  return used !== 0n
}

// Resolves every transfer to or from Injective in a burn transaction, with its current status.
async function inspect(input: string, domainHint?: number): Promise<Found[]> {
  const { hash, domain: hinted } = parseTx(input, domainHint)
  const { domain, receipt } = hinted === undefined ? await locate(hash) : { domain: hinted, receipt: undefined }
  const time = burnTime(domain, hash)
  const done = doneTransfers<Transfer>(domain, hash)
  if (done) return done.map((transfer) => ({ transfer: { ...transfer, time } }))

  // Circle lists the tx's messages in log order, but leaves out the message bytes until it has
  // attested them. Until then, the MessageSent events on the source chain tell us where funds go.
  const messages = await fetchMessages(domain, hash)
  let onchain: Hex[] | undefined
  const count = messages.length || (onchain = await sentMessages(domain, hash, receipt)).length
  if (!count) throw new HttpError(404, 'No CCTP transfer found for this transaction.')

  const found: Found[] = []
  for (let i = 0; i < count; i++) {
    const m = messages[i]
    const raw = isAttested(m) ? m.message : (onchain ??= await sentMessages(domain, hash, receipt))[i]
    const burn = raw && decodeBurn(raw)
    // Without the bytes (non-EVM sources before attestation) a transfer is assumed to be headed to Injective.
    if (raw ? !burn : domain === INJECTIVE_DOMAIN) continue
    const destination = burn?.destinationDomain ?? INJECTIVE_DOMAIN
    found.push({
      burn,
      iris: m,
      message: isAttested(m) ? m.message : undefined,
      attestation: isAttested(m) ? (m.attestation as Hex) : undefined,
      transfer: {
        sourceDomain: domain,
        sourceChain: domainName(domain) ?? `Domain ${domain}`,
        destinationDomain: destination,
        destinationChain: domainName(destination) ?? `Domain ${destination}`,
        txHash: hash,
        txUrl: txUrl(domain, hash),
        nonce: m?.eventNonce,
        amount: burn && formatUnits(burn.amount, 6),
        sender: burn?.sender,
        recipient: burn?.recipient,
        time,
        status: 'pending',
        note: !m
          ? 'Waiting for Circle to pick up the burn.'
          : `Waiting for Circle's attestation, ${!burn?.fast && SLOW_FINALITY[domain] ? `this can take ${SLOW_FINALITY[domain]}` : 'usually under a minute'}.`,
      },
    })
  }
  if (!found.length) throw new HttpError(404, 'This transaction did not move USDC to or from Injective.')

  await Promise.all(found.map(resolve))
  for (const { transfer: t } of found) if (t.nonce && t.destinationDomain === INJECTIVE_DOMAIN) linkMint(t.nonce, hash)
  if (found.every((f) => f.transfer.status === 'redeemed')) finish(found)
  return found
}

// Once every transfer in a tx is minted nothing about it changes, so it's stored and Circle isn't asked again.
function finish(found: Found[]) {
  const { sourceDomain, txHash } = found[0]!.transfer
  markRedeemed(sourceDomain, txHash, found.map(({ transfer: { time, ...rest } }) => rest))
}

// An attested transfer is minted already, on its way through Circle's Forwarding Service, or ready to mint.
async function resolve({ transfer: t, burn, iris: m, message, attestation }: Found) {
  if (!attestation || !burn) return
  const inbound = t.destinationDomain === INJECTIVE_DOMAIN
  t.note = undefined
  if (burn.feeExecuted) t.fee = formatUnits(burn.feeExecuted, 6)
  const mintTx = m?.destinationMintTxHash ?? (m?.forwardState === 'COMPLETE' ? m.forwardTxHash : null) ?? (inbound ? mintOf(t.nonce!)?.txHash : undefined)
  if (mintTx || (await minted(t.destinationDomain, t.nonce!))) {
    t.status = 'redeemed'
    t.redeemTx = mintTx ?? redeemTxOf(t.nonce!)
    t.redeemTxUrl = t.redeemTx && txUrl(t.destinationDomain, t.redeemTx)
  } else if (!inbound && burn.forward && (!m?.forwardState || m.forwardState === 'PENDING')) {
    t.note = `Circle is delivering it to ${t.destinationChain}.`
  } else if (!/^0x0+$/.test(burn.destinationCaller) && !(inbound && same(burn.destinationCaller, relayer?.account.address))) {
    t.status = 'restricted'
    t.note = `Only ${burn.destinationCaller} can redeem this transfer.`
  } else if (inbound && burn.amount < minRedeemAmount) {
    t.status = 'restricted'
    t.note = `Transfers below ${formatUnits(minRedeemAmount, 6)} USDC are not redeemed by this service, claim it with your wallet.`
    t.message = message
    t.attestation = attestation
  } else {
    t.status = 'ready'
    // Lets the recipient (or any app) mint it with receiveMessage on the destination chain.
    t.message = message
    t.attestation = attestation
    if (!inbound) t.note = burn.forward ? `Circle could not deliver it, claim it on ${t.destinationChain}.` : `Ready to claim on ${t.destinationChain}.`
  }
}

// ---- Public API -----------------------------------------------------------------------------------

export async function lookupTx(hash: string, domain?: number) {
  return { transfers: (await inspect(hash, domain)).map((f) => f.transfer) }
}

export async function lookupAddress(input: string) {
  const address = parseAddress(input)
  const results = await Promise.all(unredeemedTxs(address).map((tx) => inspect(tx.txHash, tx.domain).catch(() => [])))
  const transfers = results
    .flat()
    .map((f) => f.transfer)
    .filter((t) => t.status !== 'redeemed' && (same(t.recipient, address) || same(t.sender, address)))
  return { address, transfers }
}

const HISTORY_PAGE = 20

// Everything indexed that moved USDC from or to an address, newest first, a page at a time.
export async function history(input: string, offset = 0) {
  const address = parseAddress(input)
  let rows = historyRows(address, HISTORY_PAGE + 1, offset)
  // Linking a mint to its burn tx also drops that tx from the page, where it would show up twice.
  const unlinked = rows.filter((r) => r.kind === 'mint' && !r.txHash)
  if (unlinked.length) {
    await Promise.all(unlinked.map((r) => sourceTxOf(r.domain, r.nonce!).then((tx) => tx && linkMint(r.nonce!, tx), () => {})))
    rows = historyRows(address, HISTORY_PAGE + 1, offset)
  }
  const page = rows.slice(0, HISTORY_PAGE)
  const results = await Promise.allSettled(
    page.map(async (r) => (r.kind === 'mint' ? [mintTransfer(mintOf(r.nonce!)!)] : (await inspect(r.txHash!, r.domain)).map((f) => f.transfer))),
  )
  // One tx failing shouldn't hide the rest, but if Circle or the RPCs are down for all of them, say so.
  const failed = results.filter((r) => r.status === 'rejected')
  if (page.length && failed.length === page.length) throw failed[0]!.reason
  const transfers = results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((t) => same(t.recipient, address) || same(t.sender, address))
  return { address, transfers, next: rows.length > HISTORY_PAGE ? offset + HISTORY_PAGE : null }
}

// A transfer that was minted on Injective, as far as the mint event tells.
function mintTransfer(m: MintRow): Transfer {
  return {
    sourceDomain: m.sourceDomain,
    sourceChain: domainName(m.sourceDomain) ?? `Domain ${m.sourceDomain}`,
    destinationDomain: INJECTIVE_DOMAIN,
    destinationChain: injective.name,
    txHash: m.sourceTx ?? '',
    txUrl: m.sourceTx ? txUrl(m.sourceDomain, m.sourceTx) : undefined,
    nonce: m.nonce,
    amount: formatUnits(BigInt(m.amount), 6),
    fee: m.fee === '0' ? undefined : formatUnits(BigInt(m.fee), 6),
    sender: m.sender,
    recipient: m.recipient,
    status: 'redeemed',
    redeemTx: m.txHash,
    redeemTxUrl: txUrl(INJECTIVE_DOMAIN, m.txHash),
    time: m.time,
  }
}

async function sourceTxOf(domain: number, nonce: string) {
  const res = await iris(`/v2/messages/${domain}?nonce=${nonce}`)
  if (!res.ok) return
  const { sourceTxHash } = (await res.json()) as { sourceTxHash?: string }
  return sourceTxHash && /^0x/.test(sourceTxHash) ? sourceTxHash.toLowerCase() : sourceTxHash
}

// Mints the tx's transfers to Injective that are ready, and queues the rest to be minted as soon as Circle attests them.
export async function redeem(hash: string, domain?: number) {
  if (!relayer) throw new HttpError(503, 'Redeeming is disabled on this server.')
  const found = await inspect(hash, domain)
  const inbound = found.filter((f) => f.transfer.destinationDomain === INJECTIVE_DOMAIN)
  if (!inbound.length) throw new HttpError(409, 'Transfers from Injective are minted on the destination chain, not by this service.')
  const ready = inbound.filter((f) => f.transfer.status === 'ready')
  const pending = inbound.filter((f) => f.transfer.status === 'pending')
  if (!ready.length && !pending.length) {
    const blocked = inbound.find((f) => f.transfer.status !== 'redeemed')?.transfer
    throw new HttpError(409, blocked ? (blocked.note ?? 'This transfer cannot be redeemed yet.') : 'This transfer has already been redeemed.')
  }
  await mint(ready)
  const { sourceDomain, txHash } = found[0]!.transfer
  // Whatever isn't minted yet (still pending, or a failed attempt) is retried by autoRedeem.
  if (inbound.some((f) => f.transfer.status === 'pending' || f.transfer.status === 'ready')) enqueue(sourceDomain, txHash)
  for (const { transfer: t } of pending) t.note = `${t.note} It will be minted automatically.`
  if (found.every((f) => f.transfer.status === 'redeemed')) finish(found)
  return { transfers: found.map((f) => f.transfer), queued: !ready.length }
}

export async function balance(domain: number, address: string) {
  const chain = chainOf(domain)
  if (!chain) throw new HttpError(400, `Unsupported chain (domain ${domain}).`)
  const owner = parseAddress(address)
  const units = await chain.client.readContract({ address: chain.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }).catch(() => {
    throw new HttpError(502, `Could not reach ${chain.name}, try again.`)
  })
  return { balance: formatUnits(units, 6) }
}

// ---- Fees -----------------------------------------------------------------------------------------

export type Fees = { fastBps: number | null; forwardFee: string | null; standardTime: string | null }
const feeCache = new Map<string, { expires: number; fees: Promise<Fees> }>()

// fastBps: Fast Transfer fee in bps of the amount, null when the source only has standard transfers.
// forwardFee: USDC that Circle's Forwarding Service takes to mint a transfer from Injective on the destination,
// null when it can't deliver there (the recipient then claims it on the destination chain).
// standardTime: average wait for a standard transfer, null when it's under a minute.
export async function fees(from: number, to: number): Promise<Fees> {
  if (!domainName(from) || !domainName(to) || from === to || (from !== INJECTIVE_DOMAIN && to !== INJECTIVE_DOMAIN))
    throw new HttpError(400, 'Only routes to or from Injective are supported.')
  const key = `${from}:${to}`
  let entry = feeCache.get(key)
  if (!entry || entry.expires < Date.now()) {
    entry = { expires: Date.now() + 60_000, fees: loadFees(from, to) }
    feeCache.set(key, entry)
    entry.fees.catch(() => feeCache.delete(key))
  }
  return entry.fees
}

async function loadFees(from: number, to: number): Promise<Fees> {
  const path = `/v2/burn/USDC/fees/${from}/${to}`
  const outbound = from === INJECTIVE_DOMAIN
  let res = await iris(outbound ? `${path}?forward=true` : path)
  const forwarding = outbound && res.ok // Circle answers 400 for destinations it can't forward to
  if (outbound && !res.ok) res = await iris(path)
  if (!res.ok) throw new HttpError(502, `Circle fee API error (${res.status}).`)
  const list = (await res.json()) as { finalityThreshold: number; minimumFee: number; forwardFee?: { med: number } }[]
  const fast = list.find((f) => f.finalityThreshold === 1000)?.minimumFee ?? 0
  const forwardFee = list.find((f) => f.finalityThreshold === 2000)?.forwardFee?.med
  return {
    fastBps: fast > 0 ? fast : null,
    forwardFee: forwarding && forwardFee !== undefined ? formatUnits(BigInt(forwardFee), 6) : null,
    standardTime: SLOW_FINALITY[from] ?? null,
  }
}

// ---- Relayer --------------------------------------------------------------------------------------

const inflight = new Map<string, Promise<Hex>>()
let queue = Promise.resolve()

// A single relayer key has a single nonce sequence, so transactions go out one at a time.
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task)
  queue = run.then(() => {}, () => {})
  return run
}

// Concurrent requests for the same message share one attempt.
function submit(f: Found): Promise<Hex> {
  const nonce = f.transfer.nonce!
  let job = inflight.get(nonce)
  if (!job) {
    job = refreshIfExpired(f)
      .then((fresh) => serial(() => send(fresh)))
      .finally(() => inflight.delete(nonce))
    inflight.set(nonce, job)
  }
  return job
}

// Each transfer's status and note say how its attempt went.
async function mint(ready: Found[]) {
  await Promise.all(
    ready.map(async (f) => {
      const t = f.transfer
      try {
        t.redeemTx = await submit(f)
        t.redeemTxUrl = txUrl(INJECTIVE_DOMAIN, t.redeemTx)
        t.status = 'redeemed'
      } catch (err) {
        const reason = describe(err)
        console.error(`[redeem] ${t.txHash} (${t.nonce}): ${reason}`)
        if (reason === 'Nonce already used') t.status = 'redeemed'
        else t.note = `Redeem failed: ${reason}`
      }
      if (t.status === 'redeemed') t.message = t.attestation = undefined
    }),
  )
}

async function send({ transfer, message, attestation }: Found): Promise<Hex> {
  const args = [message!, attestation!] as const
  const gas = await injective.client.estimateContractGas({ account: relayer!.account, address: MESSAGE_TRANSMITTER, abi: transmitterAbi, functionName: 'receiveMessage', args })
  // Padded: USDC on Injective runs a compliance hook on mint that fails when the gas limit is tight.
  const hash = await relayer!.writeContract({ address: MESSAGE_TRANSMITTER, abi: transmitterAbi, functionName: 'receiveMessage', args, gas: (gas * 3n) / 2n })
  const receipt = await injective.client.waitForTransactionReceipt({ hash, timeout: 60_000 })
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
  saveRedeem(transfer.nonce!, hash)
  console.log(`[redeem] ${transfer.amount} USDC from ${transfer.sourceChain} to ${transfer.recipient}: ${hash}`)
  return hash
}

// Fast-transfer attestations expire ~24h after signing, until Circle re-signs them on request.
async function refreshIfExpired(f: Found): Promise<Found> {
  const expiry = f.burn?.expirationBlock
  if (!expiry || expiry > (await injective.client.getBlockNumber())) return f
  const { nonce, sourceDomain, txHash } = f.transfer
  const res = await iris(`/v2/reattest/${nonce}`, { method: 'POST' })
  if (!res.ok) throw new Error(`the attestation expired and Circle refused to re-sign it (${res.status})`)
  for (let i = 0; i < 12; i++) {
    await Bun.sleep(5000)
    const m = (await fetchMessages(sourceDomain, txHash)).find((x) => x.eventNonce === nonce)
    const burn = isAttested(m) ? decodeBurn(m.message) : undefined
    if (burn && (!burn.expirationBlock || burn.expirationBlock > (await injective.client.getBlockNumber())))
      return { ...f, burn, message: m!.message!, attestation: m!.attestation as Hex }
  }
  throw new Error('the attestation expired and Circle has not re-signed it yet, try again in a few minutes')
}

function describe(err: unknown) {
  if (!(err instanceof BaseError)) return err instanceof Error ? err.message : String(err)
  if (err.walk((e) => e instanceof InsufficientFundsError)) return 'the relayer is out of gas funds, please contact the operator'
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError)
  return (revert instanceof ContractFunctionRevertedError && revert.reason) || err.shortMessage
}

// ---- Auto-redeem ----------------------------------------------------------------------------------

const QUEUE_HOURS = 72
const nextCheck = new Map<string, number>()

// Mints queued transfers once Circle attests them. A tx is checked every 10 s at first, backing off to every 5 min as it ages.
export async function autoRedeem() {
  if (!relayer) return
  while (true) {
    await Bun.sleep(5000)
    for (const { domain, txHash, added } of queuedTxs()) {
      const key = `${domain}:${txHash}`
      const now = Date.now()
      if (now - added > QUEUE_HOURS * 3_600_000) {
        dequeue(domain, txHash)
        nextCheck.delete(key)
        continue
      }
      if ((nextCheck.get(key) ?? 0) > now) continue
      nextCheck.set(key, now + Math.min(Math.max((now - added) / 10, 10_000), 300_000))
      try {
        const found = await inspect(txHash, domain)
        const inbound = found.filter((f) => f.transfer.destinationDomain === INJECTIVE_DOMAIN)
        await mint(inbound.filter((f) => f.transfer.status === 'ready'))
        if (found.every((f) => f.transfer.status === 'redeemed')) finish(found)
        if (inbound.every((f) => f.transfer.status === 'redeemed' || f.transfer.status === 'restricted')) {
          dequeue(domain, txHash)
          nextCheck.delete(key)
        }
      } catch (err) {
        if (!(err instanceof HttpError)) console.error(`[auto-redeem] ${txHash}:`, err)
      }
    }
  }
}
