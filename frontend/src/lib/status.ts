import type { Recent } from './transfers.svelte'

export type Status = Recent['status']

export const STATUS_LABEL: Record<Status, string> = {
  confirming: 'Confirming',
  pending: 'In transit',
  ready: 'Ready',
  redeemed: 'Complete',
  restricted: 'Restricted',
  failed: 'Failed',
}

export const STATUS_DOT: Record<Status, string> = {
  confirming: 'bg-warning animate-pulse',
  pending: 'bg-warning animate-pulse',
  ready: 'bg-sky-500',
  redeemed: 'bg-success',
  restricted: 'bg-destructive',
  failed: 'bg-destructive',
}
