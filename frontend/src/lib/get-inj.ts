import { getSwapQuote, swap, type Hex, type SwapResult } from './api'
import { injective } from './app.svelte'
import { usdcString } from './evm'
import { signTypedData, switchChain, wallet } from './wallet.svelte'

// USDC on Injective to INJ for gas. The wallet only signs a message (an EIP-3009 authorization to move the USDC);
// the server's relayer sends the transactions, buys INJ on Injective's INJ/USDC market, and pays the gas.

const random32 = () => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}` as Hex

// Swaps `amount` (USDC base units) of the connected wallet's USDC on Injective, at a fresh quote.
export async function getInj(amount: bigint, progress: (label: string) => void): Promise<SwapResult> {
  const from = wallet.address
  if (!from) throw new Error('Connect a wallet first.')
  // Wallets only sign typed data for the chain they're on.
  progress('Switching to Injective…')
  await switchChain(injective())
  const fresh = await getSwapQuote(usdcString(amount))
  const message = { from, to: fresh.to, value: String(amount), validAfter: 0, validBefore: Math.floor(Date.now() / 1000) + 600, nonce: random32() }
  progress('Sign the swap in your wallet…')
  const signature = await signTypedData({
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'ReceiveWithAuthorization',
    domain: fresh.domain,
    message,
  })
  progress('Swapping…')
  return swap({ ...message, signature, minInj: fresh.minInj })
}
