// Transition lengths for Svelte's transitions, zero where the system asks for less motion (CSS ones follow app.css).
const reduce = matchMedia('(prefers-reduced-motion: reduce)')
export const ms = (value: number) => (reduce.matches ? 0 : value)
