import { getConfig, INJECTIVE, type Chain, type Config, type EvmChain } from './api'
import { restoreCosmos } from './cosmos-wallet.svelte'
import { trackRecent } from './transfers.svelte'

type View = 'bridge' | 'swap' | 'track' | 'terms'

// Each view has a path. Other apps can deep link to a lookup: /track?q=<address or tx hash> (or the older /?q=…).
const PATHS: Record<View, string> = { bridge: '/bridge', swap: '/get-inj', track: '/track', terms: '/terms' }
export const linkedQuery = new URLSearchParams(location.search).get('q')?.trim() ?? ''
const viewAt = (path: string) => (Object.keys(PATHS) as View[]).find((view) => PATHS[view] === path.replace(/\/+$/, ''))

export const app = $state({
  config: undefined as Config | undefined,
  chains: [] as Chain[], // every chain the bridges reach: CCTP's first (Injective first), then by how many bridges reach them
  error: '',
  view: (viewAt(location.pathname) ?? (linkedQuery ? 'track' : 'bridge')) as View,
  open: undefined as string | undefined, // key of the recent transfer shown instead of the bridge form (see recentKey)
  bridgeQuery: '', // the bridge form's route, kept in its URL so it can be shared (see setBridgeQuery)
})

export const chainOf = (domain?: number) => (domain === undefined ? undefined : app.chains.find((chain) => chain.domain === domain))
// By id, as in links (/bridge?from=arbitrum&to=injective) and the logo files.
export const chainById = (id?: string | null) => (id ? app.chains.find((chain) => chain.id === id.toLowerCase()) : undefined)
// A transfer's chain: by id, or by CCTP domain for transfers saved before chains had ids.
export const chainFor = (id?: string, domain?: number) => chainById(id) ?? chainOf(domain)
export const injective = () => chainOf(INJECTIVE) as EvmChain & { domain: number; usdc: `0x${string}` }
export const txLink = (chain: Chain | undefined, hash?: string) => (chain?.explorer && hash ? chain.explorer.replace('{tx}', hash) : undefined)

// The bridge form's route as a query string, '' to leave it out. Kept in the address bar while the form is on screen.
export function setBridgeQuery(query: string) {
  app.bridgeQuery = query
  const url = PATHS.bridge + query
  if (app.view === 'bridge' && location.pathname + location.search !== url) history.replaceState(history.state, '', url)
}

export async function loadConfig() {
  app.error = ''
  try {
    const config = await getConfig()
    // Solana's CCTP programs come with the config.
    const programs = config.solana && { tokenMessenger: config.solana.tokenMessenger, messageTransmitter: config.solana.messageTransmitter }
    app.chains = config.networks.map((c) => (c.kind === 'solana' && programs ? { ...c, ...programs } : c)) as Chain[]
    app.config = config
    if (app.view === 'swap' && !config.swap) navigate('bridge', undefined, true)
    void trackRecent(config.autoRedeem)
    restoreCosmos(app.chains)
  } catch (err) {
    app.error = (err as Error).message
  }
}

// replace: fix up the URL without adding a history entry.
export function navigate(view: View, open?: string, replace = false) {
  app.view = view
  app.open = open
  // A lookup's ?q= stays with Track, until another search replaces it.
  const url = view === 'track' && viewAt(location.pathname) === 'track' ? PATHS.track + location.search : view === 'bridge' ? PATHS.bridge + app.bridgeQuery : PATHS[view]
  if (url !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState'](null, '', url)
  scrollTo({ top: 0 })
}

// Back and forward switch views.
addEventListener('popstate', () => {
  app.view = viewAt(location.pathname) ?? (new URLSearchParams(location.search).has('q') ? 'track' : 'bridge')
  app.open = undefined
  // The bridge form stays as it was, which can be a newer route than the one in the entry: the address bar follows the form.
  if (app.view === 'bridge') setBridgeQuery(app.bridgeQuery)
})
