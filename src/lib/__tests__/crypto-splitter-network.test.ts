/**
 * Network-selection fail-safe for the USDC rail (W-37).
 *
 * The bug: `cryptoNetwork()` returned Base MAINNET for ANY value of
 * `CRYPTO_NETWORK` other than the literal `base-sepolia` — including UNSET.
 * An instance that carried `SPLITTER_ADDRESS` + `CRYPTO_RELAYER_PRIVATE_KEY`
 * but no `CRYPTO_NETWORK` therefore built EIP-712 typed data against mainnet
 * USDC and relayed REAL money. Mainnet must be an explicit opt-in; anything
 * else resolves to the testnet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  cryptoNetwork,
  chainConfig,
  DEFAULT_CRYPTO_NETWORK,
} from '@/lib/crypto-splitter';

const MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_MAINNET_CHAIN_ID = 8453;
const BASE_SEPOLIA_CHAIN_ID = 84532;

const ORIGINAL = process.env.CRYPTO_NETWORK;

function setNetwork(value: string | undefined) {
  if (value === undefined) delete process.env.CRYPTO_NETWORK;
  else process.env.CRYPTO_NETWORK = value;
}

describe('cryptoNetwork() — mainnet is an explicit opt-in', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    setNetwork(ORIGINAL);
  });

  it('defaults to the TESTNET when CRYPTO_NETWORK is unset', () => {
    setNetwork(undefined);
    expect(cryptoNetwork()).toBe('base-sepolia');
    expect(DEFAULT_CRYPTO_NETWORK).toBe('base-sepolia');
  });

  it('defaults to the TESTNET when CRYPTO_NETWORK is empty or whitespace', () => {
    setNetwork('');
    expect(cryptoNetwork()).toBe('base-sepolia');
    setNetwork('   ');
    expect(cryptoNetwork()).toBe('base-sepolia');
  });

  it('defaults to the TESTNET for an unrecognized value (typo protection)', () => {
    setNetwork('base-goerli');
    expect(cryptoNetwork()).toBe('base-sepolia');
    setNetwork('ethereum');
    expect(cryptoNetwork()).toBe('base-sepolia');
  });

  it('selects MAINNET only on an explicit opt-in value', () => {
    setNetwork('base');
    expect(cryptoNetwork()).toBe('base');
    setNetwork('mainnet');
    expect(cryptoNetwork()).toBe('base');
    setNetwork('base-mainnet');
    expect(cryptoNetwork()).toBe('base');
  });

  it('is case/whitespace tolerant on the explicit values', () => {
    setNetwork(' Base ');
    expect(cryptoNetwork()).toBe('base');
    setNetwork(' BASE-SEPOLIA ');
    expect(cryptoNetwork()).toBe('base-sepolia');
  });

  it('selects the TESTNET on explicit testnet aliases', () => {
    for (const value of ['base-sepolia', 'sepolia', 'testnet']) {
      setNetwork(value);
      expect(cryptoNetwork()).toBe('base-sepolia');
    }
  });

  it('warns when it has to fall back (unset), naming the opt-in switch', () => {
    setNetwork('a-value-never-warned-about-before');
    cryptoNetwork();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('CRYPTO_NETWORK');
    expect(message).toContain('base-sepolia');
  });

  it('does not warn when the network was chosen explicitly', () => {
    setNetwork('base');
    cryptoNetwork();
    setNetwork('base-sepolia');
    cryptoNetwork();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns at most once per distinct value (no per-request log spam)', () => {
    setNetwork('another-never-seen-value');
    cryptoNetwork();
    cryptoNetwork();
    cryptoNetwork();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drives chainConfig(): unset resolves to the Sepolia chain + testnet USDC', () => {
    setNetwork(undefined);
    const cfg = chainConfig();
    expect(cfg.chain.id).toBe(BASE_SEPOLIA_CHAIN_ID);
    expect(cfg.usdc).toBe(SEPOLIA_USDC);
  });

  it('drives chainConfig(): explicit base resolves to mainnet chain + mainnet USDC', () => {
    setNetwork('base');
    const cfg = chainConfig();
    expect(cfg.chain.id).toBe(BASE_MAINNET_CHAIN_ID);
    expect(cfg.usdc).toBe(MAINNET_USDC);
  });
});
