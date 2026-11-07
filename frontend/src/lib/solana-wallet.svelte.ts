import { addAccounts, savedAccounts, wallet, type WalletInfo } from './wallet.svelte'

// Solana wallets over the Wallet Standard (https://github.com/wallet-standard/wallet-standard), discovered without its library:
// the app announces itself with `wallet-standard:app-ready`, and each wallet calls `register` (also when it loads later).
// Several accounts can be connected, as for EVM wallets: the wallet signs from the one it's on.

type Account = { address: string; publicKey: Uint8Array; chains: readonly string[] }
type StandardWallet = {
  name: string
  icon: string
  chains: readonly string[]
  accounts: readonly Account[]
  features: Record<string, any>
}

const STORAGE_KEY = 'solana-wallet'
const ACCOUNTS_KEY = 'solana-accounts'
const wallets = new Map<string, StandardWallet>()
let current: { wallet: StandardWallet; account: Account; off?: () => void } | undefined

export const solanaWallet = $state({
  available: [] as WalletInfo[],
  connected: undefined as WalletInfo | undefined,
  address: undefined as string | undefined, // base58: the account the wallet is on, which signs
  accounts: savedAccounts(ACCOUNTS_KEY), // every account connected
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

// Connects right away when there's a single wallet, otherwise opens the picker. Also adds another account: resolves to how
// many it added, when it connected here (most wallets give only the account they're on, so the user switches there).
export async function connectSolanaWallet(): Promise<number | undefined> {
  const [only, ...others] = solanaWallet.available
  if (only && !others.length) return connectSolana(only.id).catch(() => undefined)
  wallet.picking = 'solana'
}

// silent reconnects a wallet the user connected before, without a prompt (swap: in place of the one connected). The
// accounts it gives are added to the connected ones; reconnected, only when none were kept (connected before accounts were).
export async function connectSolana(id: string, silent = false, swap = false) {
  const w = wallets.get(id)!
  const { accounts } = (await w.features['standard:connect'].connect(silent ? { silent: true } : undefined)) as { accounts: Account[] }
  const usable = accounts.filter((a) => a.chains.some((c) => c.startsWith('solana:')))
  const account = usable[0] ?? accounts[0]
  if (!account || (silent && current && !swap)) return 0
  disconnectSolana(false)
  // Accounts switched in the wallet arrive as change events: the new one signs, the others stay connected.
  const off = w.features['standard:events']?.on('change', ({ accounts }: { accounts?: Account[] }) => {
    if (!accounts || current?.wallet !== w) return
    if (!accounts[0]) return disconnectSolana(false)
    current.account = accounts[0]
    solanaWallet.address = accounts[0].address
  })
  current = { wallet: w, account, off }
  solanaWallet.connected = solanaWallet.available.find((x) => x.id === id)
  solanaWallet.address = account.address
  localStorage.setItem(STORAGE_KEY, id)
  wallet.picking = false
  return silent && solanaWallet.accounts.length ? 0 : addAccounts(solanaWallet.accounts, ACCOUNTS_KEY, id, (usable.length ? usable : [account]).map((a) => a.address))
}

// forget: every account goes, and the wallet is told.
export function disconnectSolana(forget = true) {
  current?.off?.()
  if (forget) void current?.wallet.features['standard:disconnect']?.disconnect().catch(() => {})
  current = undefined
  solanaWallet.connected = solanaWallet.address = undefined
  if (!forget) return
  solanaWallet.accounts = []
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(ACCOUNTS_KEY)
}

// One of the accounts; without the last one, the wallet.
export function forgetSolanaAccount(address: string) {
  solanaWallet.accounts = solanaWallet.accounts.filter((a) => a.address !== address)
  if (!solanaWallet.accounts.length) return disconnectSolana()
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(solanaWallet.accounts))
}

// The wallet's own account, when it isn't connected here yet.
export function addCurrentSolana() {
  if (solanaWallet.connected && solanaWallet.address) addAccounts(solanaWallet.accounts, ACCOUNTS_KEY, solanaWallet.connected.id, [solanaWallet.address])
}

// Whether the wallet signs from this account now: its wallet app connected first when it's another, and the account taken
// from those the wallet gives (most give only the one it's on).
export async function solanaIsOn(address: string) {
  const id = solanaWallet.accounts.find((a) => a.address === address)?.wallet
  if (id && id !== current?.wallet.name && wallets.has(id)) await connectSolana(id, true, true).catch(() => {})
  const account = current?.wallet.accounts.find((a) => a.address === address)
  if (!current || !account) return false
  current.account = account
  solanaWallet.address = address
  return true
}
// The wallet app an account is in, by name.
export const solanaWalletOf = (address: string) => solanaWallet.accounts.find((a) => a.address === address)?.wallet

// The wallet signs a serialized transaction (without sending it), and returns it with its signature added.
export async function signSolanaTransaction(transaction: Uint8Array, devnet = false): Promise<Uint8Array> {
  if (!current) throw new Error('Connect a Solana wallet first.')
  const chain = devnet ? 'solana:devnet' : 'solana:mainnet'
  const [result] = (await current.wallet.features['solana:signTransaction'].signTransaction({ account: current.account, transaction, chain })) as {
    signedTransaction: Uint8Array
  }[]
  return result!.signedTransaction
}
