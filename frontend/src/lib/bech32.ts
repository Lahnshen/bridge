// Bech32 (BIP-173), the address format of Cosmos chains: a prefix ("osmo", "inj") and, usually, 20 bytes.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: number[]) {
  let checksum = 1
  for (const value of values) {
    const top = checksum >> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    GENERATORS.forEach((g, i) => {
      if ((top >> i) & 1) checksum ^= g
    })
  }
  return checksum
}

const expand = (prefix: string) => [...[...prefix].map((c) => c.charCodeAt(0) >> 5), 0, ...[...prefix].map((c) => c.charCodeAt(0) & 31)]

// Regroups bits, e.g. bytes into 5-bit words. Without padding, leftover bits must be zero.
function regroup(data: ArrayLike<number>, from: number, to: number, pad: boolean) {
  let acc = 0
  let bits = 0
  const out: number[] = []
  const max = (1 << to) - 1
  for (const value of Array.from(data)) {
    acc = ((acc << from) | value) & ((1 << (from + to - 1)) - 1)
    bits += from
    while (bits >= to) out.push((acc >> (bits -= to)) & max)
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & max)
  } else if (bits >= from || (acc << (to - bits)) & max) return
  return out
}

export function bech32Decode(address: string): { prefix: string; bytes: Uint8Array } | undefined {
  if (address.length > 90 || (address !== address.toLowerCase() && address !== address.toUpperCase())) return
  const lower = address.toLowerCase()
  const at = lower.lastIndexOf('1')
  if (at < 1 || at + 7 > lower.length) return
  const prefix = lower.slice(0, at)
  const data = [...lower.slice(at + 1)].map((c) => CHARSET.indexOf(c))
  if (data.includes(-1) || polymod([...expand(prefix), ...data]) !== 1) return
  const bytes = regroup(data.slice(0, -6), 5, 8, false)
  return bytes && { prefix, bytes: Uint8Array.from(bytes) }
}

export function bech32Encode(prefix: string, bytes: Uint8Array) {
  const data = regroup(bytes, 8, 5, true)!
  const checksum = polymod([...expand(prefix), ...data, 0, 0, 0, 0, 0, 0]) ^ 1
  const words = [...data, ...Array.from({ length: 6 }, (_, i) => (checksum >> (5 * (5 - i))) & 31)]
  return `${prefix}1${words.map((w) => CHARSET[w]).join('')}`
}
