import { solanaRpc as rpc, type Hex, type SolanaChain } from './api'

// The little of Solana the bridge needs, without @solana/web3.js: base58 keys, program-derived addresses,
// and a CCTP deposit_for_burn transaction for the wallet to sign.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58Decode(value: string): Uint8Array | undefined {
  let n = 0n
  for (const ch of value) {
    const digit = ALPHABET.indexOf(ch)
    if (digit < 0) return
    n = n * 58n + BigInt(digit)
  }
  const bytes: number[] = []
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn))
  for (const ch of value) {
    if (ch !== '1') break
    bytes.unshift(0) // leading 1s are leading zero bytes
  }
  return new Uint8Array(bytes)
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n
  for (const byte of bytes) n = (n << 8n) | BigInt(byte)
  let out = ''
  for (; n > 0n; n /= 58n) out = ALPHABET[Number(n % 58n)] + out
  for (const byte of bytes) {
    if (byte) break
    out = '1' + out
  }
  return out
}

export function publicKey(value: string): Uint8Array | undefined {
  const bytes = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? base58Decode(value) : undefined
  return bytes?.length === 32 ? bytes : undefined
}
export const isSolanaAddress = (value: string) => !!publicKey(value.trim())
export const solanaKeyHex = (value: string) => toHex(publicKey(value)!)
// A 32-byte key from a CCTP message, as a Solana address.
export const solanaAddress = (hex: string) => base58Encode(new Uint8Array(hex.slice(2).match(/../g)!.map((b) => parseInt(b, 16))))

const toHex = (bytes: Uint8Array) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}` as Hex

// ---- Program-derived addresses --------------------------------------------------------------------

const P = 2n ** 255n - 19n
const mod = (a: bigint) => ((a % P) + P) % P
function pow(base: bigint, exp: bigint) {
  let result = 1n
  for (base = mod(base); exp > 0n; exp >>= 1n, base = (base * base) % P) if (exp & 1n) result = (result * base) % P
  return result
}
const D = mod(-121665n * pow(121666n, P - 2n))

// Whether 32 bytes decode to a point on ed25519 (RFC 8032 5.1.3), i.e. could be a wallet's key. PDAs are the ones that can't.
function onCurve(bytes: Uint8Array) {
  let y = 0n
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!)
  const y2 = mod(y * y)
  const u = mod(y2 - 1n)
  const v = mod(D * y2 + 1n)
  const x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n))
  const vx2 = mod(v * x * x)
  return vx2 === u || vx2 === mod(-u) // x² = u/v has a root
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((offset, p) => (out.set(p, offset), offset + p.length), 0)
  return out
}
const sha256 = async (...parts: Uint8Array[]) => new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts)))
const utf8 = (text: string) => new TextEncoder().encode(text)

export async function findProgramAddress(seeds: (Uint8Array | string)[], program: Uint8Array) {
  const bytes = seeds.map((seed) => (typeof seed === 'string' ? utf8(seed) : seed))
  for (let bump = 255; bump >= 0; bump--) {
    const hash = await sha256(...bytes, new Uint8Array([bump]), program, utf8('ProgramDerivedAddress'))
    if (!onCurve(hash)) return hash
  }
  throw new Error('No program address found')
}

export const TOKEN_PROGRAM = publicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')!
const ASSOCIATED_TOKEN_PROGRAM = publicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')!

// A wallet's USDC account (associated token account).
export const usdcAccount = (owner: Uint8Array, chain: SolanaChain) => findProgramAddress([owner, TOKEN_PROGRAM, publicKey(chain.usdc)!], ASSOCIATED_TOKEN_PROGRAM)

// CCTP mints to a token account on Solana, so a transfer to a wallet names its USDC account.
export const solanaMintRecipient = async (owner: string, chain: SolanaChain) => toHex(await usdcAccount(publicKey(owner)!, chain))

// ---- Transactions ---------------------------------------------------------------------------------

type Meta = { key: Uint8Array; signer: boolean; writable: boolean }
type Instruction = { program: Uint8Array; accounts: Meta[]; data: Uint8Array }

const SYSTEM_PROGRAM = new Uint8Array(32)
const COMPUTE_BUDGET = publicKey('ComputeBudget111111111111111111111111111111')!
const keyId = (key: Uint8Array) => toHex(key)

function shortVec(n: number) {
  const out: number[] = []
  do {
    let byte = n & 0x7f
    n >>= 7
    if (n) byte |= 0x80
    out.push(byte)
  } while (n)
  return out
}
function readShortVec(bytes: Uint8Array, offset: number) {
  let n = 0
  let size = 0
  for (let byte = 0x80; byte & 0x80; size++) {
    byte = bytes[offset + size]!
    n |= (byte & 0x7f) << (7 * size)
  }
  return [n, offset + size] as const
}
const le = (value: bigint | number, bytes: number) => [...Array(bytes)].map((_, i) => Number((BigInt(value) >> BigInt(8 * i)) & 0xffn))

// A legacy message: the fee payer first, then writable signers, readonly signers, writable and readonly accounts,
// each key once. https://solana.com/docs/core/transactions
function compile(payer: Uint8Array, instructions: Instruction[], blockhash: Uint8Array) {
  const metas = new Map<string, Meta>()
  const add = (m: Meta) => {
    const seen = metas.get(keyId(m.key))
    if (seen) {
      seen.signer ||= m.signer
      seen.writable ||= m.writable
    } else metas.set(keyId(m.key), { ...m })
  }
  add({ key: payer, signer: true, writable: true })
  for (const ix of instructions) {
    ix.accounts.forEach(add)
    add({ key: ix.program, signer: false, writable: false })
  }
  const rank = (m: Meta) => (m.signer ? 0 : 2) + (m.writable ? 0 : 1)
  const keys = [...metas.values()].sort((a, b) => rank(a) - rank(b)) // stable: the payer stays first
  const index = new Map(keys.map((m, i) => [keyId(m.key), i]))
  const signers = keys.filter((m) => m.signer).length
  const bytes = [signers, keys.filter((m) => m.signer && !m.writable).length, keys.filter((m) => !m.signer && !m.writable).length]
  bytes.push(...shortVec(keys.length), ...keys.flatMap((m) => [...m.key]), ...blockhash, ...shortVec(instructions.length))
  for (const ix of instructions) {
    bytes.push(index.get(keyId(ix.program))!, ...shortVec(ix.accounts.length), ...ix.accounts.map((a) => index.get(keyId(a.key))!))
    bytes.push(...shortVec(ix.data.length), ...ix.data)
  }
  // Unsigned: a zeroed slot per signer, in key order.
  return concat(new Uint8Array([...shortVec(signers), ...new Array(64 * signers).fill(0)]), new Uint8Array(bytes))
}

// The signature slots, the signed message, and its account keys.
function parse(tx: Uint8Array) {
  const [count, start] = readShortVec(tx, 0)
  const message = tx.subarray(start + 64 * count)
  const header = message[0]! & 0x80 ? 1 : 0 // v0 messages start with a version byte
  const [keyCount, keysAt] = readShortVec(message, header + 3)
  const keys = [...Array(keyCount)].map((_, i) => message.subarray(keysAt + 32 * i, keysAt + 32 * (i + 1)))
  return { count, start, message, keys }
}

export type SolanaBurn = { amount: bigint; destinationDomain: number; mintRecipient: Hex; maxFee: bigint; minFinalityThreshold: number; hookData?: Hex }

// An unsigned CCTP deposit_for_burn(_with_hook) transaction, paid by the owner. Its message goes to a new account at
// eventKey, which signs too. https://developers.circle.com/cctp/references/solana-programs
export async function burnTransaction(chain: SolanaChain, owner: Uint8Array, eventKey: Uint8Array, burn: SolanaBurn, blockhash: string) {
  const tmm = publicKey(chain.tokenMessenger)!
  const mt = publicKey(chain.messageTransmitter)!
  const usdc = publicKey(chain.usdc)!
  const [senderAuthority, transmitter, messenger, remote, minter, localToken, eventAuthority, denylist, source] = await Promise.all([
    findProgramAddress(['sender_authority'], tmm),
    findProgramAddress(['message_transmitter'], mt),
    findProgramAddress(['token_messenger'], tmm),
    findProgramAddress(['remote_token_messenger', String(burn.destinationDomain)], tmm),
    findProgramAddress(['token_minter'], tmm),
    findProgramAddress(['local_token', usdc], tmm),
    findProgramAddress(['__event_authority'], tmm),
    findProgramAddress(['denylist_account', owner], tmm),
    usdcAccount(owner, chain),
  ])
  const ro = (key: Uint8Array): Meta => ({ key, signer: false, writable: false })
  const rw = (key: Uint8Array): Meta => ({ key, signer: false, writable: true })
  const hook = burn.hookData ? hexBytes(burn.hookData) : undefined
  const data = concat(
    hexBytes(hook ? '0x6ff53e83cc6cdf9b' : '0xd73c3d2e723780b0'), // sha256("global:deposit_for_burn[_with_hook]")[..8]
    new Uint8Array([...le(burn.amount, 8), ...le(burn.destinationDomain, 4)]),
    hexBytes(burn.mintRecipient),
    new Uint8Array(32), // destination caller: anyone
    new Uint8Array([...le(burn.maxFee, 8), ...le(burn.minFinalityThreshold, 4)]),
    hook ? new Uint8Array([...le(hook.length, 4), ...hook]) : new Uint8Array(),
  )
  const deposit: Instruction = {
    program: tmm,
    accounts: [
      { key: owner, signer: true, writable: false },
      { key: owner, signer: true, writable: true }, // pays the event account's rent
      ro(senderAuthority),
      rw(source),
      ro(denylist),
      rw(transmitter),
      ro(messenger),
      ro(remote),
      ro(minter),
      rw(localToken),
      rw(usdc),
      { key: eventKey, signer: true, writable: true },
      ro(mt),
      ro(tmm),
      ro(TOKEN_PROGRAM),
      ro(SYSTEM_PROGRAM),
      ro(eventAuthority),
      ro(tmm),
    ],
    data,
  }
  // A compute budget of its own (it uses ~46k units) with a small priority fee, so wallets leave it as is.
  const budget = (data: number[]): Instruction => ({ program: COMPUTE_BUDGET, accounts: [], data: new Uint8Array(data) })
  return compile(owner, [budget([0x02, ...le(100_000, 4)]), budget([0x03, ...le(200_000, 8)]), deposit], base58Decode(blockhash)!)
}

// Burns USDC on Solana from the owner's wallet (`sign` has it sign a transaction), and returns the signature once it's sent.
export async function burnOnSolana(chain: SolanaChain, owner: string, burn: SolanaBurn, sign: (tx: Uint8Array) => Promise<Uint8Array>, step: (label: string) => void) {
  const eventPair = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']).catch(() => {
    throw new Error('This browser cannot sign Solana transactions, update it and try again.')
  })) as CryptoKeyPair
  const eventKey = new Uint8Array(await crypto.subtle.exportKey('raw', eventPair.publicKey))
  step('Confirm the transfer in your wallet…')
  const { value: latest } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
  const signed = await sign(await burnTransaction(chain, publicKey(owner)!, eventKey, burn, latest.blockhash))

  // Wallets may adjust what they sign, so the event key signs the message as the wallet returned it.
  const tx = new Uint8Array(signed)
  const { start, message, keys } = parse(tx)
  const slot = keys.findIndex((key) => keyId(key) === keyId(eventKey))
  if (slot < 0) throw new Error('The wallet changed the transaction, try again.')
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', eventPair.privateKey, message.slice()))
  tx.set(signature, start + 64 * slot)

  step('Sending…')
  const encoded = btoa(String.fromCharCode(...tx))
  const id = await rpc<string>('sendTransaction', [encoded, { encoding: 'base64', preflightCommitment: 'confirmed' }])
  void confirm(id, encoded)
  return id
}

// Resends the transaction until it lands, as public RPCs drop some: they're only valid for about a minute anyway.
export const solanaConfirmations = new Map<string, Promise<boolean>>()
function confirm(id: string, encoded: string) {
  const job = (async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const { value } = await rpc<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>('getSignatureStatuses', [[id]]).catch(() => ({ value: [null] }))
      const status = value[0]
      if (status?.err) return false
      if (status && status.confirmationStatus !== 'processed') return true
      if (i % 2) await rpc('sendTransaction', [encoded, { encoding: 'base64', skipPreflight: true }]).catch(() => {})
    }
    throw new Error('Not confirmed yet')
  })()
  solanaConfirmations.set(id, job)
  return job
}

const hexBytes = (hex: Hex | string) => new Uint8Array((hex.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)))

// Whether a Solana account exists, e.g. a wallet's USDC account.
export async function accountExists(key: Uint8Array) {
  const { value } = await rpc<{ value: unknown }>('getAccountInfo', [base58Encode(key), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }])
  return value !== null
}
