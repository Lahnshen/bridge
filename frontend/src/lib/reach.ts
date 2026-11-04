import type { Chain } from './api'

// The bridges that could take a transfer from one chain to another, before asking them: CCTP between two chains it
// reaches, and every other bridge that reaches both. From a Cosmos chain only Skip sends, and from Hyperliquid only Relay;
// the others send from EVM chains and Solana only. Whether one has a route for the tokens and amount, only its quote tells.
const ONLY: Partial<Record<Chain['kind'], string>> = { cosmos: 'skip', hypercore: 'relay' }

export function bridgesBetween(from: Chain, to: Chain) {
  if (from.id === to.id || !from.send) return []
  const others = from.via.filter((p) => to.via.includes(p) && (!ONLY[from.kind] || p === ONLY[from.kind]))
  return from.domain !== undefined && to.domain !== undefined ? ['cctp', ...others] : others
}

export const connected = (from: Chain, to: Chain) => bridgesBetween(from, to).length > 0
