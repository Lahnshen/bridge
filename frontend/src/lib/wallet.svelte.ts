import { rpc, sameAddress, type EvmChain, type Hex } from './api'
import { short } from './evm'

// Browser wallets over EIP-1193, discovered with EIP-6963 (window.ethereum as a fallback). Several accounts can be
// connected (Onboard moves from them all), the wallet signing from the one it's on.

type Provider = {
  request(args: { method: string; params?: unknown }): Promise<any>
  on?(event: string, listener: (...args: any[]) => void): void
  removeListener?(event: string, listener: (...args: any[]) => void): void
}
export type WalletInfo = { id: string; name: string; icon?: string }
// A connected account: the wallet app it's in (its id), and its address.
export type WalletAccount = { wallet: string; address: string }

// The connected accounts, kept for the next visit (also the Solana wallet's, see solana-wallet.svelte.ts).
export function savedAccounts(key: string): WalletAccount[] {
  try {
    const list = JSON.parse(localStorage.getItem(key) ?? '[]') as WalletAccount[]
    return Array.isArray(list) ? list.filter((a) => typeof a?.wallet === 'string' && typeof a?.address === 'string') : []
  } catch {
    return []
  }
}
// Adds accounts to such a list; how many were new.
export function addAccounts(list: WalletAccount[], key: string, id: string, addresses: string[]) {
  let added = 0
  for (const address of addresses)
    if (!list.some((a) => sameAddress(a.address, address))) {
      list.push({ wallet: id, address })
      added++
    }
  localStorage.setItem(key, JSON.stringify(list))
  return added
}

const STORAGE_KEY = 'wallet'
const ACCOUNTS_KEY = 'wallet-accounts'
// Providers stay out of reactive state: proxying them breaks some wallets.
const providers = new Map<string, Provider>()
let provider: Provider | undefined

export const wallet = $state({
  available: [] as WalletInfo[],
  connected: undefined as WalletInfo | undefined,
  address: undefined as Hex | undefined, // the account the wallet is on: it signs
  chainId: undefined as number | undefined,
  picking: false as false | 'evm' | 'solana' | 'cosmos', // the wallet picker dialog is open, for this kind of wallet
  accounts: savedAccounts(ACCOUNTS_KEY), // every account connected, lowercase; the one the wallet is on may not be among them
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

// Connects right away when there's a single wallet, otherwise opens the picker. Also adds another account (see connect):
// resolves to how many it added, when it connected here.
export async function connectWallet(): Promise<number | undefined> {
  const [only, ...others] = wallet.available
  if (only && !others.length) return connect(only.id).catch(() => undefined)
  wallet.picking = 'evm'
}

// The accounts the wallet gives are added to the connected ones. Asked again once connected, MetaMask lets the user pick
// more of them; other wallets give the one they're on, so another is added by switching to it there (Onboard offers it).
export async function connect(id: string) {
  const p = providers.get(id)!
  const again = p === provider && !!wallet.address
  if (again)
    await p.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }).catch((err) => {
      // Most other wallets don't have it. Closing it stops here.
      if (walletError(err) === undefined) throw err
    })
  const list = ((await p.request({ method: again ? 'eth_accounts' : 'eth_requestAccounts' })) ?? []) as Hex[]
  if (list[0] && !again) await attach(id, p, list[0])
  else if (list[0]) wallet.address = list[0]
  wallet.picking = false
  return addAccounts(wallet.accounts, ACCOUNTS_KEY, id, list.map((a) => a.toLowerCase()))
}

// Reconnects a wallet the user connected before, without a prompt (or, swap: in place of the one attached).
async function restore(id: string, swap = false) {
  const p = providers.get(id)!
  const [address] = ((await p.request({ method: 'eth_accounts' }).catch(() => [])) ?? []) as Hex[]
  if (!address || (provider && !swap)) return
  await attach(id, p, address)
  // Connected before accounts were kept.
  if (!wallet.accounts.length) addAccounts(wallet.accounts, ACCOUNTS_KEY, id, [address.toLowerCase()])
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

// Every account.
export function disconnect() {
  detach()
  wallet.accounts = []
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(ACCOUNTS_KEY)
}

// One of the accounts; without the last one, the wallet.
export function forgetAccount(address: string) {
  wallet.accounts = wallet.accounts.filter((a) => !sameAddress(a.address, address))
  if (!wallet.accounts.length) return disconnect()
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(wallet.accounts))
}

// The wallet's own account, when it isn't connected here yet.
export function addCurrent() {
  if (wallet.connected && wallet.address) addAccounts(wallet.accounts, ACCOUNTS_KEY, wallet.connected.id, [wallet.address.toLowerCase()])
}

// The wallet switched accounts: the new one signs, and the others stay connected. A locked wallet gives none for now.
const onAccounts = (accounts: Hex[]) => (wallet.address = accounts[0])
const onChain = (chainId: string) => (wallet.chainId = Number(chainId))

// Whether the wallet is on this account, to sign from it (asked of the wallet, not taken from events). An account in
// another wallet app has that one attached first.
export async function isOn(address: string) {
  const id = wallet.accounts.find((a) => sameAddress(a.address, address))?.wallet
  if (id && id !== wallet.connected?.id && providers.has(id)) await restore(id, true)
  if (!provider) return false
  const [now] = ((await provider.request({ method: 'eth_accounts' }).catch(() => [])) ?? []) as Hex[]
  wallet.address = now
  return !!now && sameAddress(now, address)
}
// The wallet app an account is in, by name.
export const walletOf = (address: string) => wallet.available.find((w) => w.id === wallet.accounts.find((a) => sameAddress(a.address, address))?.wallet)?.name

// Any request to the connected wallet (batches use it, see batch.ts).
export async function request(method: string, params?: unknown) {
  if (!provider) throw new Error('Connect a wallet first.')
  return provider.request({ method, params })
}

export const hex = (value: number | bigint) => `0x${value.toString(16)}`
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function switchChain(chain: EvmChain) {
  // Asks the wallet rather than trusting wallet.chainId: a missed chainChanged event must not send a tx to the wrong chain.
  if (Number(await request('eth_chainId')) === chain.chainId) return void (wallet.chainId = chain.chainId)
  const chainId = hex(chain.chainId)
  try {
    await request('wallet_switchEthereumChain', [{ chainId }])
  } catch (err) {
    const e = err as { code?: number; message?: string; data?: { originalError?: { code?: number } } }
    if (e.code !== 4902 && e.data?.originalError?.code !== 4902 && !/unrecognized|not been added|unknown chain/i.test(e.message ?? '')) throw err
    if (!chain.rpc || !chain.native) throw new Error(`Add ${chain.name} to your wallet, then try again.`)
    const { symbol, name, decimals } = chain.native
    // The explorer's home page: its transaction link up to /tx/.
    const explorer = chain.explorer?.split(/\/tx\//)[0]
    await request('wallet_addEthereumChain', [
      { chainId, chainName: chain.name, nativeCurrency: { symbol, name, decimals }, rpcUrls: [chain.rpc], blockExplorerUrls: explorer ? [explorer] : undefined },
    ])
    await request('wallet_switchEthereumChain', [{ chainId }]).catch(() => {}) // most wallets already switched when adding
  }
  wallet.chainId = Number(await request('eth_chainId'))
  if (wallet.chainId !== chain.chainId) throw new Error(`Switch your wallet to ${chain.name} to continue.`)
}

export const call = (to: Hex, data: Hex): Promise<Hex> => request('eth_call', [{ to, data }, 'latest'])

// The account the app signs from has to be one the wallet still lets this site use: a wallet can stop (the site
// disconnected there, or its connection expired) without saying so, and then refuses with 4100, "not authorized". It's
// asked for again, which has the wallet reconnect the site. Given another account instead, it stops: what's about to be
// signed was made for this one.
export async function authorized() {
  const from = wallet.address
  if (!from) throw new Error('Connect a wallet first.')
  const ours = (list: unknown) => Array.isArray(list) && list.some((a) => typeof a === 'string' && sameAddress(a, from))
  const given = await request('eth_accounts').catch(() => undefined)
  if (given === undefined || ours(given)) return from
  const asked = await request('eth_requestAccounts')
  if (ours(asked)) return from
  const now = Array.isArray(asked) && typeof asked[0] === 'string' ? (asked[0] as Hex) : undefined
  wallet.address = now
  throw new Error(now ? `Your wallet connected ${short(now)} to this site, not ${short(from)}: check the route for it, then send again.` : 'Connect your wallet again, then retry.')
}

// EIP-712 typed data, signed by the connected account. Wallets check its domain's chainId against the current chain.
export const signTypedData = async (data: object): Promise<Hex> => request('eth_signTypedData_v4', [await authorized(), JSON.stringify(data)])
export const currentChain = async () => (wallet.chainId = Number(await request('eth_chainId')))

type Tx = { to: Hex; data: Hex; value?: bigint; gas?: bigint }

// chainId makes the wallet refuse the tx if the user changed networks in the meantime. gas, when given, is used as is;
// padGas estimates it with headroom (Injective's estimates run short).
export async function sendTx(chain: EvmChain, { value, gas, ...tx }: Tx, { padGas = false } = {}): Promise<Hex> {
  const params = { from: await authorized(), chainId: hex(chain.chainId), ...tx, ...(value && { value: hex(value) }) }
  const limit = gas ?? (padGas ? ((await estimateGas(chain, { from: params.from, ...tx, ...(value && { value: hex(value) }) })) * 3n) / 2n : undefined)
  return request('eth_sendTransaction', [{ ...params, ...(limit && { gas: hex(limit) }) }])
}

// Reads go to the chain's public RPC first, the wallet's after: a wallet's own RPC can be rate-limited (Rabby's for
// Injective answers -32005), and then it fails the transaction it was asked to send.
async function estimateGas(chain: EvmChain, call: object) {
  const gas = chain.rpc ? await rpc<string>(chain.rpc, 'eth_estimateGas', [call]).catch(() => undefined) : undefined
  return BigInt(gas ?? (await request('eth_estimateGas', [call])))
}

// Resolves to whether the transaction succeeded.
export async function waitForReceipt(hash: Hex, chain?: EvmChain, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const receipt = await (chain?.rpc ? rpc<{ status: string } | null>(chain.rpc, 'eth_getTransactionReceipt', [hash]) : Promise.reject())
      .catch(() => request('eth_getTransactionReceipt', [hash]))
      .catch(() => null)
    if (receipt) return receipt.status === '0x1'
    await sleep(1500)
  }
  throw new Error('The transaction is taking a while to confirm, check your wallet.')
}

// A short message for a failed wallet request, or undefined when the user cancelled it.
export function walletError(err: unknown) {
  const e = err as { code?: number; message?: string; data?: { message?: string } }
  if (e?.code === 4001 || /user (rejected|denied|cancel)|^request rejected|rejected by (the )?user/i.test(e?.message ?? '')) return
  if (e?.code === -32002) return 'Your wallet already has a request open, check it first.'
  // 4100: the wallet won't let this site use the account (or the method) now.
  if (e?.code === 4100 || /has not been authorized by the user/i.test(e?.message ?? ''))
    return 'Your wallet didn’t let this site use your account. Connect your wallet again (or switch it to the account shown here), then retry.'
  const message = e?.data?.message ?? e?.message ?? String(err)
  // -32005: the wallet's RPC for the chain turned it away for too many requests.
  if (e?.code === -32005 || /exceeds defined limit/i.test(message))
    return 'Your wallet’s connection to this network is rate-limited. Wait a minute and retry, or set another RPC for this network in your wallet.'
  return message.split('\n')[0]!.slice(0, 200)
}
