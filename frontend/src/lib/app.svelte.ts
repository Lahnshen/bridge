import { getConfig, INJECTIVE, type Config } from './api'
import { trackRecent } from './transfers.svelte'

// Other apps can deep link to a lookup: /?q=<address or tx hash>
export const linkedQuery = new URLSearchParams(location.search).get('q')?.trim() ?? ''

export const app = $state({
  config: undefined as Config | undefined,
  error: '',
  view: (linkedQuery ? 'track' : 'bridge') as 'bridge' | 'track' | 'history',
  open: undefined as string | undefined, // tx hash of the recent transfer shown instead of the bridge form
})

export const chainOf = (domain?: number) => app.config?.chains.find((chain) => chain.domain === domain)
export const injective = () => chainOf(INJECTIVE)!
export const remotes = () => app.config?.chains.filter((chain) => chain.domain !== INJECTIVE) ?? []

export async function loadConfig() {
  app.error = ''
  try {
    app.config = await getConfig()
    void trackRecent(app.config.autoRedeem)
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
