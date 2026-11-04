<script lang="ts">
  import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert'
  import { Button } from '$lib/components/ui/button'
  import { answerTerms, terms } from '$lib/terms.svelte'

  // Asked once, before the first transfer or swap: the gist of the terms, and agreeing to them.
  let dialog = $state<HTMLDialogElement>()
  let agreed = $state(false)

  $effect(() => {
    if (!dialog) return
    if (terms.asking && !dialog.open) {
      agreed = false
      dialog.showModal()
    } else if (!terms.asking && dialog.open) dialog.close()
  })
</script>

<dialog
  bind:this={dialog}
  class="bg-popover text-popover-foreground m-auto w-[min(100%-2rem,26rem)] rounded-lg border p-0 shadow-2xl"
  aria-labelledby="terms-title"
  onclose={() => terms.asking && answerTerms(false)}
>
  <div class="p-4">
    <h2 id="terms-title" class="flex items-center gap-2 text-sm font-semibold tracking-tight">
      <ShieldAlertIcon class="text-muted-foreground size-4" /> Before you send
    </h2>
    <ul class="text-muted-foreground mt-3 flex list-disc flex-col gap-1.5 pl-4 text-xs leading-relaxed">
      <li>Lahn Bridge is free software provided <span class="text-foreground">as is</span>, with no warranty of any kind.</li>
      <li>It never holds your funds. You sign every transaction yourself, and third-party bridges carry it out.</li>
      <li>
        Transactions can't be undone, and bridges can fail, stall or be exploited. A compromised site could show you a malicious transaction: <span
          class="text-foreground">check everything in your wallet before you sign.</span
        >
      </li>
      <li>Lahn is not liable for any loss, and the bridges are independent, under their own terms. You use it entirely at your own risk.</li>
    </ul>
    <label class="mt-4 flex cursor-pointer items-start gap-2 text-xs">
      <input type="checkbox" class="accent-foreground mt-0.5" bind:checked={agreed} />
      <span>I have read and accept the <a href="/terms" target="_blank" class="underline underline-offset-2">Terms of Use</a>.</span>
    </label>
  </div>
  <div class="flex justify-end gap-2 border-t px-4 py-3">
    <Button variant="ghost" size="sm" class="px-3" onclick={() => answerTerms(false)}>Cancel</Button>
    <Button size="sm" class="px-3" disabled={!agreed} onclick={() => answerTerms(true)}>Accept and continue</Button>
  </div>
</dialog>
