<script lang="ts">
  import WalletIcon from '@lucide/svelte/icons/wallet'
  import XIcon from '@lucide/svelte/icons/x'
  import { Spinner } from '$lib/components/ui/spinner'
  import { connect, wallet, walletError } from '$lib/wallet.svelte'

  let dialog = $state<HTMLDialogElement>()
  let connecting = $state('')
  let error = $state('')

  $effect(() => {
    if (!dialog) return
    if (wallet.picking && !dialog.open) {
      error = ''
      dialog.showModal()
    } else if (!wallet.picking && dialog.open) dialog.close()
  })

  async function pick(id: string) {
    connecting = id
    error = ''
    try {
      await connect(id)
    } catch (err) {
      error = walletError(err) ?? ''
    } finally {
      connecting = ''
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="bg-popover text-popover-foreground backdrop:bg-black/50 m-auto w-[min(100%-2rem,22rem)] rounded-lg border p-0 shadow-2xl backdrop:backdrop-blur-[2px]"
  aria-labelledby="wallet-title"
  onclose={() => (wallet.picking = false)}
  onclick={(event) => event.target === dialog && dialog?.close()}
>
  <div class="flex items-center justify-between px-4 pt-4 pb-3">
    <h2 id="wallet-title" class="text-sm font-semibold tracking-tight">Connect a wallet</h2>
    <button class="text-muted-foreground hover:text-foreground -mr-1 rounded-md p-1" aria-label="Close" onclick={() => dialog?.close()}>
      <XIcon class="size-4" />
    </button>
  </div>
  <div class="flex flex-col gap-1 px-2 pb-2">
    {#each wallet.available as option (option.id)}
      <button
        class="hover:bg-muted flex h-11 items-center gap-3 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors disabled:opacity-60"
        disabled={!!connecting}
        onclick={() => pick(option.id)}
      >
        {#if option.icon}
          <img src={option.icon} alt="" class="size-7 rounded-md" />
        {:else}
          <span class="bg-muted flex size-7 items-center justify-center rounded-md"><WalletIcon class="size-4" /></span>
        {/if}
        <span class="flex-1">{option.name}</span>
        {#if connecting === option.id}<Spinner class="text-muted-foreground size-4" />{/if}
      </button>
    {:else}
      <p class="text-muted-foreground px-2.5 pb-3 text-xs leading-relaxed">
        No wallet found. Install a browser wallet like MetaMask or Rabby, then reload this page.
      </p>
    {/each}
    {#if error}
      <p class="text-destructive px-2.5 pt-1 pb-2 text-xs">{error}</p>
    {/if}
  </div>
</dialog>
