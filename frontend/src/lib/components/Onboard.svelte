<script lang="ts">
  import FuelIcon from '@lucide/svelte/icons/fuel'
  import InfoIcon from '@lucide/svelte/icons/info'
  import PencilIcon from '@lucide/svelte/icons/pencil'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import WalletIcon from '@lucide/svelte/icons/wallet'
  import XIcon from '@lucide/svelte/icons/x'
  import { tick, untrack } from 'svelte'
  import { fade, slide } from 'svelte/transition'
  import { Button } from '$lib/components/ui/button'
  import { Spinner } from '$lib/components/ui/spinner'
  import { addressHint, parseAddress } from '$lib/address'
  import { getSwapQuote, sameAddress, type CosmosChain } from '$lib/api'
  import { app, chainById } from '$lib/app.svelte'
  import { addressFromWallet, connectCosmosWallet, cosmosWallet, derivedAddress } from '$lib/cosmos-wallet.svelte'
  import { short } from '$lib/evm'
  import { ms } from '$lib/motion'
  import { cancelPlan, choose, destination, destinationToken, groups, isMine, loadOnboard, makePlan, MAX_ITEMS, mineOn, onboard, rows, scan, setDestination, type Row } from '$lib/onboard.svelte'
  import { usd } from '$lib/routes'
  import { addCurrentSolana, connectSolanaWallet, forgetSolanaAccount, solanaWallet } from '$lib/solana-wallet.svelte'
  import { addCurrent, connectWallet, forgetAccount, wallet, walletError, type WalletAccount, type WalletInfo } from '$lib/wallet.svelte'
  import DestinationSelect from './DestinationSelect.svelte'
  import OnboardHoldings from './OnboardHoldings.svelte'
  import OnboardPlan from './OnboardPlan.svelte'

  // What the user's wallets hold on every network, in USD, and an amount of it moved into one stable on one chain. The
  // server plans the legs; lib/onboard.svelte.ts runs them.

  // A run left from before a reload is followed even from another tab.
  $effect(() => {
    if (app.view === 'onboard' || onboard.session) void loadOnboard()
  })
  // The list follows the connected wallets while the view is open (a plan on screen stays as it is, unless they change).
  $effect(() => {
    if (app.view !== 'onboard' || !onboard.config || onboard.session || ((onboard.plan || onboard.planning) && onboard.scanned === JSON.stringify(groups()))) return
    JSON.stringify(groups())
    untrack(() => void scan())
  })

  let amountText = $state('')
  let all = $state(false)
  let overrides = $state<Record<string, boolean>>({})
  let gas = $state(true)
  let recipientText = $state('')
  let editingRecipient = $state(false)
  let error = $state('')

  const toChain = $derived(chainById(onboard.to))
  const dest = $derived(destination())
  const toToken = $derived(destinationToken())

  // The user's first account there, unless the app can't sign there (Tron, Sui): then an address is pasted.
  const own = $derived(toChain && !dest?.receiveOnly ? mineOn(toChain) : undefined)
  const recipientValue = $derived(recipientText.trim() || own || '')
  const recipient = $derived(toChain && recipientValue ? parseAddress(toChain, recipientValue) : undefined)

  // What's already there stays for the user's own account; for another recipient it's sent by hand.
  const list = $derived(rows(recipient))
  const picked = $derived(choose(list, all ? 'all' : Number(amountText) || 0, overrides))
  const movable = $derived(list.filter((r) => !r.note && !r.small).reduce((sum, r) => sum + r.usd, 0))
  const selected = $derived([...picked.values()].reduce((sum, p) => sum + p.usd, 0))
  const networks = $derived(new Set([...picked.keys()].map((key) => key.split(':')[0])).size)

  // Ticking a token takes it whole, unticking leaves it out, whatever the amount.
  const toggle = (r: Row) => (overrides = { ...overrides, [r.key]: !picked.has(r.key) })

  // What the field shows: with All, what's ticked.
  const shownAmount = $derived(all ? (Math.floor(selected * 100) / 100).toFixed(2) : amountText)
  function setAmount(event: Event & { currentTarget: HTMLInputElement }) {
    const value = event.currentTarget.value.replace(',', '.').replace(/^\$/, '')
    if (/^\d*\.?\d{0,2}$/.test(value)) {
      amountText = value
      all = false
    } else event.currentTarget.value = shownAmount
  }
  // Everything that can move; the field then shows what's ticked.
  const takeAll = () => (all = true)

  // ---- Destination and recipient --------------------------------------------------------------------

  function pickDestination(chain: string, token: string) {
    setDestination(chain, token)
    error = ''
    const c = chainById(chain)
    if (recipientText.trim() && (!c || !parseAddress(c, recipientText))) resetRecipient()
  }
  function resetRecipient() {
    recipientText = ''
    editingRecipient = false
  }
  // Browsers skip autofocus once something on the page has focus.
  let recipientInput = $state<HTMLInputElement>()
  async function editRecipient() {
    editingRecipient = true
    await tick()
    recipientInput?.focus()
  }

  // ---- Gas there ---------------------------------------------------------------------------------------

  // Get INJ's minimum buys this much INJ, shown in the gas line.
  let injGas = $state('')
  $effect(() => {
    const getInj = onboard.config?.getInj
    if (app.view !== 'onboard' || onboard.to !== 'injective' || !getInj?.enabled || injGas) return
    getSwapQuote(String(Math.max(Number(getInj.min), dest?.gas.starterUsd ?? 0))).then(
      (q) => (injGas = Number(q.inj).toLocaleString('en-US', { maximumFractionDigits: 3 })),
      () => {},
    )
  })
  // The recipient's gas token there, when it's one of the user's accounts.
  const nativeThere = $derived(recipient ? list.find((r) => r.chain.id === onboard.to && r.holding.native && sameAddress(r.owner, recipient))?.holding : undefined)
  const gasLine = $derived.by(() => {
    if (!dest || !toChain || dest.receiveOnly) return
    const mine = !!recipient && isMine(toChain, recipient)
    // The planner adds gas only for the user's own account there.
    if (recipient && !mine) return { text: "Gas isn't added for another recipient", optional: false }
    if (dest.gas.stable) return { text: `Gas on ${toChain.name} is paid in ${toToken?.symbol ?? 'the stable'}`, optional: false }
    if (mine && (nativeThere?.usd ?? 0) >= dest.gas.hasGasUsd) return { text: `You have gas on ${toChain.name}`, optional: false }
    if (toChain.id === 'injective') {
      if (!onboard.config!.getInj.enabled) return { text: 'No INJ planned: Get INJ is off on this server', optional: false }
      if (!wallet.accounts.length) return { text: 'No INJ planned: Get INJ needs an EVM wallet to sign it', optional: false }
      return { text: `Gas on Injective: ${injGas ? `~${injGas} INJ` : 'some INJ'}, gas free`, optional: true }
    }
    return { text: `Gas on ${toChain.name}: ~${usd(dest.gas.starterUsd)} of ${toChain.native?.symbol ?? 'its gas token'}`, optional: true }
  })

  // ---- Review -----------------------------------------------------------------------------------------

  const anyWallet = $derived(!!(wallet.accounts.length || solanaWallet.accounts.length || cosmosWallet.address))
  const problem = $derived.by(() => {
    if (!anyWallet) return 'Connect a wallet'
    if (!list.length && onboard.scanning) return 'Reading your balances…'
    if (!movable && !picked.size) return 'Nothing to move'
    if (!picked.size) return 'Enter an amount'
    if (!recipient) return recipientValue ? 'Enter a valid recipient' : `Add a ${toChain?.name ?? ''} address`
  })
  const askRecipient = $derived(problem === `Add a ${toChain?.name ?? ''} address`)

  function review() {
    if (!anyWallet) return connectWallet()
    if (askRecipient) return editRecipient()
    void makePlan(list, picked, recipient!, gas && !!gasLine?.optional)
  }

  // ---- Wallets ------------------------------------------------------------------------------------------

  // Keplr gives one address for every Cosmos chain of the Hub's key type; asking it on the Hub covers the scanned ones.
  const hub = $derived(chainById('cosmoshub') as CosmosChain | undefined)
  const keplrReady = $derived(!!hub && !!derivedAddress(hub))
  async function connectKeplr() {
    if (!hub) return
    if (!cosmosWallet.connected) return connectCosmosWallet(hub)
    error = ''
    try {
      await addressFromWallet(hub)
    } catch (err) {
      error = walletError(err) ?? ''
    }
  }
  // Every connected account (EVM and Solana ones can be several, each left out with its ×), then the one the wallet is on
  // when it isn't among them, to add, else a way to connect another.
  type Kind = { id: string; label: string; accounts: { address: string; info?: WalletInfo }[]; offer?: string; connect: () => Promise<unknown> | unknown; take?: () => void; forget?: (address: string) => void }
  const listed = (accounts: WalletAccount[], available: WalletInfo[]) => accounts.map((a) => ({ address: a.address, info: available.find((w) => w.id === a.wallet) }))
  const offer = (accounts: WalletAccount[], now?: string) => (now && !accounts.some((a) => sameAddress(a.address, now)) ? now : undefined)
  const kinds = $derived(
    [
      { id: 'evm', label: 'EVM', accounts: listed(wallet.accounts, wallet.available), offer: offer(wallet.accounts, wallet.address), connect: connectWallet, take: addCurrent, forget: forgetAccount },
      onboard.config?.scan.solana && {
        id: 'solana',
        label: 'Solana',
        accounts: listed(solanaWallet.accounts, solanaWallet.available),
        offer: offer(solanaWallet.accounts, solanaWallet.address),
        connect: connectSolanaWallet,
        take: addCurrentSolana,
        forget: forgetSolanaAccount,
      },
      onboard.config?.scan.cosmos.length && { id: 'cosmos', label: 'Keplr', accounts: keplrReady && hub ? [{ address: derivedAddress(hub)!, info: { id: 'keplr', name: 'Keplr' } }] : [], connect: connectKeplr },
    ].filter(Boolean) as Kind[],
  )
  // Most wallets give only the account they're on: another is added by switching to it there.
  let hint = $state<{ kind: string; text: string }>()
  async function addTo(k: Kind) {
    hint = undefined
    const added = await k.connect()
    const name = k.accounts[0]?.info?.name ?? 'your wallet'
    if (added === 0) hint = { kind: k.id, text: `${name} gave only accounts already here. Switch to another account in ${name} (connect it to this site if it asks): it shows up here to add.` }
  }
</script>

<div class="flex items-baseline justify-between gap-3">
  <h1 class="font-serif text-2xl leading-tight tracking-tight">Onboard</h1>
  {#if onboard.config}<p class="text-muted-foreground text-xs tabular-nums">{onboard.config.destinations.length} destinations</p>{/if}
</div>
<p class="text-muted-foreground mt-1">Gather what you hold on every network into one stablecoin.</p>

{#if onboard.session}
  <div class="mt-4" in:fade={{ duration: ms(150) }}>
    <OnboardPlan plan={onboard.session.plan} target={onboard.session} session={onboard.session} />
  </div>
{:else if onboard.plan && onboard.target}
  <div class="mt-4" in:fade={{ duration: ms(150) }}>
    <OnboardPlan plan={onboard.plan} target={onboard.target} />
  </div>
{:else if onboard.config}
  <form
    class="mt-4"
    onsubmit={(event) => {
      event.preventDefault()
      review()
    }}
  >
    <div class="bg-card rounded-lg border p-3.5 shadow-xs">
      <div class="flex items-center justify-between gap-3">
        <span class="text-muted-foreground text-xs">Amount to move</span>
        {#if movable}
          <button
            type="button"
            class={['text-xs font-medium transition-[color,scale] active:scale-95', all ? 'text-foreground' : 'text-foreground/70 hover:text-foreground']}
            disabled={onboard.planning}
            onclick={takeAll}>All {usd(movable)}</button
          >
        {/if}
      </div>
      <div class="mt-1.5 flex items-center gap-3">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label class="flex items-baseline text-[26px] leading-none font-medium tracking-tight tabular-nums">
            <span class={amountText ? 'text-foreground' : 'text-muted-foreground/40'}>$</span>
            <input
              class="placeholder:text-muted-foreground/40 w-full min-w-0 bg-transparent outline-none"
              inputmode="decimal"
              autocomplete="off"
              placeholder="0"
              aria-label="Amount to move, in US dollars"
              value={shownAmount}
              oninput={setAmount}
              disabled={onboard.planning}
            />
          </label>
          <span class="text-muted-foreground flex h-4 items-center text-xs tabular-nums">
            {#if picked.size}
              {#key selected}<span class="settle truncate">{picked.size} token{picked.size === 1 ? '' : 's'} on {networks} network{networks === 1 ? '' : 's'}{!all && Number(amountText) > selected + 0.01 ? `, ${usd(selected)} in all` : ''}</span>{/key}
            {:else if list.length}
              <span class="text-muted-foreground/60">Stables go first, gas tokens last</span>
            {/if}
          </span>
        </div>
        <DestinationSelect destinations={onboard.config.destinations} chain={onboard.to} token={toToken} disabled={onboard.planning} onchange={pickDestination} />
      </div>
      <div class="text-muted-foreground mt-2 flex h-4 items-center gap-1.5 text-xs">
        {#if editingRecipient}
          <input
            bind:this={recipientInput}
            class={['min-w-0 flex-1 bg-transparent font-mono outline-none placeholder:font-sans', recipientText.trim() && !recipient ? 'text-destructive' : 'text-foreground']}
            placeholder="Recipient {toChain ? addressHint(toChain) : ''} address"
            aria-label="Recipient address"
            autocomplete="off"
            spellcheck="false"
            disabled={onboard.planning}
            bind:value={recipientText}
          />
          <button type="button" class="hover:text-foreground transition-colors" aria-label="Send to my wallet" onclick={resetRecipient}>
            <XIcon class="size-3.5" />
          </button>
        {:else}
          To
          {#if recipientValue}
            <span class="text-foreground/80 font-mono">{short(recipientValue)}</span>
          {:else}
            <button type="button" class="text-foreground/80 hover:text-foreground underline-offset-2 hover:underline" onclick={editRecipient}>
              add a {toChain?.name} address
            </button>
          {/if}
          <button type="button" class="hover:text-foreground p-0.5 transition-colors" aria-label="Change recipient" disabled={onboard.planning} onclick={editRecipient}>
            <PencilIcon class="size-3" />
          </button>
        {/if}
      </div>
    </div>

    <!-- The accounts whose holdings are read: each one connected adds its networks. -->
    <div class="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Wallets">
      {#each kinds as k (k.id)}
        {#each k.accounts as a (a.address)}
          <span class={['bg-muted/70 inline-flex h-7 items-center gap-1.5 rounded-md pl-1 text-xs', k.forget ? 'pr-1' : 'pr-2']} title="{a.info?.name ?? k.label}: {a.address}">
            {#if a.info?.icon}<img src={a.info.icon} alt="" class="size-5 rounded-sm" />{:else}<span class="bg-background flex size-5 items-center justify-center rounded-sm"><WalletIcon class="size-3" /></span>{/if}
            <span class="font-mono">{short(a.address)}</span>
            {#if k.forget}
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground hover:bg-background rounded-sm p-0.5 transition-colors"
                aria-label="Leave {short(a.address)} out"
                title="Leave this account out"
                disabled={onboard.planning}
                onclick={() => k.forget!(a.address)}
              >
                <XIcon class="size-3" />
              </button>
            {/if}
          </span>
        {/each}
        {#if k.offer || !k.accounts.length || k.forget}
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground hover:border-foreground/30 inline-flex h-7 items-center gap-1 rounded-md border border-dashed px-2 text-xs transition-[color,border-color,scale] active:scale-95"
            title={k.offer ? `Your wallet is on ${k.offer}: add it` : undefined}
            disabled={onboard.planning}
            onclick={() => (k.offer ? k.take?.() : addTo(k))}
          >
            <PlusIcon class="size-3" />
            {#if k.offer}<span class="font-mono">{short(k.offer)}</span>{:else if k.accounts.length}{k.label} account{:else}{k.id === 'evm' ? 'EVM wallet' : k.label}{/if}
          </button>
        {/if}
      {/each}
    </div>
    {#if hint && !kinds.find((k) => k.id === hint?.kind)?.offer}
      <p class="text-muted-foreground mt-1.5 px-0.5 text-[11px] leading-relaxed" transition:slide={{ duration: ms(150) }}>{hint.text}</p>
    {/if}

    <div class="mt-3">
      <OnboardHoldings {list} {picked} disabled={onboard.planning} ontoggle={toggle} />
    </div>

    {#if gasLine}
      <div class="bg-muted/60 mt-3 flex items-center gap-2 rounded-md px-3 py-2 text-xs" transition:slide={{ duration: ms(150) }}>
        <FuelIcon class="text-muted-foreground size-3.5 shrink-0" />
        <span class={['min-w-0 flex-1', gasLine.optional && !gas && 'text-muted-foreground line-through decoration-1']}>{gasLine.text}</span>
        {#if gasLine.optional}
          <button
            type="button"
            role="switch"
            aria-checked={gas}
            aria-label="Get gas there"
            class={['relative h-4 w-7 shrink-0 rounded-full transition-colors', gas ? 'bg-foreground' : 'bg-muted-foreground/30']}
            disabled={onboard.planning}
            onclick={() => (gas = !gas)}
          >
            <span class={['bg-background absolute top-0.5 left-0.5 size-3 rounded-full shadow-xs transition-transform', gas && 'translate-x-3']}></span>
          </button>
        {/if}
      </div>
    {/if}

    <Button type="submit" class="mt-4 h-11 w-full text-[13px] transition-[background-color,scale] active:scale-[0.99]" disabled={onboard.planning || (!!problem && problem !== 'Connect a wallet' && !askRecipient)}>
      {#if onboard.planning}<Spinner class="size-4" />Planning the route…{:else}{problem ?? `Review moving ${usd(selected)}`}{/if}
    </Button>
    {#if onboard.planning}
      <p class="text-muted-foreground mt-2.5 flex items-center justify-center gap-2 text-xs" transition:slide={{ duration: ms(150) }}>
        Asking the bridges for every leg, this takes a few seconds.
        <button type="button" class="text-foreground/80 hover:text-foreground underline-offset-2 hover:underline" onclick={cancelPlan}>Cancel</button>
      </p>
    {:else if onboard.planError || error}
      <p class="text-destructive mt-2.5 text-center text-xs" transition:slide={{ duration: ms(150) }}>{onboard.planError || error}</p>
    {:else if picked.size >= MAX_ITEMS}
      <p class="text-muted-foreground mt-2.5 flex items-start gap-1.5 px-1 text-xs leading-relaxed" transition:slide={{ duration: ms(150) }}>
        <InfoIcon class="mt-px size-3.5 shrink-0" />One run moves at most {MAX_ITEMS} holdings, so these are the largest. Another run can take the rest.
      </p>
    {:else if !anyWallet}
      <p class="text-muted-foreground mt-2.5 flex items-start gap-1.5 px-1 text-xs leading-relaxed">
        <InfoIcon class="mt-px size-3.5 shrink-0" />Connect your wallets to see what they hold on {onboard.config.scan.evm.length + 1}+ networks. Nothing moves until you confirm each step.
      </p>
    {/if}
  </form>
{:else if onboard.error}
  <div class="flex flex-col items-center gap-4 pt-16 text-center">
    <p class="text-muted-foreground">{onboard.error}</p>
    <Button variant="outline" size="sm" class="px-4" onclick={loadOnboard}>Try again</Button>
  </div>
{:else}
  <div class="flex justify-center pt-20"><Spinner class="text-muted-foreground size-5" /></div>
{/if}
