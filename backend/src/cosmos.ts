import { HttpError } from './cctp'
import type { ChainInfo } from './chains'
import { rpcEnv } from './config'

// Sending from Cosmos chains. The server builds each transaction (protobuf, SIGN_MODE_DIRECT) and broadcasts it, so the
// page only asks the wallet (Keplr, Leap, Cosmostation) to sign. Chains are reached over REST: cosmos.directory's
// proxy or a node from the chain registry, else REST_<ID> (e.g. REST_OSMOSIS), comma-separated for fallback.

// ---- Protocol Buffers, as much as these messages need ------------------------------------------------

class Proto {
  private out: number[] = []
  private varint(n: bigint) {
    for (; n > 127n; n >>= 7n) this.out.push(Number(n & 127n) | 128)
    this.out.push(Number(n))
  }
  private key(field: number, wire: number) {
    this.varint(BigInt((field << 3) | wire))
  }
  // Zero and empty values are left out, as proto3 does.
  uint(field: number, value?: bigint | number | string) {
    const n = BigInt(value ?? 0)
    if (n < 0n) throw new Error('Negative varint')
    if (n) {
      this.key(field, 0)
      this.varint(n)
    }
    return this
  }
  bool(field: number, value?: boolean) {
    return this.uint(field, value ? 1 : 0)
  }
  bytes(field: number, value?: Uint8Array, always = false) {
    if (value?.length || always) {
      this.key(field, 2)
      this.varint(BigInt(value?.length ?? 0))
      for (const b of value ?? []) this.out.push(b)
    }
    return this
  }
  string(field: number, value?: string) {
    return this.bytes(field, value ? new TextEncoder().encode(value) : undefined)
  }
  message(field: number, build: (m: Proto) => unknown) {
    const m = new Proto()
    build(m)
    return this.bytes(field, m.finish(), true)
  }
  finish() {
    return Uint8Array.from(this.out)
  }
}

// ---- Skip's messages ---------------------------------------------------------------------------------

// JSON.parse, but numbers stay as written (Skip's nanosecond timeouts don't fit a double) and each object keeps its
// own text, so a contract message is signed byte for byte as Skip wrote it.
const SOURCE = Symbol('source')
type Json = string | boolean | null | Json[] | { [key: string]: Json }
function parseJson(text: string): Json {
  let at = 0
  const fail = (): never => {
    throw new Error(`Invalid JSON at ${at}`)
  }
  const space = () => {
    while (at < text.length && ' \t\n\r'.includes(text[at]!)) at++
  }
  const token = (re: RegExp) => {
    re.lastIndex = at
    const m = re.exec(text) ?? fail()
    at = re.lastIndex
    return m[0]
  }
  const STRING = /"(?:[^"\\]|\\.)*"/y
  const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y
  const value = (): Json => {
    space()
    const start = at
    const open = text[at]
    if (open === '"') return JSON.parse(token(STRING)) as string
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const) if (text.startsWith(word, at)) return (at += word.length), v
    if (open !== '{' && open !== '[') return token(NUMBER)
    at++
    const object: Record<string, Json> = Object.create(null)
    const list: Json[] = []
    space()
    if (text[at] !== (open === '{' ? '}' : ']'))
      for (;;) {
        if (open === '{') {
          space()
          const key = JSON.parse(token(STRING)) as string
          space()
          if (text[at++] !== ':') fail()
          object[key] = value()
        } else list.push(value())
        space()
        if (text[at] !== ',') break
        at++
      }
    if (text[at++] !== (open === '{' ? '}' : ']')) fail()
    const result = open === '{' ? object : list
    Object.defineProperty(result, SOURCE, { value: text.slice(start, at) })
    return result
  }
  const result = value()
  space()
  if (at !== text.length) fail()
  return result
}

type Fields = Record<string, any>
type Coin = { denom: string; amount: string }
const coin = (m: Proto, c: Coin) => m.string(1, c.denom).string(2, String(c.amount))
const base64Bytes = (value?: string) => (value ? Uint8Array.from(Buffer.from(value, 'base64')) : undefined)

// The messages Skip's Cosmos routes use, with their fields (ibc-go, wasmd, cosmos-sdk and Circle's CCTP module protos).
// A message with a field not listed here isn't signed: it would be dropped from what the user agreed to.
const MESSAGES: Record<string, { fields: string[]; encode: (m: Proto, f: Fields) => unknown }> = {
  '/ibc.applications.transfer.v1.MsgTransfer': {
    fields: ['source_port', 'source_channel', 'token', 'sender', 'receiver', 'timeout_height', 'timeout_timestamp', 'memo', 'encoding', 'use_aliasing'],
    encode: (m, f) =>
      m
        .string(1, f.source_port)
        .string(2, f.source_channel)
        .message(3, (c) => coin(c, f.token))
        .string(4, f.sender)
        .string(5, f.receiver)
        .message(6, (h) => h.uint(1, f.timeout_height?.revision_number).uint(2, f.timeout_height?.revision_height))
        .uint(7, f.timeout_timestamp)
        .string(8, f.memo)
        .string(9, f.encoding)
        .bool(10, f.use_aliasing),
  },
  '/cosmwasm.wasm.v1.MsgExecuteContract': {
    fields: ['sender', 'contract', 'msg', 'funds'],
    encode: (m, f) => {
      const msg = typeof f.msg === 'string' ? f.msg : (f.msg as { [SOURCE]: string })[SOURCE]
      m.string(1, f.sender).string(2, f.contract).string(3, msg)
      for (const c of f.funds ?? []) m.message(5, (x) => coin(x, c))
    },
  },
  '/cosmos.bank.v1beta1.MsgSend': {
    fields: ['from_address', 'to_address', 'amount'],
    encode: (m, f) => {
      m.string(1, f.from_address).string(2, f.to_address)
      for (const c of f.amount ?? []) m.message(3, (x) => coin(x, c))
    },
  },
  '/circle.cctp.v1.MsgDepositForBurn': {
    fields: ['from', 'amount', 'destination_domain', 'mint_recipient', 'burn_token'],
    encode: (m, f) => m.string(1, f.from).string(2, String(f.amount)).uint(3, f.destination_domain).bytes(4, base64Bytes(f.mint_recipient)).string(5, f.burn_token),
  },
  '/circle.cctp.v1.MsgDepositForBurnWithCaller': {
    fields: ['from', 'amount', 'destination_domain', 'mint_recipient', 'burn_token', 'destination_caller'],
    encode: (m, f) =>
      m
        .string(1, f.from)
        .string(2, String(f.amount))
        .uint(3, f.destination_domain)
        .bytes(4, base64Bytes(f.mint_recipient))
        .string(5, f.burn_token)
        .bytes(6, base64Bytes(f.destination_caller)),
  },
}

export type CosmosMessage = { typeUrl: string; value: string } // value: the message's protobuf, base64

// One of Skip's messages ({ msg: JSON text, msg_type_url }) in protobuf, undefined if it isn't one the app signs.
export function encodeMessage(typeUrl: string, json: string): CosmosMessage | undefined {
  const message = MESSAGES[typeUrl]
  if (!message) return
  const fields = parseJson(json) as Fields
  if (!fields || typeof fields !== 'object' || Object.keys(fields).some((k) => !message.fields.includes(k))) return
  const m = new Proto()
  message.encode(m, fields)
  return { typeUrl, value: Buffer.from(m.finish()).toString('base64') }
}

// ---- Transactions ------------------------------------------------------------------------------------

const PUBKEYS = {
  secp256k1: '/cosmos.crypto.secp256k1.PubKey',
  injective: '/injective.crypto.v1beta1.ethsecp256k1.PubKey',
  cosmosEvm: '/cosmos.evm.crypto.v1.ethsecp256k1.PubKey',
  ethermint: '/ethermint.crypto.v1.ethsecp256k1.PubKey',
}
const SIGN_MODE_DIRECT = 1

const any = (m: Proto, typeUrl: string, value: Uint8Array) => m.string(1, typeUrl).bytes(2, value)

function authInfo(pubKeyType: string, pubKey: Uint8Array, sequence: bigint, fee: { amount: Coin[]; gas: bigint }) {
  return new Proto()
    .message(1, (signer) =>
      signer
        .message(1, (key) => any(key, pubKeyType, new Proto().bytes(1, pubKey).finish()))
        .message(2, (mode) => mode.message(1, (single) => single.uint(1, SIGN_MODE_DIRECT)))
        .uint(3, sequence),
    )
    .message(2, (f) => {
      for (const c of fee.amount) f.message(1, (x) => coin(x, c))
      f.uint(2, fee.gas)
    })
    .finish()
}

const txRaw = (body: Uint8Array, auth: Uint8Array, signature: Uint8Array) => new Proto().bytes(1, body).bytes(2, auth).bytes(3, signature, true).finish()
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

// ---- REST --------------------------------------------------------------------------------------------

const restUrls = (chain: ChainInfo) => [
  ...(process.env[rpcEnv(chain.id).replace(/^RPC_/, 'REST_')]?.split(',').map((u) => u.trim()).filter(Boolean) ?? []),
  ...(chain.rest ? [chain.rest] : []),
]

// The chain's answer, from the first node that gives one. A node's own error (a gRPC code and message) is the answer;
// a node that's down or busy passes to the next.
async function rest<T>(chain: ChainInfo, path: string, body?: unknown): Promise<T> {
  const urls = restUrls(chain)
  if (!urls.length) throw new HttpError(400, `No REST endpoint for ${chain.name}: set ${rpcEnv(chain.id).replace(/^RPC_/, 'REST_')}.`)
  for (const url of urls) {
    const res = await fetch(url + path, {
      method: body ? 'POST' : 'GET',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined)
    if (!res) continue
    const json = (await res.json().catch(() => undefined)) as (T & { code?: number; message?: string }) | undefined
    if (res.ok && json) return json
    if (json?.message && res.status !== 429 && res.status < 502) throw new CosmosError(res.status, json.message)
  }
  throw new HttpError(502, `Could not reach ${chain.name}, try again.`)
}
export class CosmosError extends HttpError {}

// Accounts nest the base account differently per type (Injective's EthAccount, vesting accounts…).
type BaseAccount = { account_number: string; sequence: string; pub_key?: { '@type': string } | null }
function baseAccount(value: unknown): BaseAccount | undefined {
  if (!value || typeof value !== 'object') return
  if ('account_number' in value) return value as BaseAccount
  for (const v of Object.values(value)) {
    const found = baseAccount(v)
    if (found) return found
  }
}

async function account(chain: ChainInfo, address: string) {
  const res = await rest<{ account: unknown }>(chain, `/cosmos/auth/v1beta1/accounts/${address}`).catch((err) => {
    if (err instanceof CosmosError && /not found/i.test(err.message)) throw new HttpError(400, `${address} has no account on ${chain.name} yet: it needs funds first.`)
    throw err
  })
  const base = baseAccount(res.account)
  if (!base) throw new HttpError(502, `Unexpected account from ${chain.name}.`)
  return { number: BigInt(base.account_number), sequence: BigInt(base.sequence), pubKeyType: base.pub_key?.['@type'] }
}

export type PrepareBody = { chain: ChainInfo; signer: string; pubKey: string; algo?: string; messages: CosmosMessage[]; memo?: string }

// An unsigned transaction for the wallet: the messages, the account's sequence, gas from a simulation (half again, for
// safety) and the fee at the chain's usual gas price. The key type comes from the account (if it has signed before),
// else from the wallet: Ethereum-style keys have a type URL per chain family, and the simulation tells which one fits.
export async function prepare({ chain, signer, pubKey, algo, messages, memo }: PrepareBody) {
  if (chain.kind !== 'cosmos' || !chain.gas) throw new HttpError(400, `Sending from ${chain.name} isn't supported.`)
  const key = Uint8Array.from(Buffer.from(pubKey, 'base64'))
  if (key.length !== 33) throw new HttpError(400, 'Invalid public key.')
  const acct = await account(chain, signer)
  const body = new Proto()
  for (const m of messages) body.message(1, (a) => any(a, m.typeUrl, Uint8Array.from(Buffer.from(m.value, 'base64'))))
  const bodyBytes = body.string(2, memo).finish()

  const eth = algo === 'ethsecp256k1' || (!algo && chain.slip44 === 60)
  const types = acct.pubKeyType
    ? [acct.pubKeyType]
    : !eth
      ? [PUBKEYS.secp256k1]
      : chain.cosmosId?.startsWith('injective')
        ? [PUBKEYS.injective]
        : [PUBKEYS.cosmosEvm, PUBKEYS.ethermint]
  for (const [i, type] of types.entries()) {
    const unsigned = txRaw(bodyBytes, authInfo(type, key, acct.sequence, { amount: [], gas: 0n }), new Uint8Array())
    const simulated = await rest<{ gas_info: { gas_used: string } }>(chain, '/cosmos/tx/v1beta1/simulate', { tx_bytes: b64(unsigned) }).catch((err) => {
      // Another chain family's key type: try the next.
      if (err instanceof CosmosError && i < types.length - 1 && /type url|unrecognized|no concrete type/i.test(err.message)) return undefined
      if (err instanceof CosmosError) throw new HttpError(400, simulationError(err.message))
      throw err
    })
    if (!simulated) continue
    const gas = (BigInt(simulated.gas_info.gas_used) * 3n) / 2n + 20_000n
    const amount = ceilMul(gas, chain.gas.price)
    const fee = { amount: amount > 0n ? [{ denom: chain.gas.denom, amount: amount.toString() }] : [], gas }
    return {
      chainId: chain.cosmosId!,
      accountNumber: acct.number.toString(),
      bodyBytes: b64(bodyBytes),
      authInfoBytes: b64(authInfo(type, key, acct.sequence, fee)),
      fee: { denom: chain.gas.denom, amount: amount.toString(), gas: gas.toString() },
    }
  }
  throw new HttpError(400, `Could not build a transaction for ${chain.name}.`)
}

// The part of a failed simulation worth showing: "spendable balance 0uatom is smaller than 1000uatom: insufficient funds".
// The node's reason, without its wrapping, source locations ("[cosmos/cosmos-sdk@v0.50/x/auth/ante/sigverify.go:108]")
// or gas figures.
function simulationError(message: string) {
  const reason = message
    .replace(/^.*?(?:failed to execute message; message index: \d+: |rpc error: code = \w+ desc = )/, '')
    .replace(/\s*\[[^\]]*\.go:\d+\]/g, '')
    .replace(/\s*with gas used: '?\d+'?/, '')
    .trim()
  const text = reason.charAt(0).toUpperCase() + reason.slice(1)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

// gas × a decimal gas price, rounded up.
function ceilMul(gas: bigint, price: string) {
  const [whole, fraction = ''] = price.split('.')
  const scale = 10n ** BigInt(fraction.length)
  return (gas * BigInt(`${whole}${fraction}` || '0') + scale - 1n) / scale
}

export type BroadcastBody = { chain: ChainInfo; bodyBytes: string; authInfoBytes: string; signature: string }

// The signed transaction, as the wallet returned it (it may have changed the fee): checked by the node, not yet in a block.
export async function broadcast({ chain, bodyBytes, authInfoBytes, signature }: BroadcastBody) {
  const tx = txRaw(base64Bytes(bodyBytes)!, base64Bytes(authInfoBytes)!, base64Bytes(signature)!)
  type Res = { tx_response: { txhash: string; code: number; raw_log?: string } }
  const { tx_response: r } = await rest<Res>(chain, '/cosmos/tx/v1beta1/txs', { tx_bytes: b64(tx), mode: 'BROADCAST_MODE_SYNC' }).catch((err) => {
    throw err instanceof CosmosError ? new HttpError(400, simulationError(err.message)) : err
  })
  if (r.code !== 0) throw new HttpError(400, simulationError(r.raw_log || `Rejected with code ${r.code}.`))
  return { txHash: r.txhash }
}

// pending until it's in a block, then whether it succeeded.
export async function txStatus(chain: ChainInfo, hash: string) {
  type Res = { tx_response: { height: string; code: number; raw_log?: string } }
  const res = await rest<Res>(chain, `/cosmos/tx/v1beta1/txs/${hash}`).catch((err) => {
    if (err instanceof CosmosError && /not found/i.test(err.message)) return undefined
    throw err
  })
  if (!res) return { status: 'pending' as const }
  const r = res.tx_response
  return r.code === 0 ? { status: 'success' as const, height: r.height } : { status: 'failed' as const, height: r.height, error: simulationError(r.raw_log || `Failed with code ${r.code}.`) }
}

export async function cosmosBalance(chain: ChainInfo, address: string, denom: string) {
  const res = await rest<{ balance?: { amount: string } }>(chain, `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`)
  return res.balance?.amount ?? '0'
}
