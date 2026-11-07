import { toHex, type Hex } from 'viem'
import { solana } from './config'

// The little of Solana the API needs: base58 keys, program-derived addresses, and a JSON-RPC call.

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

// A 32-byte public key, from base58.
export function publicKey(value: string): Uint8Array | undefined {
  const bytes = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? base58Decode(value) : undefined
  return bytes?.length === 32 ? bytes : undefined
}

// ---- Program-derived addresses --------------------------------------------------------------------

const P = 2n ** 255n - 19n
const D = mod(-121665n * inverse(121666n))

function mod(a: bigint) {
  const r = a % P
  return r < 0n ? r + P : r
}
function pow(base: bigint, exp: bigint) {
  let result = 1n
  for (base = mod(base); exp > 0n; exp >>= 1n, base = (base * base) % P) if (exp & 1n) result = (result * base) % P
  return result
}
function inverse(a: bigint) {
  return pow(a, P - 2n)
}

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

const sha256 = (...parts: Uint8Array[]) => new Uint8Array(new Bun.CryptoHasher('sha256').update(Buffer.concat(parts)).digest())

export function findProgramAddress(seeds: Uint8Array[], program: Uint8Array): Uint8Array {
  const marker = new TextEncoder().encode('ProgramDerivedAddress')
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(...seeds, new Uint8Array([bump]), program, marker)
    if (!onCurve(hash)) return hash
  }
  throw new Error('No program address found')
}

// The token program and Token-2022.
export const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']
const TOKEN_PROGRAM = publicKey(TOKEN_PROGRAMS[0]!)!
const ASSOCIATED_TOKEN_PROGRAM = publicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')!

// A wallet's own account of a mint (its associated token account), under the token program that has the mint.
export const tokenAccount = (owner: Uint8Array, mint: Uint8Array, program = TOKEN_PROGRAM) => findProgramAddress([owner, program, mint], ASSOCIATED_TOKEN_PROGRAM)
// The wallet's USDC account, which is where CCTP mints USDC on Solana.
export const usdcAccount = (owner: Uint8Array) => tokenAccount(owner, publicKey(solana.usdc)!)

export const hexKey = (bytes: Uint8Array): Hex => toHex(bytes)

// ---- RPC ------------------------------------------------------------------------------------------

// The node answered with an error (as opposed to not answering).
export class SolanaRpcError extends Error {}

export async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(solana.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { message: string } }
  if (body.error) throw new SolanaRpcError(body.error.message)
  if (!res.ok) throw new Error(`Solana RPC error (${res.status})`)
  return body.result as T
}
