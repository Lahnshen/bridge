import { formatUnits, hashTypedData, recoverPublicKey, type Hex } from 'viem'
import { publicKeyToAddress } from 'viem/accounts'
import { bech32Decode } from './bech32'
import { HttpError } from './cctp'
import type { ChainInfo } from './chains'
import { rpcEnv } from './config'

// Sending from Cosmos chains. The server builds each transaction (protobuf, SIGN_MODE_DIRECT) and broadcasts it, so the
// page only asks the wallet (Keplr) to sign. On Injective an EVM wallet can sign instead, as EIP-712 typed data (below). Chains are reached over REST: cosmos.directory's
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

// ---- EIP-712: Injective's Cosmos side, signed by an EVM wallet ---------------------------------------

// Injective also takes Cosmos transactions signed as EIP-712 typed data (SIGN_MODE_EIP712_V2, with a Web3 extension in the
// body), so an EVM wallet sends there without Keplr. The chain rebuilds the typed data from the transaction and checks the
// signature against it: its context is the account, fee and memo, and its msgs each message in the chain's own JSON (Go's
// jsonpb with every field, then encoding/json, which escapes <, > and &), so both are written here exactly as Go does.
// See injective-core's app/ante/eip712.go and eip712_cosmos.go (WrapTxToEIP712V2).

const SIGN_MODE_EIP712_V2 = 128
const WEB3_EXTENSION = '/injective.types.v1beta1.ExtensionOptionsWeb3Tx'
// The EVM chain ids the chain takes in the domain (Ethereum's and Injective EVM's), so the wallet signs where it is.
export const EIP712_CHAINS: Record<string, number[]> = { 'injective-1': [1, 1776], 'injective-888': [11155111, 1439] }
export const EIP712_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'string' },
  ],
  Tx: [
    { name: 'context', type: 'string' },
    { name: 'msgs', type: 'string' },
  ],
}
export const eip712Domain = (chainId: number) => ({
  name: 'Injective Web3',
  version: '1.0.0',
  chainId: `0x${chainId.toString(16)}`,
  verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  salt: '0',
})
export type TypedData = { types: typeof EIP712_TYPES; primaryType: 'Tx'; domain: ReturnType<typeof eip712Domain>; message: { context: string; msgs: string } }

// A string as Go's encoding/json writes it.
const GO_ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }
const goString = (s: string) => `"${s.replace(/["\\\u0000-\u001f<>&\u2028\u2029]/g, (c) => GO_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`

// JSON text as Go compacts it: without the spaces, and with <, > and & escaped. A contract's message is signed so.
function goCompact(text: string) {
  let out = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (!quoted) {
      if (!' \t\n\r'.includes(c)) out += c
      quoted = c === '"'
    } else if (c === '\\') out += c + text[++i]
    else {
      out += c === '<' || c === '>' || c === '&' || c === '\u2028' || c === '\u2029' ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c
      quoted = c !== '"'
    }
  }
  return out
}

// Protobuf read back into fields: varints, and the rest as bytes.
type Wire = bigint | Uint8Array
function readProto(bytes: Uint8Array) {
  const invalid = () => new HttpError(400, 'Invalid message in the transaction.')
  const fields = new Map<number, Wire[]>()
  let at = 0
  const varint = () => {
    let n = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (at >= bytes.length) break
      const b = bytes[at++]!
      n |= BigInt(b & 127) << shift
      if (b < 128) return n
    }
    throw invalid()
  }
  while (at < bytes.length) {
    const key = varint()
    const [field, wire] = [Number(key >> 3n), Number(key & 7n)]
    let value: Wire
    if (wire === 0) value = varint()
    else if (wire === 2) {
      const length = Number(varint())
      const end = at + length
      if (end > bytes.length) throw invalid()
      value = bytes.subarray(at, (at = end))
    } else throw invalid()
    fields.set(field, [...(fields.get(field) ?? []), value])
  }
  return fields
}

// The messages' fields as Injective has them (ibc-go v8, wasmd 0.54, cosmos-sdk 0.50), in order: jsonpb writes them all,
// empty ones too. Other messages aren't signed this way.
type Schema = [name: string, field: number, kind: 'string' | 'int' | 'uint64' | 'json' | Schema, repeated?: true][]
const COIN: Schema = [['denom', 1, 'string'], ['amount', 2, 'int']]
const HEIGHT: Schema = [['revision_number', 1, 'uint64'], ['revision_height', 2, 'uint64']]
const JSON_SCHEMAS: Record<string, Schema> = {
  '/ibc.applications.transfer.v1.MsgTransfer': [
    ['source_port', 1, 'string'],
    ['source_channel', 2, 'string'],
    ['token', 3, COIN],
    ['sender', 4, 'string'],
    ['receiver', 5, 'string'],
    ['timeout_height', 6, HEIGHT],
    ['timeout_timestamp', 7, 'uint64'],
    ['memo', 8, 'string'],
  ],
  '/cosmwasm.wasm.v1.MsgExecuteContract': [['sender', 1, 'string'], ['contract', 2, 'string'], ['msg', 3, 'json'], ['funds', 5, COIN, true]],
  '/cosmos.bank.v1beta1.MsgSend': [['from_address', 1, 'string'], ['to_address', 2, 'string'], ['amount', 3, COIN, true]],
}

const utf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new HttpError(400, 'Invalid text in a message.')
  }
}
function protoJson(schema: Schema, bytes: Uint8Array, prefix = ''): string {
  const fields = readProto(bytes)
  const unexpected = () => new HttpError(400, 'A message has fields Injective EIP-712 signing does not cover.')
  if ([...fields.keys()].some((n) => !schema.some(([, f]) => f === n))) throw unexpected()
  const parts = schema.map(([name, field, kind, repeated]) => {
    const values = fields.get(field) ?? []
    if (!repeated && values.length > 1) throw unexpected()
    const one = (v?: Wire) => {
      if (kind === 'uint64') {
        if (v instanceof Uint8Array) throw unexpected()
        return `"${v ?? 0n}"`
      }
      if (typeof v === 'bigint') throw unexpected()
      if (kind === 'string' || kind === 'int') return goString(utf8(v ?? new Uint8Array()) || (kind === 'int' ? '0' : '')) // an Int is never empty
      if (kind !== 'json') return protoJson(kind, v ?? new Uint8Array())
      const text = utf8(v ?? new Uint8Array())
      parseJson(text) // the chain refuses a message that isn't JSON
      return goCompact(text)
    }
    return `${goString(name)}:${repeated ? `[${values.map(one).join(',')}]` : one(values[0])}`
  })
  return `{${prefix}${parts.join(',')}}`
}

// The msgs of the typed data: each message as the chain writes it (MarshalInterfaceJSON: its type first).
function eip712Msgs(messages: CosmosMessage[]) {
  const json = messages.map((m) => {
    const schema = JSON_SCHEMAS[m.typeUrl]
    if (!schema) throw new HttpError(400, `${m.typeUrl.split('.').pop()} can't be signed with an EVM wallet: connect Keplr.`)
    return protoJson(schema, Uint8Array.from(Buffer.from(m.value, 'base64')), `"@type":${goString(m.typeUrl)},`)
  })
  return `[${json.join(',')}]`
}

// The typed data the EVM wallet signs, as the chain rebuilds it: the context's keys sorted, as Go writes a map.
export function eip712TypedData(chainId: string, evmChainId: number, account: { number: bigint; sequence: bigint }, fee: { amount: Coin[]; gas: bigint }, messages: CosmosMessage[], memo = ''): TypedData {
  const coins = fee.amount.map((c) => `{"denom":${goString(c.denom)},"amount":${goString(c.amount)}}`).join(',')
  const context = `{"account_number":${account.number},"chain_id":${goString(chainId)},"fee":{"amount":[${coins}],"gas":${fee.gas}},"memo":${goString(memo)},"sequence":${account.sequence},"timeout_height":0}`
  return { types: EIP712_TYPES, primaryType: 'Tx', domain: eip712Domain(evmChainId), message: { context, msgs: eip712Msgs(messages) } }
}

// A body's messages and memo, read back (to check them against what was signed).
function readBody(bytes: Uint8Array) {
  const fields = readProto(bytes)
  const text = (v?: Wire) => (v instanceof Uint8Array ? utf8(v) : '')
  const messages = (fields.get(1) ?? []).map((v) => {
    const any = readProto(v as Uint8Array)
    return { typeUrl: text(any.get(1)?.[0]), value: Buffer.from((any.get(2)?.[0] as Uint8Array | undefined) ?? []).toString('base64') }
  })
  return { messages, memo: text(fields.get(2)?.[0]), extensions: fields.get(1023)?.length ?? 0, other: [...fields.keys()].some((n) => ![1, 2, 1023].includes(n)) }
}

// ---- Transactions ------------------------------------------------------------------------------------

const PUBKEYS = {
  secp256k1: '/cosmos.crypto.secp256k1.PubKey',
  injective: '/injective.crypto.v1beta1.ethsecp256k1.PubKey',
  cosmosEvm: '/cosmos.evm.crypto.v1.ethsecp256k1.PubKey',
  ethermint: '/ethermint.crypto.v1.ethsecp256k1.PubKey',
}
const SIGN_MODE_DIRECT = 1
// For simulating an EIP-712 transaction before the wallet signs (and so before its key is known): any key of the type does,
// as simulations don't check it. This one is secp256k1's generator point.
const PLACEHOLDER_KEY = Uint8Array.from(Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'))

const any = (m: Proto, typeUrl: string, value: Uint8Array) => m.string(1, typeUrl).bytes(2, value)

function authInfo(pubKeyType: string, pubKey: Uint8Array, sequence: bigint, fee: { amount: Coin[]; gas: bigint }, mode = SIGN_MODE_DIRECT) {
  return new Proto()
    .message(1, (signer) =>
      signer
        .message(1, (key) => any(key, pubKeyType, new Proto().bytes(1, pubKey).finish()))
        .message(2, (m) => m.message(1, (single) => single.uint(1, mode)))
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

export type PrepareBody = { chain: ChainInfo; signer: string; pubKey?: string; algo?: string; messages: CosmosMessage[]; memo?: string; evm?: number }

export const bodyOf = (messages: CosmosMessage[], memo?: string, evm?: number) => {
  const body = new Proto()
  for (const m of messages) body.message(1, (a) => any(a, m.typeUrl, Uint8Array.from(Buffer.from(m.value, 'base64'))))
  body.string(2, memo)
  if (evm !== undefined) body.message(1023, (a) => any(a, WEB3_EXTENSION, new Proto().uint(1, evm).finish()))
  return body.finish()
}

// Gas from a simulation (half again, for safety) and the fee for it at the chain's usual gas price, or undefined when the
// key type is another chain family's (retry: there's another to try).
async function feeFor(chain: ChainInfo & { gas: { denom: string; price: string } }, unsigned: Uint8Array, retry = false) {
  const simulated = await rest<{ gas_info: { gas_used: string } }>(chain, '/cosmos/tx/v1beta1/simulate', { tx_bytes: b64(unsigned) }).catch((err) => {
    if (err instanceof CosmosError && retry && /type url|unrecognized|no concrete type/i.test(err.message)) return undefined
    if (err instanceof CosmosError) throw new HttpError(400, simulationError(err.message))
    throw err
  })
  if (!simulated) return
  const gas = (BigInt(simulated.gas_info.gas_used) * 3n) / 2n + 20_000n
  const amount = ceilMul(gas, chain.gas.price)
  return { amount: amount > 0n ? [{ denom: chain.gas.denom, amount: amount.toString() }] : [], gas }
}
const feeInfo = (chain: { gas: { denom: string } }, fee: { amount: Coin[]; gas: bigint }) => ({ denom: chain.gas.denom, amount: fee.amount[0]?.amount ?? '0', gas: fee.gas.toString() })

// An unsigned transaction for the wallet: the messages, the account's sequence, and the fee for its simulated gas. The key
// type comes from the account (if it has signed before), else from the wallet: Ethereum-style keys have a type URL per
// chain family, and the simulation tells which one fits. With evm (the EVM chain id the wallet is on), it's for an EVM
// wallet on Injective: the same transaction, and the EIP-712 typed data to sign for it.
export async function prepare({ chain, signer, pubKey, algo, messages, memo, evm }: PrepareBody) {
  if (chain.kind !== 'cosmos' || !chain.gas) throw new HttpError(400, `Sending from ${chain.name} isn't supported.`)
  const withGas = chain as ChainInfo & { gas: { denom: string; price: string } }
  if (evm !== undefined) return prepareEip712(withGas, signer, messages, memo, evm)
  const key = Uint8Array.from(Buffer.from(pubKey ?? '', 'base64'))
  if (key.length !== 33) throw new HttpError(400, 'Invalid public key.')
  const acct = await account(chain, signer)
  const bodyBytes = bodyOf(messages, memo)

  const eth = algo === 'ethsecp256k1' || (!algo && chain.slip44 === 60)
  const types = acct.pubKeyType
    ? [acct.pubKeyType]
    : !eth
      ? [PUBKEYS.secp256k1]
      : chain.cosmosId?.startsWith('injective')
        ? [PUBKEYS.injective]
        : [PUBKEYS.cosmosEvm, PUBKEYS.ethermint]
  for (const [i, type] of types.entries()) {
    const fee = await feeFor(withGas, txRaw(bodyBytes, authInfo(type, key, acct.sequence, { amount: [], gas: 0n }), new Uint8Array()), i < types.length - 1)
    if (!fee) continue
    return {
      chainId: chain.cosmosId!,
      accountNumber: acct.number.toString(),
      bodyBytes: b64(bodyBytes),
      authInfoBytes: b64(authInfo(type, key, acct.sequence, fee)),
      fee: feeInfo(withGas, fee),
    }
  }
  throw new HttpError(400, `Could not build a transaction for ${chain.name}.`)
}

// Simulated with a placeholder key: the wallet's is only known from its signature (see broadcast).
async function prepareEip712(chain: ChainInfo & { gas: { denom: string; price: string } }, signer: string, messages: CosmosMessage[], memo: string | undefined, evm: number) {
  if (!EIP712_CHAINS[chain.cosmosId ?? '']?.includes(evm)) throw new HttpError(400, `An EVM wallet signs for ${chain.name} on Ethereum or Injective EVM: switch to either.`)
  eip712Msgs(messages) // only messages it can sign, before asking the chain
  const acct = await account(chain, signer)
  const bodyBytes = bodyOf(messages, memo, evm)
  const unsigned = txRaw(bodyBytes, authInfo(PUBKEYS.injective, PLACEHOLDER_KEY, acct.sequence, { amount: [], gas: 0n }, SIGN_MODE_EIP712_V2), new Uint8Array())
  const fee = (await feeFor(chain, unsigned))!
  return {
    chainId: chain.cosmosId!,
    accountNumber: acct.number.toString(),
    sequence: acct.sequence.toString(),
    bodyBytes: b64(bodyBytes),
    fee: feeInfo(chain, fee),
    typedData: eip712TypedData(chain.cosmosId!, evm, acct, fee, messages, memo),
  }
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

export type BroadcastBody = { chain: ChainInfo; bodyBytes: string; signature: string; authInfoBytes?: string; typedData?: TypedData; signer?: string }

// The signed transaction, as the wallet returned it (it may have changed the fee): checked by the node, not yet in a block.
// An EVM wallet's comes as the typed data it signed, with the signature (hex).
export async function broadcast({ chain, bodyBytes, authInfoBytes, signature, typedData, signer }: BroadcastBody) {
  const tx = typedData ? await signedEip712(chain, base64Bytes(bodyBytes)!, typedData, signature, signer) : txRaw(base64Bytes(bodyBytes)!, base64Bytes(authInfoBytes)!, base64Bytes(signature)!)
  type Res = { tx_response: { txhash: string; code: number; raw_log?: string } }
  const { tx_response: r } = await rest<Res>(chain, '/cosmos/tx/v1beta1/txs', { tx_bytes: b64(tx), mode: 'BROADCAST_MODE_SYNC' }).catch((err) => {
    throw err instanceof CosmosError ? new HttpError(400, feeShortfall(chain, err.message) ?? simulationError(err.message)) : err
  })
  if (r.code !== 0) throw new HttpError(400, feeShortfall(chain, r.raw_log ?? '') ?? simulationError(r.raw_log || `Rejected with code ${r.code}.`))
  return { txHash: r.txhash }
}

// The node turned the transaction away for its fee, the only thing it takes before a block ("spendable balance
// 1528746226563417inj is smaller than 1760000000000000inj"): what it takes and what the account has, in the gas token.
function feeShortfall(chain: ChainInfo, message: string) {
  const m = /spendable balance (\d+)(\S+?) is smaller than (\d+)(\S+?)(?=[:'"\s]|$)/.exec(message)
  if (!m || m[2] !== m[4] || m[2] !== chain.gas?.denom) return
  const symbol = chain.native?.symbol ?? m[2]
  const show = (amount: string) => `${Number(formatUnits(BigInt(amount), chain.native?.decimals ?? 6)).toPrecision(2)} ${symbol}`
  return `Not enough ${symbol} for the network fee: it takes ${show(m[3]!)}, and the account has ${show(m[1]!)}. Add a little ${symbol}, then retry.`
}

// An EIP-712 transaction, signed: the typed data is checked to be this transaction's, as the chain will rebuild it, and the
// wallet's key is recovered from the signature (an account that never sent from Injective's Cosmos side has none on chain
// yet, and the transaction carries it). The signature goes in as the wallet gave it, R‖S‖V.
export async function signedEip712(chain: ChainInfo, body: Uint8Array, typedData: TypedData, signature: string, signer?: string) {
  const evm = Number(typedData.domain?.chainId)
  const allowed = EIP712_CHAINS[chain.cosmosId ?? ''] ?? []
  const signed = bech32Decode(signer ?? '')
  if (!allowed.includes(evm) || !signed || signed.prefix !== chain.bech32 || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new HttpError(400, 'Invalid EIP-712 signature.')
  const { messages, memo } = readBody(body)
  let context: { account_number: number; sequence: number; fee: { amount: Coin[]; gas: number } }
  try {
    context = JSON.parse(typedData.message.context)
  } catch {
    throw new HttpError(400, 'Invalid EIP-712 context.')
  }
  const account = { number: BigInt(context.account_number), sequence: BigInt(context.sequence) }
  const fee = { amount: context.fee.amount.map((c) => ({ denom: String(c.denom), amount: String(c.amount) })), gas: BigInt(context.fee.gas) }
  const expected = eip712TypedData(chain.cosmosId!, evm, account, fee, messages, memo)
  if (JSON.stringify(expected) !== JSON.stringify(typedData) || b64(bodyOf(messages, memo, evm)) !== b64(body)) throw new HttpError(400, 'The signed typed data is not this transaction’s: prepare it again.')

  const hash = hashTypedData({ ...typedData, domain: { ...typedData.domain, chainId: BigInt(evm) } } as unknown as Parameters<typeof hashTypedData>[0])
  const key = await recoverPublicKey({ hash, signature: signature as Hex })
  if (publicKeyToAddress(key).toLowerCase() !== `0x${Buffer.from(signed.bytes).toString('hex')}`) throw new HttpError(400, 'Signed by another account than the sender: switch your wallet back to it.')
  const compressed = Uint8Array.from([BigInt(`0x${key.slice(-2)}`) & 1n ? 3 : 2, ...Buffer.from(key.slice(4, 68), 'hex')])
  return txRaw(body, authInfo(PUBKEYS.injective, compressed, account.sequence, fee, SIGN_MODE_EIP712_V2), Uint8Array.from(Buffer.from(signature.slice(2), 'hex')))
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
