import { getConfig, INJECTIVE, type Chain, type Config } from './api'
import { trackRecent } from './transfers.svelte'

type View = 'bridge' | 'swap' | 'track'

// Each view has a path. Other apps can deep link to a lookup: /track?q=<address or tx hash> (or the older /?q=…).
const PATHS: Record<View, string> = { bridge: '/bridge', swap: '/get-inj', track: '/track' }
export const linkedQuery = new URLSearchParams(location.search).get('q')?.trim() ?? ''
const viewAt = (path: string) => (Object.keys(PATHS) as View[]).find((view) => PATHS[view] === path.replace(/\/+$/, ''))

export const app = $state({
  config: undefined as Config | undefined,
  chains: [] as Chain[], // every chain the bridge reaches: Injective first, then the other EVM chains, then Solana
  error: '',
  view: (viewAt(location.pathname) ?? (linkedQuery ? 'track' : 'bridge')) as View,
  open: undefined as string | undefined, // key of the recent transfer shown instead of the bridge form (see recentKey)
})

export const chainOf = (domain?: number) => app.chains.find((chain) => chain.domain === domain)
export const injective = () => chainOf(INJECTIVE) as Extract<Chain, { kind: 'evm' }>

export async function loadConfig() {
  app.error = ''
  try {
    const config = await getConfig()
    app.chains = [...config.chains.map((c) => ({ ...c, kind: 'evm' as const })), ...(config.solana ? [{ ...config.solana, kind: 'solana' as const }] : [])]
    app.config = config
    if (app.view === 'swap' && !config.swap) navigate('bridge', undefined, true)
    void trackRecent(config.autoRedeem)
  } catch (err) {
    app.error = (err as Error).message
  }
}

// replace: fix up the URL without adding a history entry.
export function navigate(view: View, open?: string, replace = false) {
  app.view = view
  app.open = open
  // A lookup's ?q= stays with Track, until another search replaces it.
  const url = view === 'track' && viewAt(location.pathname) === 'track' ? PATHS.track + location.search : PATHS[view]
  if (url !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState'](null, '', url)
  scrollTo({ top: 0 })
}

// Back and forward switch views.
addEventListener('popstate', () => {
  app.view = viewAt(location.pathname) ?? (new URLSearchParams(location.search).has('q') ? 'track' : 'bridge')
  app.open = undefined
})
