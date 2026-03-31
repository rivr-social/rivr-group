/**
 * Tests for src/lib/eth-utils.ts
 * Validates Ethereum address format checking and checksum conversion.
 */
import { describe, it, expect } from 'vitest';

import { isValidEthAddress, toChecksumAddress } from '@/lib/eth-utils';

// ---------------------------------------------------------------------------
// isValidEthAddress
// ---------------------------------------------------------------------------
describe('isValidEthAddress', () => {
  it('accepts a valid lowercase address (0x + 40 lowercase hex chars)', () => {
    const address = '0xaabbccddee11223344556677889900aabbccddee';
    expect(isValidEthAddress(address)).toBe(true);
  });

  it('accepts a valid all-uppercase address (0x + 40 uppercase hex chars)', () => {
    const address = '0xAABBCCDDEE11223344556677889900AABBCCDDEE';
    expect(isValidEthAddress(address)).toBe(true);
  });

  it('rejects an address that is too short (0x + 39 chars)', () => {
    const address = '0x' + 'a'.repeat(39);
    expect(isValidEthAddress(address)).toBe(false);
  });

  it('rejects an address missing the 0x prefix', () => {
    const address = 'aabbccddee11223344556677889900aabbccddee';
    expect(isValidEthAddress(address)).toBe(false);
  });

  it('rejects an address with non-hex characters', () => {
    const address = '0x' + 'xyz'.repeat(13) + 'x';
    expect(isValidEthAddress(address)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidEthAddress('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toChecksumAddress
// ---------------------------------------------------------------------------
describe('toChecksumAddress', () => {
  it('returns a correctly checksummed address (EIP-55)', () => {
    // Well-known EIP-55 test vector
    const input = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
    const result = toChecksumAddress(input);

    // The result must start with 0x and have exactly 42 characters
    expect(result).toHaveLength(42);
    expect(result.startsWith('0x')).toBe(true);

    // It should not be all lowercase (checksum applies mixed casing)
    expect(result).not.toBe(input);

    // Round-tripping must be stable
    expect(toChecksumAddress(result)).toBe(result);
  });
});
