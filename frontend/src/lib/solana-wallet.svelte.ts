import { wallet, type WalletInfo } from './wallet.svelte'

// Solana wallets over the Wallet Standard (https://github.com/wallet-standard/wallet-standard), discovered without its library:
// the app announces itself with `wallet-standard:app-ready`, and each wallet calls `register` (also when it loads later).

type Account = { address: string; publicKey: Uint8Array; chains: readonly string[] }
type StandardWallet = {
  name: string
  icon: string
  chains: readonly string[]
  accounts: readonly Account[]
  features: Record<string, any>
}

const STORAGE_KEY = 'solana-wallet'
const wallets = new Map<string, StandardWallet>()
let current: { wallet: StandardWallet; account: Account; off?: () => void } | undefined

export const solanaWallet = $state({
  available: [] as WalletInfo[],
  connected: undefined as WalletInfo | undefined,
  address: undefined as string | undefined, // base58
})

function register(...list: StandardWallet[]) {
  for (const w of list) {
    const usable = w.chains.some((c) => c.startsWith('solana:')) && w.features['standard:connect'] && w.features['solana:signTransaction']
    if (!usable || wallets.has(w.name)) continue
    wallets.set(w.name, w)
    solanaWallet.available.push({ id: w.name, name: w.name, icon: w.icon })
    if (localStorage.getItem(STORAGE_KEY) === w.name && !current) void connectSolana(w.name, true).catch(() => {})
  }
  return () => {}
}

const api = Object.freeze({ register })
window.addEventListener('wallet-standard:register-wallet', (event) => (event as CustomEvent<(api: unknown) => void>).detail(api))
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }))

// Connects right away when there's a single wallet, otherwise opens the picker.
export function connectSolanaWallet() {
  const [only, ...others] = solanaWallet.available
  if (only && !others.length) return connectSolana(only.id).catch(() => {})
  wallet.picking = 'solana'
}

// silent reconnects a wallet the user connected before, without a prompt.
export async function connectSolana(id: string, silent = false) {
  const w = wallets.get(id)!
  const { accounts } = (await w.features['standard:connect'].connect(silent ? { silent: true } : undefined)) as { accounts: Account[] }
  const account = accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ?? accounts[0]
  if (!account || (silent && current)) return
  disconnectSolana(false)
  // Accounts switched in the wallet arrive as change events.
  const off = w.features['standard:events']?.on('change', ({ accounts }: { accounts?: Account[] }) => {
    if (!accounts || current?.wallet !== w) return
    if (!accounts[0]) return disconnectSolana()
    current.account = accounts[0]
    solanaWallet.address = accounts[0].address
  })
  current = { wallet: w, account, off }
  solanaWallet.connected = solanaWallet.available.find((x) => x.id === id)
  solanaWallet.address = account.address
  localStorage.setItem(STORAGE_KEY, id)
  wallet.picking = false
}

export function disconnectSolana(forget = true) {
  current?.off?.()
  if (forget) void current?.wallet.features['standard:disconnect']?.disconnect().catch(() => {})
  current = undefined
  solanaWallet.connected = solanaWallet.address = undefined
  if (forget) localStorage.removeItem(STORAGE_KEY)
}

// The wallet signs a serialized transaction (without sending it), and returns it with its signature added.
export async function signSolanaTransaction(transaction: Uint8Array, devnet = false): Promise<Uint8Array> {
  if (!current) throw new Error('Connect a Solana wallet first.')
  const chain = devnet ? 'solana:devnet' : 'solana:mainnet'
  const [result] = (await current.wallet.features['solana:signTransaction'].signTransaction({ account: current.account, transaction, chain })) as {
    signedTransaction: Uint8Array
  }[]
  return result!.signedTransaction
}
