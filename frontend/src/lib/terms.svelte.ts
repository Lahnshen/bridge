// The terms each browser accepts once, before its first transfer or swap. A new version of them asks again.
const VERSION = '2026-11-04'
const KEY = 'terms-accepted'

export const terms = $state({ accepted: localStorage.getItem(KEY) === VERSION, asking: false })
let answer: ((ok: boolean) => void) | undefined

// Resolves to whether the user accepts them (right away when they already have).
export function acceptTerms(): Promise<boolean> {
  if (terms.accepted) return Promise.resolve(true)
  answer?.(false)
  terms.asking = true
  return new Promise((resolve) => (answer = resolve))
}

export function answerTerms(ok: boolean) {
  if (ok) {
    terms.accepted = true
    localStorage.setItem(KEY, VERSION)
  }
  terms.asking = false
  answer?.(ok)
  answer = undefined
}
