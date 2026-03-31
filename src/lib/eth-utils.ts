import { ETH_ADDRESS_REGEX } from '@/lib/wallet-constants';

/**
 * Attempt to load keccak256 from js-sha3.
 * Falls back to null if the package is not installed.
 */
let keccak256: ((message: string) => string) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sha3 = require('js-sha3');
  keccak256 = sha3.keccak256 as (message: string) => string;
} catch {
  // js-sha3 not available; EIP-55 checksum validation disabled
  keccak256 = null;
}

/**
 * Validates an Ethereum address string.
 *
 * - Must match the basic format: 0x followed by 40 hex characters.
 * - If the address uses mixed case AND keccak256 is available,
 *   performs EIP-55 checksum validation.
 *
 * @param address - The address to validate
 * @returns true if the address is valid
 */
export function isValidEthAddress(address: string): boolean {
  if (!ETH_ADDRESS_REGEX.test(address)) {
    return false;
  }

  const isAllLower = address === address.toLowerCase();
  const isAllUpper = address.slice(2) === address.slice(2).toUpperCase();

  // All-lowercase or all-uppercase (after 0x) passes without checksum
  if (isAllLower || isAllUpper) {
    return true;
  }

  // Mixed case requires EIP-55 checksum validation
  if (!keccak256) {
    // Without keccak256 we cannot verify the checksum; accept the address
    // since it matches the basic hex format
    return true;
  }

  const checksummed = toChecksumAddress(address);
  return address === checksummed;
}

/**
 * Converts an Ethereum address to its EIP-55 checksummed representation.
 *
 * If keccak256 is not available (js-sha3 not installed), returns the
 * address in lowercase form (0x + 40 lowercase hex chars).
 *
 * @param address - A valid 0x-prefixed Ethereum address
 * @returns The EIP-55 checksummed address
 * @throws Error if the address does not match the basic ETH address format
 */
export function toChecksumAddress(address: string): string {
  if (!ETH_ADDRESS_REGEX.test(address)) {
    throw new Error(`Invalid Ethereum address format: ${address}`);
  }

  const lower = address.slice(2).toLowerCase();

  if (!keccak256) {
    return `0x${lower}`;
  }

  const hash = keccak256(lower);
  let checksummed = '0x';

  for (let i = 0; i < 40; i++) {
    const hashNibble = parseInt(hash[i], 16);
    checksummed += hashNibble >= 8 ? lower[i].toUpperCase() : lower[i];
  }

  return checksummed;
}
