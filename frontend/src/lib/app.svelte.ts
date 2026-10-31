import { getConfig, INJECTIVE, type Chain, type Config } from './api'
import { trackRecent } from './transfers.svelte'

// Other apps can deep link to a lookup: /?q=<address or tx hash>
export const linkedQuery = new URLSearchParams(location.search).get('q')?.trim() ?? ''

export const app = $state({
  config: undefined as Config | undefined,
  chains: [] as Chain[], // every chain the bridge reaches: Injective first, then the other EVM chains, then Solana
  error: '',
  view: (linkedQuery ? 'track' : 'bridge') as 'bridge' | 'swap' | 'track',
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
    void trackRecent(config.autoRedeem)
  } catch (err) {
    app.error = (err as Error).message
  }
}

export function navigate(view: typeof app.view, open?: string) {
  app.view = view
  app.open = open
  if (view === 'bridge' && location.search) history.replaceState(null, '', location.pathname)
  scrollTo({ top: 0 })
}
