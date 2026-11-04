import type { Hex } from './api'

// ---- ABI encoding for the few calls the bridge makes ---------------------------------------------

const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, '0')
const address = (value: string) => value.slice(2).toLowerCase().padStart(64, '0')
const bytes = (value: Hex) => {
  const hex = value.slice(2)
  return word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')
}

export type Burn = { amount: bigint; destinationDomain: number; mintRecipient: Hex; burnToken: Hex; maxFee: bigint; minFinalityThreshold: number }
// destinationCaller is always zero: anyone (our relayer, Circle's forwarder, the recipient) may finish the transfer.
const burnArgs = (b: Burn) =>
  word(b.amount) + word(b.destinationDomain) + address(b.mintRecipient) + address(b.burnToken) + word(0) + word(b.maxFee) + word(b.minFinalityThreshold)

// Circle's Forwarding Service hook (v0): Circle mints on the destination chain for a fee. To Solana it can also create the
// recipient's USDC account first, given the wallet (`setupFor`, 32 bytes hex). https://developers.circle.com/cctp/concepts/forwarding-service
export function forwardHook(setupFor?: Hex): Hex {
  const magic = '636374702d666f7277617264'.padEnd(48, '0') // "cctp-forward" in 24 bytes
  if (!setupFor) return `0x${magic}${'0'.repeat(16)}` // version 0, no extra data
  return `0x${magic}00000000${'00000021'}01${setupFor.slice(2)}` // version 0, 33 bytes: create the account, for this owner
}

export const encode = {
  approve: (spender: Hex, amount: bigint): Hex => `0x095ea7b3${address(spender)}${word(amount)}`,
  allowance: (owner: Hex, spender: Hex): Hex => `0xdd62ed3e${address(owner)}${address(spender)}`,
  balanceOf: (owner: Hex): Hex => `0x70a08231${address(owner)}`,
  // TokenMessengerV2
  depositForBurn: (b: Burn): Hex => `0x8e0250ee${burnArgs(b)}`,
  depositForBurnWithHook: (b: Burn, hookData: Hex): Hex => `0x779b432d${burnArgs(b)}${word(8 * 32)}${bytes(hookData)}`,
  // MessageTransmitterV2
  receiveMessage: (message: Hex, attestation: Hex): Hex => {
    const encoded = bytes(message)
    return `0x57ecfd28${word(64)}${word(64 + encoded.length / 2)}${encoded}${bytes(attestation)}`
  },
}

// ---- USDC amounts (6 decimals) --------------------------------------------------------------------

export function parseUsdc(value: string): bigint | undefined {
  const match = /^(\d*)\.?(\d{0,6})$/.exec(value)
  if (!match || !/\d/.test(value)) return
  return BigInt(match[1] || '0') * 1_000_000n + BigInt(match[2]!.padEnd(6, '0'))
}

// Plain decimal string, e.g. for inputs: 1234.5
export function usdcString(units: bigint) {
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${units / 1_000_000n}${fraction ? `.${fraction}` : ''}`
}

// For display: 1,234.50 (at least `decimals` digits, more when needed, up to 6)
export function formatUsdc(units: bigint, decimals = 2) {
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(decimals, '0')
  return `${(units / 1_000_000n).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`
}

export const formatAmount = (amount?: string, decimals = 2) => {
  const units = amount === undefined ? undefined : parseUsdc(amount)
  return units === undefined ? '—' : formatUsdc(units, decimals)
}

// ---- Any token's amounts ----------------------------------------------------------------------------

export function parseAmount(value: string, decimals: number): bigint | undefined {
  const match = /^(\d*)\.?(\d*)$/.exec(value)
  if (!match || !/\d/.test(value) || match[2]!.length > decimals) return
  return BigInt(match[1] || '0') * 10n ** BigInt(decimals) + BigInt(match[2]!.padEnd(decimals, '0') || '0')
}

export function amountString(units: bigint, decimals: number) {
  const base = 10n ** BigInt(decimals)
  const fraction = (units % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${units / base}${fraction ? `.${fraction}` : ''}`
}

// For display: 2 decimals from 1,000 up, 6 significant digits below.
export function formatToken(units: bigint, decimals: number) {
  const n = Number(amountString(units, decimals))
  return n.toLocaleString('en-US', n >= 1000 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 6 })
}

// ---- Addresses ------------------------------------------------------------------------------------

export const short = (value?: string) => (!value ? '' : value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value)

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

// inj1… and 0x… are two encodings of the same Injective account.
export function injToHex(input: string): Hex | undefined {
  const address = input.toLowerCase()
  const data = [...address.slice(4)].map((ch) => BECH32.indexOf(ch))
  if (!address.startsWith('inj1') || data.length !== 38 || data.includes(-1)) return
  let checksum = 1
  for (const value of [3, 3, 3, 0, 9, 14, 10, ...data]) { // expanded "inj" prefix + data
    const top = checksum >> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    GENERATORS.forEach((g, i) => { if ((top >> i) & 1) checksum ^= g })
  }
  if (checksum !== 1) return
  let hex = '0x'
  let acc = 0
  let bits = 0
  for (const value of data.slice(0, -6)) {
    acc = ((acc << 5) | value) & 0xfff
    bits += 5
    if (bits >= 8) hex += ((acc >> (bits -= 8)) & 0xff).toString(16).padStart(2, '0')
  }
  return hex as Hex
}

// A recipient as an EVM address. Injective accepts its inj1… form too.
export function parseRecipient(input: string, injective: boolean): Hex | undefined {
  const value = input.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase() as Hex
  if (injective) return injToHex(value)
}
