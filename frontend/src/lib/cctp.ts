import { INJECTIVE, type EvmChain, type Fees, type Hex } from './api'
import { app } from './app.svelte'
import { encode, parseUsdc, type Burn } from './evm'
import { call, sendTx, switchChain, waitForReceipt, wallet } from './wallet.svelte'

// Circle CCTP from the connected EVM wallet: what Circle takes from a burn, and the burn itself.

// The chain's own TokenMessengerV2 and MessageTransmitterV2. They're the same addresses on most chains, not on all (EDGE
// has its own, and the usual ones have no code there, so a call to them does nothing and still succeeds).
export const tokenMessengerOf = (chain: EvmChain): Hex => chain.tokenMessenger ?? app.config!.tokenMessenger
export const messageTransmitterOf = (chain: EvmChain): Hex => chain.messageTransmitter ?? app.config!.messageTransmitter

// fast and forward: whether the burn asks for a Fast Transfer, and for Circle to deliver it (both need their fee in `fees`).
// Fast fees are charged at attestation time, so they get headroom in case the rate moves, except when forwarding:
// then Circle keeps the whole maxFee. fee is what the recipient goes without.
export function cctpFees(amount: bigint, fees: Fees | undefined, fast: boolean, forward: boolean) {
  const fastFee = fast && amount ? (amount * BigInt(Math.round(fees!.fastBps! * 1000)) + 9_999_999n) / 10_000_000n : 0n
  const forwardFee = forward ? (parseUsdc(fees!.forwardFee!) ?? 0n) : 0n
  const maxFee = forward ? fastFee + forwardFee : fast ? (fastFee * 3n) / 2n + 1n : 0n
  return { forwardFee, maxFee, fee: forward ? maxFee : fastFee }
}

// The burn as a call to the chain's TokenMessengerV2. hookData asks Circle's Forwarding Service to deliver it.
export const burnCall = (from: EvmChain, burn: Burn, hookData?: Hex) => ({
  to: tokenMessengerOf(from),
  data: hookData ? encode.depositForBurnWithHook(burn, hookData) : encode.depositForBurn(burn),
})

// Burns on an EVM chain, an exact approval first when the allowance is short, and returns the tx hash once it's sent.
export async function burnOnEvm(from: EvmChain & { usdc: Hex }, burn: Burn, hookData: Hex | undefined, progress: (label: string) => void) {
  const tokenMessenger = tokenMessengerOf(from)
  const padGas = from.domain === INJECTIVE
  progress(`Switching to ${from.name}…`)
  await switchChain(from)
  const allowance = BigInt(await call(from.usdc, encode.allowance(wallet.address!, tokenMessenger)))
  if (allowance < burn.amount) {
    progress('Approve USDC in your wallet…')
    const approval = await sendTx(from, { to: from.usdc, data: encode.approve(tokenMessenger, burn.amount) }, { padGas })
    progress('Approving…')
    if (!(await waitForReceipt(approval, from))) throw new Error('The approval failed.')
  }
  progress('Confirm the transfer in your wallet…')
  return sendTx(from, burnCall(from, burn, hookData), { padGas })
}
