<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check'
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
  import { slide } from 'svelte/transition'
  import { chainById } from '$lib/app.svelte'
  import { walletKind } from '$lib/address'
  import { formatToken, short } from '$lib/evm'
  import { ms } from '$lib/motion'
  import { NOTES, onboard, scan, several, walletFor, type Row, type Selected } from '$lib/onboard.svelte'
  import { usd } from '$lib/routes'
  import ChainIcon from './ChainIcon.svelte'
  import TokenIcon from './TokenIcon.svelte'

  // What the scan found, by network (and account, with several of a wallet): each one's total, and its tokens with what
  // moves of each. Ticking a token takes it whole whatever the amount, unticking leaves it.
  let { list, picked, disabled = false, ontoggle }: { list: Row[]; picked: Map<string, Selected>; disabled?: boolean; ontoggle: (row: Row) => void } = $props()

  let small = $state(false) // holdings under a dollar, shown on demand
  let open = $state<Record<string, boolean>>({})

  const shown = (r: Row) => small || !r.small || picked.has(r.key)
  const groups = $derived.by(() => {
    const byChain = new Map<string, Row[]>()
    for (const r of list) byChain.set(`${r.group}:${r.chain.id}`, [...(byChain.get(`${r.group}:${r.chain.id}`) ?? []), r])
    return [...byChain]
      .map(([key, rows]) => {
        const visible = rows.filter(shown).sort((a, b) => worth(b) - worth(a))
        const total = rows.reduce((sum, r) => sum + worth(r), 0)
        const moving = rows.reduce((sum, r) => sum + (picked.get(r.key)?.usd ?? 0), 0)
        const { chain, owner } = rows[0]!
        const kind = walletKind(chain)
        return { key, chain, owner: (kind === 'evm' || kind === 'solana') && several(kind) ? owner : '', rows: visible, total, moving, count: rows.filter((r) => picked.has(r.key)).length }
      })
      .filter((g) => g.rows.length)
      .sort((a, b) => b.total - a.total)
  })
  // Tokens that look unsellable don't count towards the totals.
  const worth = (r: Row) => (r.note === 'illiquid' ? 0 : (r.holding.usd ?? 0))
  const total = $derived(list.reduce((sum, r) => sum + worth(r), 0))
  const networks = $derived(new Set(list.filter((r) => worth(r)).map((r) => r.chain.id)).size)
  const hidden = $derived(list.filter((r) => !shown(r)).length)
  const failed = $derived([...new Map(onboard.holdings.flatMap((g) => Object.values(g)).filter((c) => c.error).map((c) => [c.chain, c])).values()])
  // Few networks: all open. Many: closed, with their totals.
  const expanded = (id: string) => open[id] ?? groups.length <= 2

  const amount = (r: Row, units: bigint) => formatToken(units, r.holding.token.decimals)
</script>

<section class="bg-card rounded-lg border shadow-xs" aria-label="Your assets">
  <header class="flex items-center gap-2 px-3.5 pt-3 pb-2">
    <!-- One line on a phone too: the spinning refresh icon says it's reading. -->
    <span class="text-muted-foreground text-xs whitespace-nowrap">Your assets</span>
    {#if onboard.scanning}
      <span class="text-muted-foreground/70 text-[11px] max-sm:hidden">reading…</span>
    {/if}
    <span class="ml-auto text-[13px] font-medium whitespace-nowrap tabular-nums">
      {#if list.length}{#key total}<span class="settle">≈ {usd(total)}</span>{/key}{:else if onboard.scanning}<span class="skeleton inline-block h-3.5 w-16 rounded align-middle"></span>{/if}
    </span>
    {#if networks}<span class="text-muted-foreground text-[11px] whitespace-nowrap tabular-nums">· {networks} network{networks === 1 ? '' : 's'}</span>{/if}
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground -mr-1 rounded-md p-1 transition-[color,scale] active:scale-90 disabled:opacity-50"
      aria-label="Read the balances again"
      title="Read the balances again"
      disabled={disabled || !!onboard.scanning}
      onclick={() => scan(true)}
    >
      <RefreshCwIcon class={['size-3.5', onboard.scanning && 'animate-spin']} />
    </button>
  </header>

  <div class="border-t">
    {#each groups as g (g.key)}
      {@const on = expanded(g.key)}
      <div class="border-b last:border-b-0">
        <button
          type="button"
          class="hover:bg-muted/40 flex h-10 w-full items-center gap-2 px-3.5 text-left transition-colors"
          aria-expanded={on}
          onclick={() => (open[g.key] = !on)}
        >
          <ChevronRightIcon class={['text-muted-foreground size-3.5 shrink-0 transition-transform duration-200', on && 'rotate-90']} />
          <ChainIcon chain={g.chain} class="size-5 text-[9px]" />
          <span class="min-w-0 flex-1 truncate font-medium">
            {g.chain.name}{#if g.owner}<span class="text-muted-foreground ml-1.5 font-mono text-[11px] font-normal" title={g.owner}>{short(g.owner)}</span>{/if}
          </span>
          {#if g.count}
            <span class="text-muted-foreground shrink-0 text-[11px] tabular-nums">{usd(g.moving)} of</span>
          {/if}
          <span class="shrink-0 tabular-nums">{usd(g.total)}</span>
        </button>
        {#if on}
          <div class="pb-1.5" transition:slide={{ duration: ms(160) }}>
            {#each g.rows as r (r.key)}
              {@const pick = picked.get(r.key)}
              {@const raw = BigInt(r.holding.raw)}
              {@const connect = r.note === 'wallet' && !disabled ? walletFor(r.chain) : undefined}
              <!-- A holding that needs another wallet isn't picked: its row offers to connect that wallet instead. -->
              <svelte:element
                this={connect ? 'div' : 'button'}
                type={connect ? undefined : 'button'}
                role={connect ? undefined : 'checkbox'}
                aria-checked={connect ? undefined : !!pick}
                disabled={connect ? undefined : disabled || !!r.note}
                class={['flex w-full items-center gap-2.5 py-1.5 pr-3.5 pl-4 text-left transition-colors disabled:hover:bg-transparent', !connect && 'hover:bg-muted/40']}
                onclick={connect ? undefined : () => ontoggle(r)}
              >
                <span
                  class={[
                    'flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                    pick ? 'bg-foreground border-foreground text-background' : r.note ? 'border-muted-foreground/20' : 'border-muted-foreground/45',
                  ]}
                  aria-hidden="true"
                >
                  {#if pick}<CheckIcon class="size-2.5" strokeWidth={3.5} />{/if}
                </span>
                <TokenIcon token={r.holding.token} class="size-6 text-[10px] {r.note && r.note !== 'there' ? 'opacity-60' : ''}" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5 text-[13px] font-medium">
                    <span class="truncate">{r.holding.token.symbol}</span>
                    {#if connect}
                      <button type="button" class="bg-muted text-foreground hover:bg-muted-foreground/20 shrink-0 rounded-sm px-1 py-px text-[10px] leading-none font-normal transition-colors" onclick={connect.connect}>
                        {connect.label}
                      </button>
                    {:else if r.note}
                      <span class={['shrink-0 rounded-sm px-1 py-px text-[10px] leading-none font-normal', r.note === 'there' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground']}>
                        {r.note === 'wallet' && r.chain.kind === 'cosmos' ? 'Needs Keplr' : NOTES[r.note]}
                      </span>
                    {:else if r.holding.native && r.chain.kind !== 'hypercore'}
                      <span class="bg-muted text-muted-foreground shrink-0 rounded-sm px-1 py-px text-[10px] leading-none font-normal" title="The chain's gas token: some stays for the transactions">gas</span>
                    {:else if r.noGas}
                      <span class="bg-warning/15 text-warning shrink-0 rounded-sm px-1 py-px text-[10px] leading-none font-normal" title="No gas on {r.chain.name}: the plan brings some first, or leaves it">no gas</span>
                    {/if}
                  </span>
                  <span class="text-muted-foreground block truncate text-[11px] tabular-nums">
                    {#if pick && pick.amount < raw}{amount(r, pick.amount)} of {amount(r, raw)}{:else}{amount(r, raw)}{/if}
                    {#if r.holding.source === 'symbol' && r.holding.usd !== undefined}<span title="Priced by its symbol">· est.</span>{/if}
                  </span>
                </span>
                <span class={['shrink-0 text-right text-[13px] tabular-nums', !pick && 'text-muted-foreground']}>
                  {#if r.holding.usd === undefined}—{:else if pick}{#key pick.usd}<span class="settle inline-block">{usd(pick.usd)}</span>{/key}{:else}{usd(r.holding.usd)}{/if}
                </span>
              </svelte:element>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      {#if onboard.scanning}
        {#each { length: 4 }, i (i)}
          <div class="flex h-10 items-center gap-2.5 border-b px-3.5 last:border-b-0" aria-hidden="true">
            <span class="skeleton size-5 rounded-full"></span>
            <span class="skeleton h-3 w-24 rounded"></span>
            <span class="skeleton ml-auto h-3 w-14 rounded"></span>
          </div>
        {/each}
      {:else}
        <p class="text-muted-foreground px-3.5 py-5 text-center text-xs">
          {#if hidden}Only dust under $1 here.{:else if onboard.groups.length}Nothing found on the networks read.{:else}Connect a wallet to see what it holds.{/if}
        </p>
      {/if}
    {/each}
  </div>

  {#if hidden || small || failed.length}
    <footer class="text-muted-foreground flex items-center gap-3 border-t px-3.5 py-2 text-[11px]">
      {#if hidden || small}
        <button type="button" class="hover:text-foreground transition-colors" onclick={() => (small = !small)}>
          {small ? 'Hide under $1' : `+${hidden} under $1`}
        </button>
      {/if}
      {#if failed.length}
        <span class="ml-auto truncate" title={failed.map((c) => `${chainById(c.chain)?.name ?? c.chain}: ${c.error}`).join('\n')}>
          Couldn't read {failed.map((c) => chainById(c.chain)?.name ?? c.chain).slice(0, 3).join(', ')}{failed.length > 3 ? ` +${failed.length - 3}` : ''}
        </span>
      {/if}
    </footer>
  {/if}
</section>
