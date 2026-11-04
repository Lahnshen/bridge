<script lang="ts" module>
  import { getTokens, type Token } from '$lib/api'

  // Each chain's list loads once per page view.
  const lists = new Map<string, ReturnType<typeof getTokens>>()
  const listOf = (chain: string) => {
    let hit = lists.get(chain)
    if (!hit) {
      hit = getTokens(chain)
      lists.set(chain, hit)
      hit.catch(() => lists.delete(chain))
    }
    return hit
  }
  // Lists can name a token twice (two bridges' entries for it).
  const unique = (tokens: Token[]) => [...new Map(tokens.map((t) => [t.address.toLowerCase(), t])).values()]

  // Typing straight away suits a mouse and keyboard; on a phone the keyboard would cover the list.
  const typing = matchMedia('(pointer: fine)').matches

  // The networks most transfers use, in this order, above the rest (A to Z).
  const POPULAR = ['injective', 'injective-cosmos', 'ethereum', 'solana', 'base', 'arbitrum', 'bnb', 'optimism', 'polygon', 'avalanche', 'osmosis', 'cosmoshub', 'noble', 'bitcoin', 'hyperliquid', 'tron', 'sui']
</script>

<script lang="ts">
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
  import CheckIcon from '@lucide/svelte/icons/check'
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
  import SearchIcon from '@lucide/svelte/icons/search'
  import XIcon from '@lucide/svelte/icons/x'
  import { tick } from 'svelte'
  import { Spinner } from '$lib/components/ui/spinner'
  import { sameToken, type Chain } from '$lib/api'
  import { short } from '$lib/evm'
  import { connected } from '$lib/reach'
  import ChainIcon from './ChainIcon.svelte'
  import TokenIcon from './TokenIcon.svelte'

  // One side of the transfer, token and chain in one button. It opens a dialog to pick a network, then one of its tokens:
  // popular ones first, then by symbol, name or contract address. The other side's network is marked: picking it swaps the
  // sides. Networks the app can only send to are left out of the From side; ones with no bridge to the other side say so.
  let {
    chain,
    token,
    chains,
    other,
    side,
    title,
    disabled = false,
    onchange,
  }: {
    chain: Chain
    token: Token
    chains: Chain[]
    other: Chain
    side: 'from' | 'to'
    title: string
    disabled?: boolean
    onchange: (chain: Chain, token: Token) => void
  } = $props()

  let dialog = $state<HTMLDialogElement>()
  let tokenSearch = $state<HTMLInputElement>()
  let browsing = $state<Chain>() // the network whose tokens are listed, while the dialog is open
  let pane = $state<'chains' | 'tokens'>('tokens') // on phones the dialog shows one list at a time
  let chainQuery = $state('')
  let query = $state('')
  let popular = $state<Token[]>([])
  let found = $state<Token[]>([])
  let loading = $state(false)
  let error = $state('')

  const label = $derived(side === 'from' ? 'From' : 'To')
  const otherLabel = $derived(side === 'from' ? 'To' : 'From')

  // A search matches the start of words in a network's name or id: "osmo" finds Osmosis, not Cosmos Hub.
  const words = (value: string) => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const listed = $derived.by(() => {
    const q = words(chainQuery)
    const rank = (c: Chain) => (POPULAR.includes(c.id) ? POPULAR.indexOf(c.id) : POPULAR.length)
    const matches = chains.filter((c) => {
      const own = [...words(c.name), ...words(c.id)]
      return q.every((part) => own.some((word) => word.startsWith(part)))
    })
    const top = matches.filter((c) => POPULAR.includes(c.id)).sort((a, b) => rank(a) - rank(b))
    const rest = matches.filter((c) => !POPULAR.includes(c.id)).sort((a, b) => a.name.localeCompare(b.name))
    return { top, rest }
  })

  $effect(() => {
    if (!browsing) return
    const [id, q] = [browsing.id, query.trim()]
    loading = true
    error = ''
    let stale = false
    const load = () =>
      (q ? getTokens(id, q) : listOf(id)).then(
        (result) => {
          if (stale) return
          if (!q) popular = unique(result.popular)
          found = unique(result.tokens)
          loading = false
        },
        (err) => !stale && ((error = (err as Error).message), (found = []), (loading = false)),
      )
    const timer = setTimeout(load, q ? 250 : 0)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  })

  async function show() {
    browsing = chain
    pane = 'tokens'
    chainQuery = query = ''
    popular = []
    found = []
    await tick() // the dialog's content, so it can focus the search box and show the network
    dialog?.showModal()
    dialog?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  function browse(next: Chain) {
    pane = 'tokens'
    if (next.id === browsing?.id) return
    browsing = next
    query = ''
    popular = []
    found = []
    if (typing) void tick().then(() => tokenSearch?.focus())
  }

  function pick(picked: Token) {
    onchange(browsing!, picked)
    dialog?.close()
  }
</script>

{#snippet network(c: Chain)}
  {@const sendOnly = side === 'from' && !c.send}
  {@const isOther = c.id === other.id}
  <button
    type="button"
    role="option"
    aria-selected={c.id === browsing?.id}
    aria-disabled={sendOnly}
    disabled={sendOnly}
    title={sendOnly ? `The app can send to ${c.name}, not from it` : isOther ? 'Picking it swaps the two sides' : undefined}
    class={[
      'flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-[13px] whitespace-nowrap transition-colors',
      c.id === browsing?.id ? 'bg-muted font-medium' : 'hover:bg-muted/60',
      sendOnly && 'pointer-events-none opacity-45',
    ]}
    onclick={() => browse(c)}
  >
    <ChainIcon chain={c} class="size-[18px] text-[9px]" />
    <span class="min-w-0 flex-1 truncate">{c.name}</span>
    {#if sendOnly}
      <span class="text-muted-foreground text-[10px] font-normal">Receive only</span>
    {:else if isOther}
      <span class="text-muted-foreground text-[10px] font-normal">{otherLabel}</span>
    {:else if !connected(side === 'from' ? c : other, side === 'from' ? other : c)}
      <span class="text-muted-foreground/70 text-[10px] font-normal" title="No bridge connects it with {other.name}">No route</span>
    {/if}
  </button>
{/snippet}

<button
  type="button"
  class="bg-muted/80 hover:bg-muted inline-flex h-11 shrink-0 items-center gap-2 rounded-md pr-2 pl-1.5 text-left transition-[background-color,scale] active:scale-[0.97] disabled:opacity-60"
  aria-haspopup="dialog"
  aria-label="{label}: {token.symbol} on {chain.name}"
  {disabled}
  onclick={show}
>
  <span class="relative shrink-0">
    <TokenIcon {token} class="size-7 text-xs" />
    <ChainIcon {chain} class="ring-muted absolute -right-1 -bottom-0.5 size-3.5 text-[7px] ring-2" />
  </span>
  <span class="flex min-w-0 flex-col">
    <span class="max-w-24 truncate text-[13px] leading-tight font-medium">{token.symbol}</span>
    <span class="text-muted-foreground max-w-24 truncate text-[11px] leading-tight">{chain.name}</span>
  </span>
  <ChevronDownIcon class="text-muted-foreground size-3.5 shrink-0" />
</button>

<dialog
  bind:this={dialog}
  class="bg-popover text-popover-foreground m-auto h-[min(100dvh-2rem,34rem)] w-[min(100%-2rem,42rem)] overflow-hidden rounded-lg border p-0 shadow-2xl"
  aria-label={title}
  onclose={() => (browsing = undefined)}
  onclick={(event) => event.target === dialog && dialog?.close()}
>
  {#if browsing}
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between border-b px-4 py-2.5">
        <h2 class="text-sm font-semibold tracking-tight">{title}</h2>
        <button type="button" class="text-muted-foreground hover:text-foreground -mr-1 rounded-md p-1 transition-colors" aria-label="Close" onclick={() => dialog?.close()}>
          <XIcon class="size-4" />
        </button>
      </div>

      <div class="flex min-h-0 flex-1">
        <!-- Networks: a column on wide screens, a page of its own on phones. -->
        <div class={['min-h-0 w-full flex-col sm:flex sm:w-56 sm:shrink-0 sm:border-r', pane === 'chains' ? 'flex' : 'hidden']}>
          <label class="flex items-center gap-2 border-b px-3">
            <SearchIcon class="text-muted-foreground size-3.5 shrink-0" />
            <input
              class="placeholder:text-muted-foreground h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              placeholder="Search {chains.length} networks"
              aria-label="Search networks"
              autocomplete="off"
              spellcheck="false"
              bind:value={chainQuery}
            />
          </label>
          <div class="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="Network">
            {#each listed.top as c (c.id)}{@render network(c)}{/each}
            {#if listed.top.length && listed.rest.length}
              <p class="text-muted-foreground px-2 pt-2.5 pb-1 text-[10px] font-medium tracking-wide uppercase">All networks</p>
            {/if}
            {#each listed.rest as c (c.id)}{@render network(c)}{/each}
            {#if !listed.top.length && !listed.rest.length}
              <p class="text-muted-foreground px-2 py-6 text-center text-xs">No network named “{chainQuery.trim()}”.</p>
            {/if}
          </div>
        </div>

        <div class={['min-h-0 min-w-0 flex-1 flex-col sm:flex', pane === 'tokens' ? 'flex' : 'hidden']}>
          <!-- Phones: the network, tapped to change it. -->
          <button type="button" class="hover:bg-muted/60 flex h-10 shrink-0 items-center gap-2 border-b px-3 text-left text-[13px] font-medium sm:hidden" onclick={() => (pane = 'chains')}>
            <ArrowLeftIcon class="text-muted-foreground size-3.5" />
            <ChainIcon chain={browsing} class="size-[18px] text-[9px]" />
            <span class="min-w-0 flex-1 truncate">{browsing.name}</span>
            <span class="text-muted-foreground text-[11px] font-normal">Change</span>
          </button>
          <label class="flex items-center gap-2 border-b px-3">
            <SearchIcon class="text-muted-foreground size-3.5 shrink-0" />
            <!-- svelte-ignore a11y_autofocus -->
            <input
              bind:this={tokenSearch}
              class="placeholder:text-muted-foreground h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              placeholder="Search {browsing.name} tokens or paste an address"
              aria-label="Search tokens"
              autocomplete="off"
              spellcheck="false"
              autofocus={typing}
              bind:value={query}
            />
            {#if loading}<Spinner class="text-muted-foreground size-3.5" />{/if}
          </label>

          {#if side === 'from' && !browsing.send}
            <p class="text-muted-foreground border-b px-3 py-2 text-xs">The app can send to {browsing.name}, not from it.</p>
          {:else if !query.trim() && popular.length}
            <div class="flex flex-wrap gap-1 border-b p-2">
              {#each popular as t (t.address)}
                <button
                  type="button"
                  class={['flex h-7 items-center gap-1 rounded-md border px-1.5 text-xs font-medium transition-[background-color,scale] active:scale-95', sameToken(t, token) ? 'bg-muted' : 'hover:bg-muted']}
                  onclick={() => pick(t)}
                >
                  <TokenIcon token={t} class="size-4" />{t.symbol}
                </button>
              {/each}
            </div>
          {/if}

          <div class="min-h-0 flex-1 overflow-y-auto p-1">
            {#if !(side === 'from' && !browsing.send)}
              {#each found as t (t.address)}
                <button
                  type="button"
                  class="hover:bg-muted focus-visible:bg-muted flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors"
                  onclick={() => pick(t)}
                >
                  <TokenIcon token={t} class="size-7" />
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1 text-[13px] font-medium">
                      <span class="truncate">{t.symbol}</span>
                      {#if !t.verified}<span class="text-warning shrink-0 text-[10px] font-normal" title="Not on the verified token lists: check the address">unverified</span>{/if}
                    </span>
                    <span class="text-muted-foreground block truncate text-[11px]">{t.name}{t.address.length > 12 && !/^0x0+$|^1+$/.test(t.address) ? ` · ${short(t.address)}` : ''}</span>
                  </span>
                  {#if sameToken(t, token)}<CheckIcon class="text-muted-foreground size-3.5 shrink-0" />{/if}
                </button>
              {:else}
                {#if loading}
                  {#each { length: 6 }, i (i)}
                    <div class="flex items-center gap-2.5 px-2 py-1.5" aria-hidden="true">
                      <span class="skeleton size-7 rounded-full"></span>
                      <span class="flex flex-1 flex-col gap-1.5"><span class="skeleton h-3 w-16 rounded"></span><span class="skeleton h-2.5 w-28 rounded"></span></span>
                    </div>
                  {/each}
                {:else}
                  <p class="text-muted-foreground px-2 py-6 text-center text-xs">{error || (query.trim() ? 'No tokens found. Try the contract address.' : 'No tokens listed.')}</p>
                {/if}
              {/each}
            {/if}
          </div>
        </div>
      </div>
    </div>
  {/if}
</dialog>
