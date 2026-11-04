import type { Chain, Hex } from './api'
import { bech32Decode, bech32Encode } from './bech32'
import { publicKey } from './solana'

// Addresses on every kind of chain the bridges reach, as the server checks them (see validAddress in chains.ts).

const FORMATS: Partial<Record<Chain['kind'], RegExp>> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  hypercore: /^0x[0-9a-fA-F]{40}$/,
  lighter: /^0x[0-9a-fA-F]{40}$/,
  bitcoin: /^(bc1[02-9ac-hj-np-z]{8,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  sui: /^0x[0-9a-fA-F]{64}$/,
  aptos: /^0x[0-9a-fA-F]{1,64}$/,
  iota: /^0x[0-9a-fA-F]{64}$/,
  starknet: /^0x[0-9a-fA-F]{1,64}$/,
  zcash: /^(t1|t3)[1-9A-HJ-NP-Za-km-z]{33}$|^u1[02-9ac-hj-np-z]{100,}$/,
  ton: /^[EUk0]Q[A-Za-z0-9_-]{46}$|^-?\d:[0-9a-fA-F]{64}$/,
  xrp: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  stellar: /^G[A-Z2-7]{55}$/,
}

// What to type, for the recipient field's placeholder.
const HINTS: Partial<Record<Chain['kind'], string>> = {
  evm: '0x…',
  hypercore: '0x…',
  lighter: '0x…',
  bitcoin: 'bc1…',
  tron: 'T…',
  ton: 'UQ…',
  xrp: 'r…',
  stellar: 'G…',
  zcash: 't1…',
}
export const addressHint = (chain: Chain) =>
  chain.kind === 'cosmos' ? `${chain.bech32}1…` : chain.id === 'injective' ? '0x… or inj1…' : (HINTS[chain.kind] ?? `${chain.name} address`)

const hexBytes = (hex: string) => Uint8Array.from(hex.slice(2).match(/../g)!, (b) => parseInt(b, 16))
const toHex = (bytes: Uint8Array) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}` as Hex

// A typed address in the form the bridges take, or undefined when it can't receive on the chain. Injective's EVM side
// also takes its inj1… form (the same account).
export function parseAddress(chain: Chain, input: string): string | undefined {
  const value = input.trim()
  if (chain.kind === 'solana' || chain.kind === 'eclipse') return publicKey(value) ? value : undefined
  if (chain.kind === 'cosmos') return bech32Decode(value)?.prefix === chain.bech32 ? value.toLowerCase() : undefined
  if (chain.id === 'injective' && /^inj1/i.test(value)) {
    const decoded = bech32Decode(value)
    return decoded?.prefix === 'inj' && decoded.bytes.length === 20 ? toHex(decoded.bytes) : undefined
  }
  if (!FORMATS[chain.kind]?.test(value)) return
  return chain.kind === 'evm' || chain.kind === 'hypercore' || chain.kind === 'lighter' ? value.toLowerCase() : value
}

// Injective's Cosmos address for an EVM account: the same key, another encoding.
export const injectiveAddress = (evm: string) => bech32Encode('inj', hexBytes(evm))

// The wallet that signs on (and receives on) a chain, where the app connects one.
export type WalletKind = 'evm' | 'solana' | 'cosmos'
export function walletKind(chain: Chain): WalletKind | undefined {
  if (chain.kind === 'evm' || chain.kind === 'hypercore' || chain.kind === 'lighter') return 'evm'
  if (chain.kind === 'solana' || chain.kind === 'eclipse') return 'solana'
  if (chain.kind === 'cosmos') return 'cosmos'
}
