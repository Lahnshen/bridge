export type Hex = `0x${string}`

export type Chain = {
  domain: number
  name: string
  chainId: number
  usdc: Hex
  rpc: string
  explorer?: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
}

export type Config = {
  network: 'mainnet' | 'testnet'
  autoRedeem: boolean
  tokenMessenger: Hex
  messageTransmitter: Hex
  chains: Chain[]
}

export type Transfer = {
  sourceDomain: number
  sourceChain: string
  destinationDomain: number
  destinationChain: string
  txHash: string
  txUrl?: string
  nonce?: string
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
}

// fastBps: Fast Transfer fee (bps of the amount), forwardFee: USDC Circle takes to deliver from Injective,
// standardTime: average wait for a standard transfer. Each is null when it doesn't apply.
export type Fees = { fastBps: number | null; forwardFee: string | null; standardTime: string | null }

export const INJECTIVE = 29

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '')

// A hung request would stall the transfer tracking loop. Redeems wait for the mint, and sometimes for Circle to re-sign.
async function call<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(API_URL + path, { ...init, signal: AbortSignal.timeout(timeoutMs) }).catch(() => {
    throw new ApiError(0, 'Could not reach the bridge server. Please try again.')
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`)
  return data
}

export const isTxHash = (q: string) => /^0x[0-9a-fA-F]{64}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(q)
export const isAddress = (q: string) => /^0x[0-9a-fA-F]{40}$/.test(q) || /^inj1[02-9ac-hj-np-z]{38}$/i.test(q)

export const getConfig = () => call<Config>('/chains')
export const getFees = (from: number, to: number) => call<Fees>(`/fees/${from}/${to}`)
export const getBalance = (domain: number, address: string) => call<{ balance: string }>(`/balance/${domain}/${address}`)
export const getAddressTransfers = (address: string) => call<{ transfers: Transfer[] }>(`/address/${address}`)
export const getTxTransfers = (hash: string, domain?: number) =>
  call<{ transfers: Transfer[] }>(`/tx/${hash}${domain === undefined ? '' : `?domain=${domain}`}`)
export const redeem = (txHash: string, domain: number) =>
  call<{ transfers: Transfer[] }>(
    '/redeem',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, domain }) },
    150_000,
  )
