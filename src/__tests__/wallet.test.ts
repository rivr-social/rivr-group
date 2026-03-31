/**
 * Tests for the core wallet service (src/lib/wallet.ts).
 * Validates wallet creation, deposits, transfers, purchases, ETH address
 * management, and ETH payment recording with mocked DB + Stripe layers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — available in vi.mock factories (hoisted above imports)
// ---------------------------------------------------------------------------
const {
  // Top-level db mocks (for non-transactional functions)
  mockDbReturning,
  mockDbSetWhere,
  mockDbSet,
  mockDbUpdateTable,
  mockDbInsertReturning,
  mockDbInsertValues,
  mockDbInsertTable,
  mockDbSelectLimit,
  mockDbSelectWhere,
  mockDbSelectInnerJoin,
  mockDbSelectFrom,
  mockDbSelect,
  // Transaction-level mocks
  mockTxExecute,
  mockTxReturning,
  mockTxSetWhere,
  mockTxSet,
  mockTxUpdateTable,
  mockTxInsertReturning,
  mockTxInsertValues,
  mockTxInsertTable,
  mockTxSelectLimit,
  mockTxSelectWhere,
  mockTxSelectFrom,
  mockTxSelect,
  mockTransaction,
  // External mocks
  mockPaymentIntentsCreate,
  mockGetOrCreateStripeCustomer,
  mockIsValidEthAddress,
} = vi.hoisted(() => {
  // --- Top-level db chains ---
  const _mockDbReturning = vi.fn();
  const _mockDbSetWhere = vi.fn(() => ({ returning: _mockDbReturning }));
  const _mockDbSet = vi.fn(() => ({ where: _mockDbSetWhere }));
  const _mockDbUpdateTable = vi.fn(() => ({ set: _mockDbSet }));

  const _mockDbInsertReturning = vi.fn();
  const _mockDbInsertOnConflict = vi.fn(() => ({ returning: _mockDbInsertReturning }));
  const _mockDbInsertValues = vi.fn(() => ({ returning: _mockDbInsertReturning, onConflictDoNothing: _mockDbInsertOnConflict }));
  const _mockDbInsertTable = vi.fn(() => ({ values: _mockDbInsertValues }));

  const _mockDbSelectLimit = vi.fn();
  const _mockDbSelectWhere = vi.fn(() => ({ limit: _mockDbSelectLimit }));
  const _mockDbSelectInnerJoin = vi.fn(() => ({ where: _mockDbSelectWhere }));
  const _mockDbSelectFrom = vi.fn(() => ({
    where: _mockDbSelectWhere,
    innerJoin: _mockDbSelectInnerJoin,
  }));
  const _mockDbSelect = vi.fn(() => ({ from: _mockDbSelectFrom }));

  // --- Transaction-level chains ---
  const _mockTxExecute = vi.fn();
  const _mockTxReturning = vi.fn();
  const _mockTxSetWhere = vi.fn(() => ({ returning: _mockTxReturning }));
  const _mockTxSet = vi.fn(() => ({ where: _mockTxSetWhere }));
  const _mockTxUpdateTable = vi.fn(() => ({ set: _mockTxSet }));

  const _mockTxInsertReturning = vi.fn();
  const _mockTxInsertOnConflict = vi.fn(() => ({ returning: _mockTxInsertReturning }));
  const _mockTxInsertValues = vi.fn(() => ({ returning: _mockTxInsertReturning, onConflictDoNothing: _mockTxInsertOnConflict }));
  const _mockTxInsertTable = vi.fn(() => ({ values: _mockTxInsertValues }));

  const _mockTxSelectLimit = vi.fn();
  const _mockTxSelectOrderBy = vi.fn(() => ({ limit: _mockTxSelectLimit, then: (fn: (v: unknown) => unknown) => Promise.resolve([]).then(fn) }));
  const _mockTxSelectWhere = vi.fn(() => ({ limit: _mockTxSelectLimit, orderBy: _mockTxSelectOrderBy, then: (fn: (v: unknown) => unknown) => Promise.resolve([]).then(fn) }));
  const _mockTxSelectFrom = vi.fn(() => ({ where: _mockTxSelectWhere }));
  const _mockTxSelect = vi.fn(() => ({ from: _mockTxSelectFrom }));

  const _mockTx = {
    execute: _mockTxExecute,
    select: (...args: unknown[]) => _mockTxSelect(...args),
    update: (...args: unknown[]) => _mockTxUpdateTable(...args),
    insert: (...args: unknown[]) => _mockTxInsertTable(...args),
  };
  const _mockTransaction = vi.fn(async (fn: (tx: typeof _mockTx) => Promise<unknown>) => fn(_mockTx));

  return {
    mockDbReturning: _mockDbReturning,
    mockDbSetWhere: _mockDbSetWhere,
    mockDbSet: _mockDbSet,
    mockDbUpdateTable: _mockDbUpdateTable,
    mockDbInsertReturning: _mockDbInsertReturning,
    mockDbInsertValues: _mockDbInsertValues,
    mockDbInsertTable: _mockDbInsertTable,
    mockDbSelectLimit: _mockDbSelectLimit,
    mockDbSelectWhere: _mockDbSelectWhere,
    mockDbSelectInnerJoin: _mockDbSelectInnerJoin,
    mockDbSelectFrom: _mockDbSelectFrom,
    mockDbSelect: _mockDbSelect,
    mockTxExecute: _mockTxExecute,
    mockTxReturning: _mockTxReturning,
    mockTxSetWhere: _mockTxSetWhere,
    mockTxSet: _mockTxSet,
    mockTxUpdateTable: _mockTxUpdateTable,
    mockTxInsertReturning: _mockTxInsertReturning,
    mockTxInsertValues: _mockTxInsertValues,
    mockTxInsertTable: _mockTxInsertTable,
    mockTxSelectLimit: _mockTxSelectLimit,
    mockTxSelectWhere: _mockTxSelectWhere,
    mockTxSelectFrom: _mockTxSelectFrom,
    mockTxSelect: _mockTxSelect,
    mockTransaction: _mockTransaction,
    mockPaymentIntentsCreate: vi.fn(),
    mockGetOrCreateStripeCustomer: vi.fn(),
    mockIsValidEthAddress: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsertTable(...args),
    update: (...args: unknown[]) => mockDbUpdateTable(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

vi.mock('@/db/schema', () => ({
  wallets: {
    id: 'wallets.id',
    ownerId: 'wallets.ownerId',
    type: 'wallets.type',
    balanceCents: 'wallets.balanceCents',
    currency: 'wallets.currency',
    ethAddress: 'wallets.ethAddress',
    stripeCustomerId: 'wallets.stripeCustomerId',
    isFrozen: 'wallets.isFrozen',
    metadata: 'wallets.metadata',
    createdAt: 'wallets.createdAt',
    updatedAt: 'wallets.updatedAt',
  },
  walletTransactions: {
    id: 'walletTransactions.id',
    type: 'walletTransactions.type',
    fromWalletId: 'walletTransactions.fromWalletId',
    toWalletId: 'walletTransactions.toWalletId',
    amountCents: 'walletTransactions.amountCents',
    feeCents: 'walletTransactions.feeCents',
    currency: 'walletTransactions.currency',
    description: 'walletTransactions.description',
    stripePaymentIntentId: 'walletTransactions.stripePaymentIntentId',
    ethTxHash: 'walletTransactions.ethTxHash',
    referenceType: 'walletTransactions.referenceType',
    referenceId: 'walletTransactions.referenceId',
    ledgerEntryId: 'walletTransactions.ledgerEntryId',
    status: 'walletTransactions.status',
    metadata: 'walletTransactions.metadata',
    createdAt: 'walletTransactions.createdAt',
  },
  agents: {
    id: 'agents.id',
    name: 'agents.name',
    email: 'agents.email',
    type: 'agents.type',
    deletedAt: 'agents.deletedAt',
    passwordHash: 'agents.passwordHash',
    emailVerified: 'agents.emailVerified',
  },
  capitalEntries: {
    id: 'capitalEntries.id',
    walletId: 'capitalEntries.walletId',
    amountCents: 'capitalEntries.amountCents',
    remainingCents: 'capitalEntries.remainingCents',
    settlementStatus: 'capitalEntries.settlementStatus',
    availableOn: 'capitalEntries.availableOn',
    sourceType: 'capitalEntries.sourceType',
    sourceEntryId: 'capitalEntries.sourceEntryId',
    sourceTransactionId: 'capitalEntries.sourceTransactionId',
    metadata: 'capitalEntries.metadata',
    createdAt: 'capitalEntries.createdAt',
    updatedAt: 'capitalEntries.updatedAt',
  },
  ledger: {
    id: 'ledger.id',
    verb: 'ledger.verb',
    subjectId: 'ledger.subjectId',
    objectId: 'ledger.objectId',
    objectType: 'ledger.objectType',
    metadata: 'ledger.metadata',
    isActive: 'ledger.isActive',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ _op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ _op: 'and', args })),
  or: vi.fn((...args: unknown[]) => ({ _op: 'or', args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    _op: 'sql',
    strings,
    values,
  })),
  isNull: vi.fn((...args: unknown[]) => ({ _op: 'isNull', args })),
  count: vi.fn(() => 'count'),
}));

vi.mock('@/lib/billing', () => ({
  getStripe: () => ({
    paymentIntents: { create: mockPaymentIntentsCreate },
  }),
  getOrCreateStripeCustomer: (...args: unknown[]) => mockGetOrCreateStripeCustomer(...args),
}));

vi.mock('@/lib/integrations/stripe', () => ({
  toDollars: (cents: number) => cents / 100,
}));

vi.mock('@/lib/eth-utils', () => ({
  isValidEthAddress: (...args: unknown[]) => mockIsValidEthAddress(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER all mocks
// ---------------------------------------------------------------------------
import {
  getOrCreateWallet,
  getWalletBalance,
  createDepositIntent,
  confirmDeposit,
  transferP2P,
  purchaseFromWallet,
  setEthAddress,
  recordEthPayment,
} from '@/lib/wallet';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const AGENT_ID = 'agent-uuid-1';
const AGENT_ID_2 = 'agent-uuid-2';
const WALLET_ID = 'wallet-uuid-1';
const WALLET_ID_2 = 'wallet-uuid-2';
const WALLET_ID_3 = 'wallet-uuid-3';

const EXISTING_WALLET = {
  id: WALLET_ID,
  ownerId: AGENT_ID,
  type: 'personal',
  balanceCents: 5000,
  currency: 'usd',
  ethAddress: null,
  stripeCustomerId: 'cus_existing',
  isFrozen: false,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FROZEN_WALLET = {
  ...EXISTING_WALLET,
  isFrozen: true,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();

  // Re-establish chain implementations after clearAllMocks
  // (clearAllMocks preserves implementations, but mockResolvedValue overrides them)
  mockDbSelectFrom.mockImplementation(() => ({
    where: mockDbSelectWhere,
    innerJoin: mockDbSelectInnerJoin,
  }));
  mockDbSelectWhere.mockImplementation(() => ({ limit: mockDbSelectLimit }));
  mockDbSelectInnerJoin.mockImplementation(() => ({ where: mockDbSelectWhere }));
  mockDbSet.mockImplementation(() => ({ where: mockDbSetWhere }));
  mockDbSetWhere.mockImplementation(() => ({ returning: mockDbReturning }));
  mockDbInsertValues.mockImplementation(() => ({ returning: mockDbInsertReturning }));
  mockTxSelectFrom.mockImplementation(() => ({ where: mockTxSelectWhere }));
  mockTxSelectWhere.mockImplementation(() => ({ limit: mockTxSelectLimit }));
  mockTxSet.mockImplementation(() => ({ where: mockTxSetWhere }));
  mockTxSetWhere.mockImplementation(() => ({ returning: mockTxReturning }));
  mockTxInsertValues.mockImplementation(() => ({ returning: mockTxInsertReturning }));

  // Default: top-level select returns empty
  mockDbSelectLimit.mockResolvedValue([]);

  // Default: top-level insert returns row
  mockDbInsertReturning.mockResolvedValue([{ id: WALLET_ID }]);

  // Default: top-level update returns row
  mockDbReturning.mockResolvedValue([{ id: WALLET_ID }]);

  // Default: tx select returns empty
  mockTxSelectLimit.mockResolvedValue([]);

  // Default: tx execute resolves
  mockTxExecute.mockResolvedValue(undefined);

  // Default: tx insert returns row
  mockTxInsertReturning.mockResolvedValue([{ id: WALLET_ID }]);

  // Default: tx update returns row
  mockTxReturning.mockResolvedValue([{ id: WALLET_ID }]);

  // Default: stripe customer
  mockGetOrCreateStripeCustomer.mockResolvedValue('cus_new');

  // Default: ETH utils
  mockIsValidEthAddress.mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// getOrCreateWallet (uses top-level db.select + db.insert, NOT transaction)
// ---------------------------------------------------------------------------
describe('getOrCreateWallet', () => {
  it('returns existing wallet when found', async () => {
    // db.select().from().where().limit() returns existing wallet
    mockDbSelectLimit.mockResolvedValueOnce([EXISTING_WALLET]);

    const result = await getOrCreateWallet(AGENT_ID, 'personal');

    expect(result).toEqual(EXISTING_WALLET);
    // Should NOT have called insert
    expect(mockDbInsertTable).not.toHaveBeenCalled();
  });

  it('creates new personal wallet with Stripe customer', async () => {
    // First select returns empty (no existing)
    mockDbSelectLimit.mockResolvedValueOnce([]);
    // Insert returns new wallet
    mockDbInsertReturning.mockResolvedValueOnce([{ ...EXISTING_WALLET, id: 'new-wallet-id' }]);

    const result = await getOrCreateWallet(AGENT_ID, 'personal');

    expect(mockGetOrCreateStripeCustomer).toHaveBeenCalledWith(AGENT_ID);
    expect(mockDbInsertTable).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('creates new group wallet without Stripe customer', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([]);
    const groupWallet = {
      ...EXISTING_WALLET,
      id: 'group-wallet-id',
      type: 'group',
      stripeCustomerId: null,
    };
    mockDbInsertReturning.mockResolvedValueOnce([groupWallet]);

    const result = await getOrCreateWallet('group-id', 'group');

    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled();
    expect(result.type).toBe('group');
  });
});

// ---------------------------------------------------------------------------
// getWalletBalance (uses db.select with innerJoin)
// ---------------------------------------------------------------------------
describe('getWalletBalance', () => {
  it('returns formatted balance with owner name', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([
      {
        walletId: WALLET_ID,
        ownerId: AGENT_ID,
        ownerName: 'Test User',
        type: 'personal',
        balanceCents: 5000,
        currency: 'usd',
        ethAddress: null,
        isFrozen: false,
      },
    ]);

    const result = await getWalletBalance(WALLET_ID);

    expect(result.walletId).toBe(WALLET_ID);
    expect(result.balanceCents).toBe(5000);
    expect(result.balanceDollars).toBe(50);
    expect(result.ownerName).toBe('Test User');
  });

  it('throws when wallet not found', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([]);

    await expect(getWalletBalance('nonexistent')).rejects.toThrow('Wallet not found');
  });
});

// ---------------------------------------------------------------------------
// createDepositIntent (uses top-level db.select + stripe + db.insert)
// ---------------------------------------------------------------------------
describe('createDepositIntent', () => {
  it('creates PaymentIntent and returns clientSecret', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([EXISTING_WALLET]);
    mockPaymentIntentsCreate.mockResolvedValueOnce({
      id: 'pi_test',
      client_secret: 'pi_test_secret',
    });

    const result = await createDepositIntent(WALLET_ID, 1000);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1000,
        currency: 'usd',
      }),
    );
    expect(result.clientSecret).toBe('pi_test_secret');
    expect(result.paymentIntentId).toBe('pi_test');
  });

  it('rejects amount below minimum', async () => {
    await expect(createDepositIntent(WALLET_ID, 50)).rejects.toThrow();
  });

  it('rejects amount above maximum', async () => {
    await expect(createDepositIntent(WALLET_ID, 200_000)).rejects.toThrow();
  });

  it('rejects frozen wallet', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([FROZEN_WALLET]);

    await expect(createDepositIntent(WALLET_ID, 1000)).rejects.toThrow('frozen');
  });
});

// ---------------------------------------------------------------------------
// confirmDeposit (uses db.transaction)
// ---------------------------------------------------------------------------
describe('confirmDeposit', () => {
  it('credits wallet, updates transaction, creates ledger entry', async () => {
    const pendingTx = {
      id: 'tx-pending',
      toWalletId: WALLET_ID,
      amountCents: 1000,
      status: 'pending',
      stripePaymentIntentId: 'pi_confirmed',
    };

    mockTxSelectLimit
      .mockResolvedValueOnce([pendingTx]) // find pending transaction
      .mockResolvedValueOnce([{ ownerId: AGENT_ID }]); // find wallet owner

    mockTxInsertReturning.mockResolvedValueOnce([{ id: 'ledger-entry-id' }]);
    mockTxReturning.mockResolvedValueOnce([{ ...pendingTx, status: 'completed' }]);

    const result = await confirmDeposit('pi_confirmed');

    expect(result).toBeDefined();
    expect(mockTxUpdateTable).toHaveBeenCalled();
    expect(mockTxInsertTable).toHaveBeenCalled();
  });

  it('returns null for already-completed transaction (idempotent)', async () => {
    mockTxSelectLimit.mockResolvedValueOnce([{
      id: 'tx-done',
      toWalletId: WALLET_ID,
      amountCents: 1000,
      status: 'completed',
    }]);

    const result = await confirmDeposit('pi_already_done');

    expect(result).toBeNull();
  });

  it('returns null when no matching transaction found', async () => {
    mockTxSelectLimit.mockResolvedValueOnce([]);

    const result = await confirmDeposit('pi_nonexistent');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// transferP2P (uses db.transaction)
// ---------------------------------------------------------------------------
describe('transferP2P', () => {
  it('debits sender, credits receiver, creates transaction + ledger', async () => {
    const senderWallet = { ...EXISTING_WALLET, id: WALLET_ID, balanceCents: 5000 };

    // After locking, read sender wallet
    mockTxSelectLimit.mockResolvedValueOnce([senderWallet]);

    // Ledger insert + transaction insert
    mockTxInsertReturning
      .mockResolvedValueOnce([{ id: 'ledger-entry' }])
      .mockResolvedValueOnce([{ id: 'tx-transfer' }]);

    const result = await transferP2P(WALLET_ID, WALLET_ID_2, 1000, 'Payment');

    expect(mockTxExecute).toHaveBeenCalled(); // FOR UPDATE locks
    expect(mockTxUpdateTable).toHaveBeenCalled(); // debit + credit
    expect(result).toBeDefined();
  });

  it('rejects insufficient balance', async () => {
    const poorWallet = { ...EXISTING_WALLET, balanceCents: 50 };
    mockTxSelectLimit.mockResolvedValueOnce([poorWallet]);

    await expect(
      transferP2P(WALLET_ID, WALLET_ID_2, 1000, 'Too much'),
    ).rejects.toThrow('Insufficient balance');
  });

  it('rejects frozen wallet', async () => {
    mockTxSelectLimit.mockResolvedValueOnce([FROZEN_WALLET]);

    await expect(
      transferP2P(WALLET_ID, WALLET_ID_2, 100, 'Frozen'),
    ).rejects.toThrow('frozen');
  });

  it('rejects same wallet (self-transfer)', async () => {
    await expect(
      transferP2P(WALLET_ID, WALLET_ID, 100, 'Self'),
    ).rejects.toThrow('same wallet');
  });

  it('rejects amount below minimum', async () => {
    await expect(
      transferP2P(WALLET_ID, WALLET_ID_2, 0, 'Zero'),
    ).rejects.toThrow();
  });

  it('rejects amount above maximum', async () => {
    await expect(
      transferP2P(WALLET_ID, WALLET_ID_2, 100_000, 'Too much'),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// purchaseFromWallet (uses db.transaction, 7 positional args)
// ---------------------------------------------------------------------------
describe('purchaseFromWallet', () => {
  it('applies fee, debits buyer, credits seller, creates transactions', async () => {
    const buyerWallet = { ...EXISTING_WALLET, id: WALLET_ID, balanceCents: 10_000 };

    mockTxSelectLimit.mockResolvedValueOnce([buyerWallet]);

    // Ledger entry + purchase tx (fee insert doesn't chain .returning())
    mockTxInsertReturning
      .mockResolvedValueOnce([{ id: 'ledger-entry' }])
      .mockResolvedValueOnce([{ id: 'tx-purchase' }]);

    const result = await purchaseFromWallet(
      WALLET_ID,       // buyerWalletId
      WALLET_ID_2,     // sellerWalletId
      2000,            // amountCents ($20)
      100,             // feeCents (5% of $20)
      'listing',       // referenceType
      'listing-uuid',  // referenceId
      'Widget purchase', // description
      WALLET_ID_3,     // feeRecipientWalletId
    );

    expect(result).toBeDefined();
    expect(mockTxExecute).toHaveBeenCalled(); // FOR UPDATE locks
    expect(mockTxUpdateTable).toHaveBeenCalledTimes(3); // debit + seller credit + fee routing
    expect(mockTxInsertTable).toHaveBeenCalled(); // ledger + purchase + fee
    expect(mockTxInsertValues).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'service_fee',
        fromWalletId: WALLET_ID,
        toWalletId: WALLET_ID_3,
        amountCents: 100,
      }),
    );
  });

  it('rejects buyer == seller', async () => {
    await expect(
      purchaseFromWallet(WALLET_ID, WALLET_ID, 2000, 100, 'listing', 'id', 'desc'),
    ).rejects.toThrow('different');
  });

  it('rejects fee-bearing purchases without a fee recipient wallet', async () => {
    await expect(
      purchaseFromWallet(WALLET_ID, WALLET_ID_2, 2000, 100, 'listing', 'id', 'desc'),
    ).rejects.toThrow('Fee recipient wallet is required');
  });

  it('rejects insufficient buyer balance', async () => {
    const poorWallet = { ...EXISTING_WALLET, balanceCents: 100 };
    mockTxSelectLimit.mockResolvedValueOnce([poorWallet]);

    await expect(
      purchaseFromWallet(WALLET_ID, WALLET_ID_2, 2000, 100, 'listing', 'id', 'desc', WALLET_ID_3),
    ).rejects.toThrow('Insufficient');
  });

  it('rejects frozen buyer wallet', async () => {
    mockTxSelectLimit.mockResolvedValueOnce([FROZEN_WALLET]);

    await expect(
      purchaseFromWallet(WALLET_ID, WALLET_ID_2, 2000, 100, 'listing', 'id', 'desc', WALLET_ID_3),
    ).rejects.toThrow('frozen');
  });
});

// ---------------------------------------------------------------------------
// setEthAddress (uses top-level db.update, NOT transaction)
// ---------------------------------------------------------------------------
describe('setEthAddress', () => {
  it('stores valid address', async () => {
    mockIsValidEthAddress.mockReturnValue(true);
    mockDbReturning.mockResolvedValueOnce([{ id: WALLET_ID }]);

    await setEthAddress(WALLET_ID, '0xaabbccddee11223344556677889900aabbccddee');

    expect(mockIsValidEthAddress).toHaveBeenCalled();
    expect(mockDbUpdateTable).toHaveBeenCalled();
  });

  it('rejects invalid address', async () => {
    mockIsValidEthAddress.mockReturnValue(false);

    await expect(
      setEthAddress(WALLET_ID, 'not-an-eth-address'),
    ).rejects.toThrow('Invalid Ethereum address');
  });

  it('throws when wallet not found (empty update result)', async () => {
    mockIsValidEthAddress.mockReturnValue(true);
    mockDbReturning.mockResolvedValueOnce([]);

    await expect(
      setEthAddress(WALLET_ID, '0xaabbccddee11223344556677889900aabbccddee'),
    ).rejects.toThrow('Wallet not found');
  });
});

// ---------------------------------------------------------------------------
// recordEthPayment (uses top-level db.select + db.insert, 5 positional args)
// ---------------------------------------------------------------------------
describe('recordEthPayment', () => {
  it('creates ledger entry and transaction without modifying balances', async () => {
    // db.select for fromWallet
    mockDbSelectLimit.mockResolvedValueOnce([{ ownerId: AGENT_ID }]);
    // db.insert for ledger entry
    mockDbInsertReturning
      .mockResolvedValueOnce([{ id: 'ledger-entry' }])
      .mockResolvedValueOnce([{ id: 'tx-eth' }]);

    const result = await recordEthPayment(
      WALLET_ID,         // fromWalletId
      WALLET_ID_2,       // toWalletId
      5000,              // amountCents
      '0xabc123def456',  // ethTxHash
      'ETH payment',     // description
    );

    expect(result).toBeDefined();
    expect(mockDbInsertTable).toHaveBeenCalled();
    // Balance should NOT have been updated
    expect(mockDbUpdateTable).not.toHaveBeenCalled();
  });

  it('throws when source wallet not found', async () => {
    mockDbSelectLimit.mockResolvedValueOnce([]);

    await expect(
      recordEthPayment(WALLET_ID, WALLET_ID_2, 5000, '0xhash', 'desc'),
    ).rejects.toThrow('Source wallet not found');
  });
});
