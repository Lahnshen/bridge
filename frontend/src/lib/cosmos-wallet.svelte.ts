import type { Chain, CosmosChain, PreparedTx } from './api'
import { bech32Decode, bech32Encode } from './bech32'
import { wallet, type WalletInfo } from './wallet.svelte'

// The Cosmos wallet: Keplr (window.keplr). A chain is enabled (the wallet asks the user once) before its key is read; a
// chain the wallet doesn't know is suggested to it from the chain registry. Transactions are built by the server and signed here with SIGN_MODE_DIRECT.

type Key = { algo: string; pubKey: Uint8Array; bech32Address: string; isNanoLedger?: boolean }
type SignDoc = { bodyBytes: Uint8Array; authInfoBytes: Uint8Array; chainId: string; accountNumber: unknown }
type Provider = {
  enable(chainIds: string | string[]): Promise<void>
  getKey(chainId: string): Promise<Key>
  signDirect(chainId: string, signer: string, signDoc: SignDoc, options?: { preferNoSetFee?: boolean }): Promise<{ signed: Omit<SignDoc, 'accountNumber'>; signature: { signature: string } }>
  experimentalSuggestChain?(info: unknown): Promise<void>
}

const SOURCES: (WalletInfo & { get: () => Provider | undefined })[] = [
  { id: 'keplr', name: 'Keplr', get: () => (window as { keplr?: Provider }).keplr },
]
const STORAGE_KEY = 'cosmos-wallet'

export const cosmosWallet = $state({
  available: [] as WalletInfo[],
  connected: undefined as WalletInfo | undefined,
  address: undefined as string | undefined, // on the chain last connected (see chain)
  chain: undefined as string | undefined, // that chain's id
  addresses: {} as Record<string, string>, // every address the wallet gave, by chain id
  slip44: {} as Record<string, number>, // their key types, by chain id
})
let pending: CosmosChain | undefined // the chain to connect for, while the picker is open
const chains = new Map<string, CosmosChain>() // the chains the wallet was asked about, by id

// Extensions inject their provider as the page loads, some only after it.
function discover() {
  for (const s of SOURCES) if (s.get() && !cosmosWallet.available.some((w) => w.id === s.id)) cosmosWallet.available.push({ id: s.id, name: s.name })
}
discover()
addEventListener('load', discover)
setTimeout(discover, 1000)

// Another account picked in the wallet: the addresses it gave are stale; the one on screen is asked for again.
for (const s of SOURCES) {
  addEventListener(`${s.id}_keystorechange`, () => {
    if (cosmosWallet.connected?.id !== s.id) return
    const chain = cosmosWallet.chain && chains.get(cosmosWallet.chain)
    cosmosWallet.addresses = {}
    cosmosWallet.slip44 = {}
    if (chain) void connectCosmos(s.id, chain).catch(disconnectCosmos)
  })
}

const provider = () => SOURCES.find((s) => s.id === cosmosWallet.connected?.id)?.get()

// What Keplr needs to add a chain it doesn't list, from the chain registry (via the server's chain list).
function chainInfo(chain: CosmosChain) {
  if (!chain.rpc || !chain.rest || !chain.native) return
  const p = chain.bech32
  const currency = { coinDenom: chain.native.symbol, coinMinimalDenom: chain.native.address, coinDecimals: chain.native.decimals }
  const price = Number(chain.gas?.price ?? 0.025)
  const fee = chain.gas && chain.gas.denom !== chain.native.address ? { coinDenom: chain.gas.denom, coinMinimalDenom: chain.gas.denom, coinDecimals: 6 } : currency
  return {
    chainId: chain.cosmosId,
    chainName: chain.name,
    rpc: chain.rpc,
    rest: chain.rest,
    bip44: { coinType: chain.slip44 },
    bech32Config: { bech32PrefixAccAddr: p, bech32PrefixAccPub: `${p}pub`, bech32PrefixValAddr: `${p}valoper`, bech32PrefixValPub: `${p}valoperpub`, bech32PrefixConsAddr: `${p}valcons`, bech32PrefixConsPub: `${p}valconspub` },
    currencies: [currency],
    feeCurrencies: [{ ...fee, gasPriceStep: { low: price, average: price, high: price * 1.5 } }],
    stakeCurrency: currency,
    features: chain.slip44 === 60 ? ['eth-address-gen', 'eth-key-sign'] : [],
  }
}

// The wallet's key on a chain: enabled first (a prompt the first time), and suggested if the wallet doesn't know the chain.
async function keyOn(p: Provider, chain: CosmosChain) {
  chains.set(chain.id, chain)
  try {
    await p.enable(chain.cosmosId)
  } catch (err) {
    // Wallets word "I don't know this chain" differently; a refusal is the one error not worth suggesting the chain for.
    const info = chainInfo(chain)
    if (!info || !p.experimentalSuggestChain || /reject|denied|cancel|closed/i.test((err as Error)?.message ?? '')) throw err
    await p.experimentalSuggestChain(info)
    await p.enable(chain.cosmosId)
  }
  const key = await p.getKey(chain.cosmosId)
  cosmosWallet.addresses[chain.id] = key.bech32Address
  cosmosWallet.slip44[chain.id] = chain.slip44
  return key
}

// Connects right away when there's a single wallet, otherwise opens the picker.
export function connectCosmosWallet(chain: CosmosChain) {
  pending = chain
  const [only, ...others] = cosmosWallet.available
  if (only && !others.length) return connectCosmos(only.id).catch(() => {})
  wallet.picking = 'cosmos'
}

export async function connectCosmos(id: string, chain = pending, silent = false) {
  const p = SOURCES.find((s) => s.id === id)?.get()
  if (!p || !chain) return
  const key = await keyOn(p, chain)
  if (silent && cosmosWallet.connected) return
  cosmosWallet.connected = cosmosWallet.available.find((w) => w.id === id) ?? { id, name: id }
  cosmosWallet.address = key.bech32Address
  cosmosWallet.chain = chain.id
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, chain: chain.id }))
  wallet.picking = false
}

// Reconnects the wallet used before (on its chain), without a prompt: the chain is already enabled.
export function restoreCosmos(chains: Chain[]) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { id: string; chain: string } | null
    const chain = chains.find((c) => c.id === saved?.chain)
    if (saved && chain?.kind === 'cosmos') void connectCosmos(saved.id, chain, true).catch(() => {})
  } catch {
    // nothing saved
  }
}

export function disconnectCosmos() {
  cosmosWallet.connected = cosmosWallet.address = cosmosWallet.chain = undefined
  cosmosWallet.addresses = {}
  cosmosWallet.slip44 = {}
  localStorage.removeItem(STORAGE_KEY)
}

// The account's address on a chain without asking the wallet, where one key surely gives it: chains with the Cosmos Hub's
// key type (118) all derive the same 20 bytes, so an address the wallet gave on one is the account's on any other. Other
// key types are left to the wallet: some chains derive addresses differently under the same one.
export function derivedAddress(chain: CosmosChain) {
  if (cosmosWallet.addresses[chain.id]) return cosmosWallet.addresses[chain.id]
  if (chain.slip44 !== 118) return
  for (const [id, address] of Object.entries(cosmosWallet.addresses)) {
    const decoded = cosmosWallet.slip44[id] === 118 ? bech32Decode(address) : undefined
    if (decoded) return bech32Encode(chain.bech32, decoded.bytes)
  }
}

// The address from the wallet itself (a prompt if the chain isn't enabled yet).
export async function addressFromWallet(chain: CosmosChain) {
  const p = provider()
  if (!p) throw new Error('Connect a Cosmos wallet first.')
  return (await keyOn(p, chain)).bech32Address
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const bytes = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))

export async function cosmosKey(chain: CosmosChain) {
  const p = provider()
  if (!p) throw new Error('Connect a Cosmos wallet first.')
  const key = await keyOn(p, chain)
  // Ledger signs Amino JSON only, and the transactions here are protobuf (SIGN_MODE_DIRECT).
  if (key.isNanoLedger) throw new Error('Ledger accounts can only sign Amino transactions, which this app does not build. Use a software account.')
  return { address: key.bech32Address, pubKey: base64(key.pubKey), algo: key.algo.replace(/[_-]/g, '').toLowerCase() }
}

// The wallet signs the server's transaction as is (preferNoSetFee: the fee is the chain's gas price for simulated gas),
// and may still change the fee: the signed bytes are the ones to broadcast.
export async function signCosmos(chain: CosmosChain, signer: string, tx: PreparedTx) {
  const p = provider()
  if (!p) throw new Error('Connect a Cosmos wallet first.')
  const n = BigInt(tx.accountNumber)
  // A Long, as wallets expect: they read it with toString(), some with low and high.
  const accountNumber = { low: Number(n & 0xffffffffn) | 0, high: Number(n >> 32n) | 0, unsigned: true, toString: () => n.toString() }
  const { signed, signature } = await p.signDirect(
    chain.cosmosId,
    signer,
    { bodyBytes: bytes(tx.bodyBytes), authInfoBytes: bytes(tx.authInfoBytes), chainId: tx.chainId, accountNumber },
    { preferNoSetFee: true },
  )
  return { bodyBytes: base64(signed.bodyBytes), authInfoBytes: base64(signed.authInfoBytes), signature: signature.signature }
}
