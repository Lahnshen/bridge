import type { Chain, Hex } from './api'

// Browser wallets over EIP-1193, discovered with EIP-6963 (window.ethereum as a fallback).

type Provider = {
  request(args: { method: string; params?: unknown }): Promise<any>
  on?(event: string, listener: (...args: any[]) => void): void
  removeListener?(event: string, listener: (...args: any[]) => void): void
}
export type WalletInfo = { id: string; name: string; icon?: string }

const STORAGE_KEY = 'wallet'
// Providers stay out of reactive state: proxying them breaks some wallets.
const providers = new Map<string, Provider>()
let provider: Provider | undefined

export const wallet = $state({
  available: [] as WalletInfo[],
  connected: undefined as WalletInfo | undefined,
  address: undefined as Hex | undefined,
  chainId: undefined as number | undefined,
  picking: false, // the wallet picker dialog is open
})

function announce(info: WalletInfo, p: Provider) {
  if (providers.has(info.id)) return
  providers.set(info.id, p)
  wallet.available.push(info)
  if (localStorage.getItem(STORAGE_KEY) === info.id && !provider) void restore(info.id)
}

window.addEventListener('eip6963:announceProvider', (event) => {
  const { info, provider: p } = (event as CustomEvent<{ info: { rdns: string; name: string; icon: string }; provider: Provider }>).detail
  announce({ id: info.rdns, name: info.name, icon: info.icon }, p)
})
window.dispatchEvent(new Event('eip6963:requestProvider'))
setTimeout(() => {
  const injected = (window as { ethereum?: Provider }).ethereum
  if (!wallet.available.length && injected) announce({ id: 'injected', name: 'Browser wallet' }, injected)
}, 500)

// Connects right away when there's a single wallet, otherwise opens the picker.
export function connectWallet() {
  const [only, ...others] = wallet.available
  if (only && !others.length) return connect(only.id).catch(() => {})
  wallet.picking = true
}

export async function connect(id: string) {
  const p = providers.get(id)!
  const [address] = (await p.request({ method: 'eth_requestAccounts' })) as Hex[]
  if (address) await attach(id, p, address)
  wallet.picking = false
}

// Reconnects a wallet the user connected before, without a prompt.
async function restore(id: string) {
  const p = providers.get(id)!
  const [address] = ((await p.request({ method: 'eth_accounts' }).catch(() => [])) ?? []) as Hex[]
  if (address && !provider) await attach(id, p, address)
}

async function attach(id: string, p: Provider, address: Hex) {
  detach()
  provider = p
  p.on?.('accountsChanged', onAccounts)
  p.on?.('chainChanged', onChain)
  wallet.connected = wallet.available.find((w) => w.id === id)
  wallet.address = address
  wallet.chainId = Number(await p.request({ method: 'eth_chainId' }))
  localStorage.setItem(STORAGE_KEY, id)
}

function detach() {
  provider?.removeListener?.('accountsChanged', onAccounts)
  provider?.removeListener?.('chainChanged', onChain)
  provider = undefined
  wallet.connected = wallet.address = wallet.chainId = undefined
}

export function disconnect() {
  detach()
  localStorage.removeItem(STORAGE_KEY)
}

const onAccounts = (accounts: Hex[]) => (accounts[0] ? (wallet.address = accounts[0]) : disconnect())
const onChain = (chainId: string) => (wallet.chainId = Number(chainId))

async function request(method: string, params?: unknown) {
  if (!provider) throw new Error('Connect a wallet first.')
  return provider.request({ method, params })
}

const hex = (value: number | bigint) => `0x${value.toString(16)}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function switchChain(chain: Chain) {
  // Asks the wallet rather than trusting wallet.chainId: a missed chainChanged event must not send a tx to the wrong chain.
  if (Number(await request('eth_chainId')) === chain.chainId) return void (wallet.chainId = chain.chainId)
  const chainId = hex(chain.chainId)
  try {
    await request('wallet_switchEthereumChain', [{ chainId }])
  } catch (err) {
    const e = err as { code?: number; message?: string; data?: { originalError?: { code?: number } } }
    if (e.code !== 4902 && e.data?.originalError?.code !== 4902 && !/unrecognized|not been added|unknown chain/i.test(e.message ?? '')) throw err
    await request('wallet_addEthereumChain', [
      { chainId, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [chain.rpc], blockExplorerUrls: chain.explorer ? [chain.explorer] : undefined },
    ])
    await request('wallet_switchEthereumChain', [{ chainId }]).catch(() => {}) // most wallets already switched when adding
  }
  wallet.chainId = Number(await request('eth_chainId'))
  if (wallet.chainId !== chain.chainId) throw new Error(`Switch your wallet to ${chain.name} to continue.`)
}

export const call = (to: Hex, data: Hex): Promise<Hex> => request('eth_call', [{ to, data }, 'latest'])

type Tx = { to: Hex; data: Hex }

// chainId makes the wallet refuse the tx if the user changed networks in the meantime.
export async function sendTx(chain: Chain, tx: Tx, { padGas = false } = {}): Promise<Hex> {
  const params = { from: wallet.address, chainId: hex(chain.chainId), ...tx }
  const gas = padGas ? (BigInt(await request('eth_estimateGas', [{ from: params.from, ...tx }])) * 3n) / 2n : undefined
  return request('eth_sendTransaction', [{ ...params, ...(gas && { gas: hex(gas) }) }])
}

// Resolves to whether the transaction succeeded.
export async function waitForReceipt(hash: Hex, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const receipt = await request('eth_getTransactionReceipt', [hash]).catch(() => null)
    if (receipt) return receipt.status === '0x1'
    await sleep(1500)
  }
  throw new Error('The transaction is taking a while to confirm, check your wallet.')
}

// A short message for a failed wallet request, or undefined when the user cancelled it.
export function walletError(err: unknown) {
  const e = err as { code?: number; message?: string; data?: { message?: string } }
  if (e?.code === 4001 || /user (rejected|denied|cancel)/i.test(e?.message ?? '')) return
  if (e?.code === -32002) return 'Your wallet already has a request open, check it first.'
  return (e?.data?.message ?? e?.message ?? String(err)).split('\n')[0]!.slice(0, 200)
}
