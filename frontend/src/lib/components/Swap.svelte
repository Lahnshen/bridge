<script lang="ts">
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down'
  import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right'
  import CheckIcon from '@lucide/svelte/icons/check'
  import injectiveLogo from '../../assets/injective.svg'
  import usdcLogo from '../../assets/usdc.svg'
  import { Button } from '$lib/components/ui/button'
  import { Spinner } from '$lib/components/ui/spinner'
  import { getBalance, getSwapQuote, INJECTIVE, type SwapQuote, type SwapResult } from '$lib/api'
  import { app } from '$lib/app.svelte'
  import { formatUsdc, parseUsdc, usdcString } from '$lib/evm'
  import { getInj } from '$lib/get-inj'
  import { acceptTerms } from '$lib/terms.svelte'
  import { connectWallet, wallet, walletError } from '$lib/wallet.svelte'

  // USDC on Injective to INJ for gas, gas free (see get-inj.ts).

  const MIN = 1_100_000n // the market's minimum order is 1 USDC, plus room for its fee and slippage
  const PRESETS = ['2', '5', '20']

  let amountText = $state('')
  let busy = $state('')
  let error = $state('')
  let done = $state<SwapResult>()

  // Reloaded whenever the tab is opened, so USDC bridged in meanwhile shows up.
  let balance = $state<bigint>()
  let balanceAttempt = $state(0)
  let balanceOf: string | undefined
  $effect(() => {
    const address = wallet.address
    void balanceAttempt
    if (app.view !== 'swap') return
    if (address !== balanceOf) balance = undefined
    balanceOf = address
    if (!address) return
    let stale = false
    getBalance(INJECTIVE, address).then((result) => !stale && (balance = parseUsdc(result.balance)), () => {})
    return () => (stale = true)
  })

  const amount = $derived(parseUsdc(amountText))

  // Quotes follow the amount, after a pause in typing, and refresh while shown.
  let quote = $state<SwapQuote>()
  let quoteError = $state('')
  $effect(() => {
    const value = amount
    quote = undefined
    quoteError = ''
    if (!value || value < MIN) return
    let stale = false
    const load = () =>
      getSwapQuote(usdcString(value)).then(
        (result) => !stale && ((quote = result), (quoteError = '')),
        (err) => !stale && (quoteError = (err as Error).message),
      )
    const delay = setTimeout(load, 300)
    const refresh = setInterval(load, 15_000)
    return () => {
      stale = true
      clearTimeout(delay)
      clearInterval(refresh)
    }
  })

  const problem = $derived.by(() => {
    if (!amount) return 'Enter an amount'
    if (amount < MIN) return 'The minimum is 1.10 USDC'
    if (balance !== undefined && amount > balance) return 'Not enough USDC on Injective'
    if (quoteError) return 'No quote right now'
    if (!quote) return 'Getting a quote…'
  })

  function setAmount(event: Event & { currentTarget: HTMLInputElement }) {
    const value = event.currentTarget.value.replace(',', '.')
    if (/^\d*\.?\d{0,6}$/.test(value)) amountText = value
    else event.currentTarget.value = amountText
  }

  async function submit() {
    if (!wallet.address) return connectWallet()
    if (!(await acceptTerms())) return
    error = ''
    try {
      done = await getInj(amount!, (step) => (busy = step))
      amountText = ''
      balanceAttempt++
    } catch (err) {
      error = walletError(err) ?? ''
    } finally {
      busy = ''
    }
  }

  const inj = (value: string, digits = 4) => Number(value).toLocaleString('en-US', { maximumFractionDigits: digits })
</script>

<h1 class="font-serif text-[26px] leading-tight tracking-tight">Get INJ for gas</h1>
<p class="text-muted-foreground mt-1">Swap some USDC on Injective to INJ. You only sign, we pay the gas.</p>

{#if done}
  <div class="bg-card mt-6 rounded-lg border p-4 shadow-xs">
    <div class="flex items-center gap-3">
      <span class="bg-success/15 text-success flex size-8 items-center justify-center rounded-full"><CheckIcon class="size-4" strokeWidth={2.5} /></span>
      <div class="min-w-0 flex-1">
        <p class="text-[15px] font-semibold tracking-tight tabular-nums">{inj(done.inj)} INJ received</p>
        <p class="text-muted-foreground text-xs">
          In your Injective wallet{#if done.refund}, plus {formatUsdc(parseUsdc(done.refund) ?? 0n)} USDC that didn't fill, sent back{/if}.
        </p>
      </div>
    </div>
    <div class="mt-4 flex items-center justify-between gap-3 border-t pt-3 text-xs">
      {#if done.txUrl}
        <a class="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5" href={done.txUrl} target="_blank" rel="noreferrer">
          Injective tx<ArrowUpRightIcon class="size-3" />
        </a>
      {/if}
      <Button size="sm" variant="outline" class="ml-auto px-3.5" onclick={() => (done = undefined)}>Swap more</Button>
    </div>
  </div>
{:else}
  <form
    class="mt-6"
    onsubmit={(event) => {
      event.preventDefault()
      void submit()
    }}
  >
    <div class="bg-card rounded-lg border p-4 shadow-xs">
      <div class="flex items-center justify-between gap-3">
        <span class="text-muted-foreground text-xs">You pay</span>
        <div class="flex gap-1">
          {#each PRESETS as preset (preset)}
            <button
              type="button"
              class={['h-6 rounded-sm px-2 text-xs transition-colors', amountText === preset ? 'bg-foreground/10 text-foreground' : 'bg-muted/80 text-muted-foreground hover:text-foreground']}
              disabled={!!busy}
              onclick={() => (amountText = preset)}
            >
              ${preset}
            </button>
          {/each}
        </div>
      </div>
      <div class="mt-3 flex items-center gap-3">
        <input
          class="placeholder:text-muted-foreground/40 min-w-0 flex-1 bg-transparent text-[28px] leading-none font-medium tracking-tight tabular-nums outline-none"
          inputmode="decimal"
          autocomplete="off"
          placeholder="0"
          aria-label="USDC to swap"
          value={amountText}
          oninput={setAmount}
          disabled={!!busy}
        />
        <span class="flex shrink-0 items-center gap-1.5 font-medium"><img src={usdcLogo} alt="" class="size-5" /> USDC</span>
      </div>
      {#if wallet.address}
        <div class="text-muted-foreground mt-2.5 flex h-4 items-center gap-1.5 text-xs">
          On Injective <span class="tabular-nums">{balance === undefined ? '…' : formatUsdc(balance)}</span>
          {#if balance && balance >= MIN}
            <button type="button" class="text-foreground/80 hover:text-foreground font-medium" disabled={!!busy} onclick={() => (amountText = usdcString(balance!))}>Max</button>
          {/if}
        </div>
      {/if}
    </div>

    <div class="relative z-10 flex h-1 items-center justify-center">
      <span class="bg-card flex size-8 items-center justify-center rounded-md border shadow-xs"><ArrowDownIcon class="size-3.5" /></span>
    </div>

    <div class="bg-card rounded-lg border p-4 shadow-xs">
      <span class="text-muted-foreground text-xs">You get</span>
      <div class="mt-3 flex items-center gap-3">
        <span class={['min-w-0 flex-1 truncate text-[28px] leading-none font-medium tracking-tight tabular-nums', !quote && 'text-muted-foreground/40']}>
          {quote ? inj(quote.inj) : '0'}
        </span>
        <span class="flex shrink-0 items-center gap-1.5 font-medium">
          <span class="flex size-5 items-center justify-center rounded-full bg-[#0c0c10] ring-1 ring-white/15"><img src={injectiveLogo} alt="" class="size-3" /></span>
          INJ
        </span>
      </div>
      <div class="text-muted-foreground mt-2.5 h-4 text-xs">On Injective, to {wallet.address ? 'your wallet' : 'the connected wallet'}</div>
    </div>

    <div class="mt-4 flex flex-col gap-2.5 px-1 text-xs">
      <div class="flex items-center justify-between gap-3">
        <span class="text-muted-foreground">Rate</span>
        <span class="tabular-nums">{quote ? `1 INJ ≈ ${Number(quote.price).toLocaleString('en-US', { maximumFractionDigits: 3 })} USDC` : '—'}</span>
      </div>
      <div class="flex items-center justify-between gap-3">
        <span class="text-muted-foreground">Minimum received</span>
        <span class="tabular-nums">{quote ? `${inj(quote.minInj)} INJ` : '—'}</span>
      </div>
      <div class="flex items-center justify-between gap-3">
        <span class="text-muted-foreground">Gas</span>
        <span>Free</span>
      </div>
    </div>

    <Button type="submit" class="mt-5 h-11 w-full text-[13px]" disabled={!!busy || !app.config?.autoRedeem || (!!wallet.address && !!problem)}>
      {#if busy}<Spinner class="size-4" />{busy}{:else if !wallet.address}Connect wallet{:else}{problem ?? 'Swap to INJ'}{/if}
    </Button>
    {#if error}
      <p class="text-destructive mt-3 text-center text-xs">{error}</p>
    {:else if quoteError && amount && amount >= MIN}
      <p class="text-muted-foreground mt-3 text-center text-xs">{quoteError}</p>
    {/if}
  </form>
{/if}
