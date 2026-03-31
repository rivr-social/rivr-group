/**
 * Tests for wallet server actions (src/app/actions/wallet.ts).
 * Validates authentication gating, rate limiting, input validation,
 * and correct delegation to the wallet service layer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — ensures variables are available inside vi.mock factories.
// ---------------------------------------------------------------------------
const {
  mockAuth,
  mockRateLimit,
  mockGetOrCreateWallet,
  mockGetWalletBalance,
  mockGetUserWallets,
  mockCreateDepositIntent,
  mockTransferP2P,
  mockPurchaseFromWallet,
  mockGetPlatformWallet,
  mockGetSettlementWalletForAgent,
  mockSetEthAddress,
  mockRecordEthPayment,
  mockGetTransactionHistory,
  mockIsValidEthAddress,
  mockLedgerFindFirst,
  mockResourcesFindFirst,
  mockDbSelect,
  mockDbInsert,
  mockDbUpdate,
} = vi.hoisted(() => {
  const mockDbSelectLimit = vi.fn();
  const mockDbSelectWhere = vi.fn(() => ({ limit: mockDbSelectLimit }));
  const mockDbSelectFrom = vi.fn(() => ({ where: mockDbSelectWhere }));
  const mockDbSelect = vi.fn(() => ({ from: mockDbSelectFrom }));
  const mockDbInsertValues = vi.fn();
  const mockDbInsert = vi.fn(() => ({ values: mockDbInsertValues }));
  const mockDbUpdateWhere = vi.fn();
  const mockDbUpdateSet = vi.fn(() => ({ where: mockDbUpdateWhere }));
  const mockDbUpdate = vi.fn(() => ({ set: mockDbUpdateSet }));
  // Expose inner mocks via properties for test configuration
  (mockDbSelect as Record<string, unknown>)._from = mockDbSelectFrom;
  (mockDbSelect as Record<string, unknown>)._where = mockDbSelectWhere;
  (mockDbSelect as Record<string, unknown>)._limit = mockDbSelectLimit;
  (mockDbInsert as Record<string, unknown>)._values = mockDbInsertValues;
  (mockDbUpdate as Record<string, unknown>)._set = mockDbUpdateSet;
  (mockDbUpdate as Record<string, unknown>)._where = mockDbUpdateWhere;
  return {
    mockAuth: vi.fn(),
    mockRateLimit: vi.fn(),
    mockGetOrCreateWallet: vi.fn(),
    mockGetWalletBalance: vi.fn(),
    mockGetUserWallets: vi.fn(),
    mockCreateDepositIntent: vi.fn(),
    mockTransferP2P: vi.fn(),
    mockPurchaseFromWallet: vi.fn(),
    mockGetPlatformWallet: vi.fn(),
    mockGetSettlementWalletForAgent: vi.fn(),
    mockSetEthAddress: vi.fn(),
    mockRecordEthPayment: vi.fn(),
    mockGetTransactionHistory: vi.fn(),
    mockIsValidEthAddress: vi.fn(),
    mockLedgerFindFirst: vi.fn(),
    mockResourcesFindFirst: vi.fn(),
    mockDbSelect,
    mockDbInsert,
    mockDbUpdate,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/auth', () => ({
  auth: () => mockAuth(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      ledger: {
        findFirst: (...args: unknown[]) => mockLedgerFindFirst(...args),
      },
      resources: {
        findFirst: (...args: unknown[]) => mockResourcesFindFirst(...args),
      },
    },
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
  },
}));

vi.mock('@/db/schema', () => ({
  ledger: {
    subjectId: 'ledger.subjectId',
    objectId: 'ledger.objectId',
    isActive: 'ledger.isActive',
    verb: 'ledger.verb',
  },
  resources: {
    id: 'resources.id',
    deletedAt: 'resources.deletedAt',
  },
  agents: {
    id: 'agents.id',
    type: 'agents.type',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ _op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ _op: 'and', args })),
  isNull: vi.fn((...args: unknown[]) => ({ _op: 'isNull', args })),
  desc: vi.fn((...args: unknown[]) => ({ _op: 'desc', args })),
  sql: Object.assign(vi.fn((...args: unknown[]) => ({ _op: 'sql', args })), {
    raw: vi.fn((...args: unknown[]) => ({ _op: 'sql.raw', args })),
  }),
  inArray: vi.fn((...args: unknown[]) => ({ _op: 'inArray', args })),
}));

vi.mock('@/lib/wallet', () => ({
  getOrCreateWallet: (...args: unknown[]) => mockGetOrCreateWallet(...args),
  getWalletBalance: (...args: unknown[]) => mockGetWalletBalance(...args),
  getUserWallets: (...args: unknown[]) => mockGetUserWallets(...args),
  createDepositIntent: (...args: unknown[]) => mockCreateDepositIntent(...args),
  transferP2P: (...args: unknown[]) => mockTransferP2P(...args),
  purchaseFromWallet: (...args: unknown[]) => mockPurchaseFromWallet(...args),
  getPlatformWallet: (...args: unknown[]) => mockGetPlatformWallet(...args),
  getSettlementWalletForAgent: (...args: unknown[]) => mockGetSettlementWalletForAgent(...args),
  setEthAddress: (...args: unknown[]) => mockSetEthAddress(...args),
  recordEthPayment: (...args: unknown[]) => mockRecordEthPayment(...args),
  getTransactionHistory: (...args: unknown[]) => mockGetTransactionHistory(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
  RATE_LIMITS: {
    WALLET: { limit: 100, windowMs: 60_000 },
    WALLET_DEPOSIT: { limit: 50, windowMs: 60_000 },
  },
}));

vi.mock('@/lib/eth-utils', () => ({
  isValidEthAddress: (...args: unknown[]) => mockIsValidEthAddress(...args),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() =>
    Promise.resolve({
      get: vi.fn((key: string) => {
        if (key === 'x-forwarded-for') return '127.0.0.1';
        if (key === 'user-agent') return 'test-agent';
        return null;
      }),
    })
  ),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER all mocks
// ---------------------------------------------------------------------------
import {
  getMyWalletAction,
  getMyWalletsAction,
  createDepositIntentAction,
  sendMoneyAction,
  getTransactionHistoryAction,
  setEthAddressAction,
  purchaseWithWalletAction,
  getGroupWalletAction,
  depositToGroupWalletAction,
  recordEthPaymentAction,
} from '../wallet';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const AGENT_ID = 'a1b2c3d4-e5f6-1a2b-9c8d-e7f6a5b4c3d2';
const RECIPIENT_AGENT_ID = 'b2c3d4e5-f6a1-2b3c-8d9e-f7a6b5c4d3e2';
const GROUP_ID = 'c3d4e5f6-a1b2-3c4d-9e8f-a7b6c5d4e3f2';

const AUTHENTICATED_SESSION = {
  user: { id: AGENT_ID, name: 'Test User', email: 'test@example.com' },
};

const PERSONAL_WALLET = {
  id: 'wallet-uuid-personal',
  ownerId: AGENT_ID,
  type: 'personal',
  balanceCents: 5000,
  currency: 'usd',
};

const RECIPIENT_WALLET = {
  id: 'wallet-uuid-recipient',
  ownerId: RECIPIENT_AGENT_ID,
  type: 'personal',
  balanceCents: 0,
  currency: 'usd',
};

const GROUP_WALLET = {
  id: 'wallet-uuid-group',
  ownerId: GROUP_ID,
  type: 'group',
  balanceCents: 10000,
  currency: 'usd',
};

const PLATFORM_WALLET = {
  id: 'wallet-uuid-platform',
  ownerId: 'platform-agent-id',
  type: 'group',
  balanceCents: 0,
  currency: 'usd',
};

const WALLET_BALANCE = {
  walletId: 'wallet-uuid-personal',
  ownerId: AGENT_ID,
  ownerName: 'Test User',
  type: 'personal' as const,
  balanceCents: 5000,
  balanceDollars: 50,
  currency: 'usd',
  ethAddress: null,
  isFrozen: false,
};

const GROUP_WALLET_BALANCE = {
  walletId: 'wallet-uuid-group',
  ownerId: GROUP_ID,
  ownerName: 'Test Group',
  type: 'group' as const,
  balanceCents: 10000,
  balanceDollars: 100,
  currency: 'usd',
  ethAddress: null,
  isFrozen: false,
};

const VALID_ETH_ADDRESS = '0xaabbccddee11223344556677889900aabbccddee';
const VALID_ETH_TX_HASH = '0x' + 'ab'.repeat(32); // 0x + 64 hex chars

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function authenticatedUser() {
  mockAuth.mockResolvedValue(AUTHENTICATED_SESSION);
}

function unauthenticatedUser() {
  mockAuth.mockResolvedValue(null);
}

function rateLimitSuccess() {
  mockRateLimit.mockResolvedValue({ success: true, remaining: 4, resetMs: 0 });
}

function rateLimitExhausted() {
  mockRateLimit.mockResolvedValue({ success: false, remaining: 0, resetMs: 60_000 });
}

function mockMembership(verb: 'join' | 'belong' = 'join') {
  mockLedgerFindFirst.mockResolvedValue({ id: 'ledger-entry-id', verb });
}

function mockNoMembership() {
  mockLedgerFindFirst.mockResolvedValue(null);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();

  authenticatedUser();
  rateLimitSuccess();

  mockGetOrCreateWallet.mockImplementation((ownerId: string, type: string) => {
    if (type === 'group') return Promise.resolve(GROUP_WALLET);
    if (ownerId === RECIPIENT_AGENT_ID) return Promise.resolve(RECIPIENT_WALLET);
    return Promise.resolve(PERSONAL_WALLET);
  });
  mockGetSettlementWalletForAgent.mockResolvedValue(GROUP_WALLET);
  mockGetPlatformWallet.mockResolvedValue(PLATFORM_WALLET);
  mockGetWalletBalance.mockImplementation((walletId: string) => {
    if (walletId === GROUP_WALLET.id) return Promise.resolve(GROUP_WALLET_BALANCE);
    return Promise.resolve(WALLET_BALANCE);
  });
  mockIsValidEthAddress.mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// getMyWalletAction
// ---------------------------------------------------------------------------
describe('getMyWalletAction', () => {
  it('returns wallet balance for authenticated user', async () => {
    const result = await getMyWalletAction();

    expect(result.success).toBe(true);
    expect(result.wallet).toEqual(WALLET_BALANCE);
    expect(mockGetOrCreateWallet).toHaveBeenCalledWith(AGENT_ID, 'personal');
    expect(mockGetWalletBalance).toHaveBeenCalledWith(PERSONAL_WALLET.id);
  });

  it('returns error for unauthenticated user', async () => {
    unauthenticatedUser();

    const result = await getMyWalletAction();

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockGetOrCreateWallet).not.toHaveBeenCalled();
  });

  it('returns error when wallet service throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetOrCreateWallet.mockRejectedValue(new Error('DB connection failed'));

    const result = await getMyWalletAction();

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unable to retrieve wallet. Please try again later.');
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// getMyWalletsAction
// ---------------------------------------------------------------------------
describe('getMyWalletsAction', () => {
  it('returns all wallets for authenticated user', async () => {
    const walletList = [WALLET_BALANCE, GROUP_WALLET_BALANCE];
    mockGetUserWallets.mockResolvedValue(walletList);

    const result = await getMyWalletsAction();

    expect(result.success).toBe(true);
    expect(result.wallets).toEqual(walletList);
    expect(mockGetUserWallets).toHaveBeenCalledWith(AGENT_ID);
  });

  it('returns error for unauthenticated user', async () => {
    unauthenticatedUser();

    const result = await getMyWalletsAction();

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockGetUserWallets).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createDepositIntentAction
// ---------------------------------------------------------------------------
describe('createDepositIntentAction', () => {
  it('returns clientSecret on success', async () => {
    mockCreateDepositIntent.mockResolvedValue({
      clientSecret: 'pi_secret_123',
      paymentIntentId: 'pi_123',
    });

    const result = await createDepositIntentAction(1000);

    expect(result.success).toBe(true);
    expect(result.clientSecret).toBe('pi_secret_123');
    expect(mockCreateDepositIntent).toHaveBeenCalledWith(PERSONAL_WALLET.id, 1000);
  });

  it('rejects when rate limited', async () => {
    rateLimitExhausted();

    const result = await createDepositIntentAction(1000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limit');
    expect(mockCreateDepositIntent).not.toHaveBeenCalled();
  });

  it('rejects amount below minimum ($1.00 = 100 cents)', async () => {
    const result = await createDepositIntentAction(50);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Minimum deposit');
    expect(mockCreateDepositIntent).not.toHaveBeenCalled();
  });

  it('rejects amount above maximum ($1,000.00 = 100000 cents)', async () => {
    const result = await createDepositIntentAction(200_000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Maximum deposit');
    expect(mockCreateDepositIntent).not.toHaveBeenCalled();
  });

  it('rejects non-integer amounts', async () => {
    const result = await createDepositIntentAction(10.5);

    expect(result.success).toBe(false);
    expect(result.error).toContain('positive integer');
    expect(mockCreateDepositIntent).not.toHaveBeenCalled();
  });

  it('rejects zero or negative amounts', async () => {
    const resultZero = await createDepositIntentAction(0);
    expect(resultZero.success).toBe(false);

    const resultNeg = await createDepositIntentAction(-100);
    expect(resultNeg.success).toBe(false);
  });

  it('returns error for unauthenticated user', async () => {
    unauthenticatedUser();

    const result = await createDepositIntentAction(1000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('logged in');
  });
});

// ---------------------------------------------------------------------------
// sendMoneyAction
// ---------------------------------------------------------------------------
describe('sendMoneyAction', () => {
  it('transfers between authenticated users', async () => {
    mockTransferP2P.mockResolvedValue({ id: 'tx-transfer' });

    const result = await sendMoneyAction(RECIPIENT_AGENT_ID, 500, 'Thanks!');

    expect(result.success).toBe(true);
    expect(mockTransferP2P).toHaveBeenCalledWith(
      PERSONAL_WALLET.id,
      RECIPIENT_WALLET.id,
      500,
      'Thanks!'
    );
  });

  it('uses default description when message is omitted', async () => {
    mockTransferP2P.mockResolvedValue({ id: 'tx-transfer' });

    await sendMoneyAction(RECIPIENT_AGENT_ID, 500);

    expect(mockTransferP2P).toHaveBeenCalledWith(
      PERSONAL_WALLET.id,
      RECIPIENT_WALLET.id,
      500,
      'P2P transfer'
    );
  });

  it('rejects unauthenticated user', async () => {
    unauthenticatedUser();

    const result = await sendMoneyAction(RECIPIENT_AGENT_ID, 500);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockTransferP2P).not.toHaveBeenCalled();
  });

  it('rejects self-transfer', async () => {
    const result = await sendMoneyAction(AGENT_ID, 500);

    expect(result.success).toBe(false);
    expect(result.error).toContain('yourself');
    expect(mockTransferP2P).not.toHaveBeenCalled();
  });

  it('rejects invalid recipient UUID', async () => {
    const result = await sendMoneyAction('not-a-uuid', 500);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid recipient');
    expect(mockTransferP2P).not.toHaveBeenCalled();
  });

  it('rejects amount above maximum transfer limit', async () => {
    const result = await sendMoneyAction(RECIPIENT_AGENT_ID, 60_000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Maximum transfer');
  });

  it('rejects when rate limited', async () => {
    rateLimitExhausted();

    const result = await sendMoneyAction(RECIPIENT_AGENT_ID, 500);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limit');
  });

  it('surfaces wallet error messages from service layer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockTransferP2P.mockRejectedValue(new Error('Insufficient balance'));

    const result = await sendMoneyAction(RECIPIENT_AGENT_ID, 500);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Insufficient balance');
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// getTransactionHistoryAction
// ---------------------------------------------------------------------------
describe('getTransactionHistoryAction', () => {
  it('returns paginated transactions', async () => {
    const mockTransactions = [
      { id: 'tx-1', type: 'p2p_transfer', amountCents: 500, amountDollars: 5, feeCents: 0, description: 'Test', status: 'completed', createdAt: '2026-02-19T00:00:00Z' },
    ];
    mockGetTransactionHistory.mockResolvedValue({ transactions: mockTransactions, total: 1 });

    const result = await getTransactionHistoryAction({ limit: 10, offset: 0 });

    expect(result.success).toBe(true);
    expect(result.transactions).toEqual(mockTransactions);
    expect(result.total).toBe(1);
    expect(mockGetTransactionHistory).toHaveBeenCalledWith(PERSONAL_WALLET.id, { limit: 10, offset: 0 });
  });

  it('returns error for unauthenticated user', async () => {
    unauthenticatedUser();

    const result = await getTransactionHistoryAction();

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// setEthAddressAction
// ---------------------------------------------------------------------------
describe('setEthAddressAction', () => {
  it('validates and sets address', async () => {
    mockSetEthAddress.mockResolvedValue(undefined);

    const result = await setEthAddressAction(VALID_ETH_ADDRESS);

    expect(result.success).toBe(true);
    expect(mockSetEthAddress).toHaveBeenCalledWith(PERSONAL_WALLET.id, VALID_ETH_ADDRESS);
  });

  it('rejects invalid address', async () => {
    mockIsValidEthAddress.mockReturnValue(false);

    const result = await setEthAddressAction('not-valid');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid Ethereum address');
    expect(mockSetEthAddress).not.toHaveBeenCalled();
  });

  it('returns error for unauthenticated user', async () => {
    unauthenticatedUser();

    const result = await setEthAddressAction(VALID_ETH_ADDRESS);

    expect(result.success).toBe(false);
    expect(result.error).toContain('logged in');
  });
});

// ---------------------------------------------------------------------------
// purchaseWithWalletAction
// ---------------------------------------------------------------------------
describe('purchaseWithWalletAction', () => {
  const LISTING_ID = 'd4e5f6a1-b2c3-4d5e-8f9a-b7c6d5e4f3a2';
  const SELLER_AGENT_ID = 'e5f6a1b2-c3d4-5e6f-9a8b-c7d6e5f4a3b2';

  const MOCK_LISTING = {
    id: LISTING_ID,
    name: 'Test Listing',
    type: 'listing',
    ownerId: SELLER_AGENT_ID,
    deletedAt: null,
    metadata: { listingType: 'product' },
    owner: { id: SELLER_AGENT_ID, name: 'Seller', type: 'person' },
  };

  const SELLER_WALLET = {
    id: 'wallet-uuid-seller',
    ownerId: SELLER_AGENT_ID,
    type: 'personal',
    balanceCents: 0,
    currency: 'usd',
  };

  beforeEach(() => {
    // Configure resource mock to return a valid listing
    mockResourcesFindFirst.mockResolvedValue(MOCK_LISTING);
    // Configure db.select chain to return seller agent
    const limitMock = (mockDbSelect as Record<string, unknown>)._limit as ReturnType<typeof vi.fn>;
    limitMock.mockResolvedValue([{ type: 'person' }]);
    // Configure seller wallet
    mockGetOrCreateWallet.mockImplementation((ownerId: string, type: string) => {
      if (ownerId === SELLER_AGENT_ID) return Promise.resolve(SELLER_WALLET);
      if (type === 'group') return Promise.resolve(GROUP_WALLET);
      if (ownerId === RECIPIENT_AGENT_ID) return Promise.resolve(RECIPIENT_WALLET);
      return Promise.resolve(PERSONAL_WALLET);
    });
    const insertValuesMock = (mockDbInsert as Record<string, unknown>)._values as ReturnType<typeof vi.fn>;
    insertValuesMock.mockResolvedValue(undefined);
    const updateWhereMock = (mockDbUpdate as Record<string, unknown>)._where as ReturnType<typeof vi.fn>;
    updateWhereMock.mockResolvedValue(undefined);
    mockPurchaseFromWallet.mockResolvedValue({ id: 'tx-purchase' });
  });

  it('completes purchase for valid request with sufficient balance', async () => {
    const result = await purchaseWithWalletAction(LISTING_ID, 2000);

    expect(result.success).toBe(true);
    expect(mockPurchaseFromWallet).toHaveBeenCalledWith(
      PERSONAL_WALLET.id,
      SELLER_WALLET.id,
      2100,
      100,
      'resource',
      LISTING_ID,
      'Marketplace purchase: Test Listing',
      PLATFORM_WALLET.id,
    );
  });

  it('rejects insufficient balance', async () => {
    mockGetWalletBalance.mockResolvedValue({ ...WALLET_BALANCE, balanceCents: 100 });

    const result = await purchaseWithWalletAction(LISTING_ID, 2000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient');
  });

  it('rejects invalid listing ID', async () => {
    const result = await purchaseWithWalletAction('bad-id', 2000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid listing');
  });

  it('rejects when rate limited', async () => {
    rateLimitExhausted();

    const result = await purchaseWithWalletAction(LISTING_ID, 2000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limit');
  });

  it('rejects wallet purchase when listing does not accept USD', async () => {
    mockResourcesFindFirst.mockResolvedValue({
      ...MOCK_LISTING,
      metadata: { listingType: 'product', acceptedCurrencies: ['ETH'] },
    });

    const result = await purchaseWithWalletAction(LISTING_ID, 2000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be purchased with wallet USD');
  });

  it('rejects wallet purchase beyond remaining inventory', async () => {
    mockResourcesFindFirst.mockResolvedValue({
      ...MOCK_LISTING,
      metadata: {
        listingType: 'product',
        totalPriceCents: 1000,
        quantityAvailable: 2,
        quantitySold: 1,
        quantityRemaining: 1,
      },
    });

    const result = await purchaseWithWalletAction(LISTING_ID, 2000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('inventory remaining');
  });
});

// ---------------------------------------------------------------------------
// getGroupWalletAction
// ---------------------------------------------------------------------------
describe('getGroupWalletAction', () => {
  it('returns group wallet for member with join verb', async () => {
    mockMembership('join');

    const result = await getGroupWalletAction(GROUP_ID);

    expect(result.success).toBe(true);
    expect(result.wallet).toEqual(GROUP_WALLET_BALANCE);
    expect(mockGetOrCreateWallet).toHaveBeenCalledWith(GROUP_ID, 'group');
  });

  it('returns group wallet for member with belong verb', async () => {
    mockMembership('belong');

    const result = await getGroupWalletAction(GROUP_ID);

    expect(result.success).toBe(true);
    expect(result.wallet).toEqual(GROUP_WALLET_BALANCE);
  });

  it('rejects non-member', async () => {
    mockNoMembership();

    const result = await getGroupWalletAction(GROUP_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain('member');
  });

  it('rejects member with wrong verb (e.g. follow)', async () => {
    mockLedgerFindFirst.mockResolvedValue({ id: 'ledger-entry-id', verb: 'follow' });

    const result = await getGroupWalletAction(GROUP_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain('member');
  });

  it('rejects invalid group ID', async () => {
    const result = await getGroupWalletAction('not-a-uuid');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid group');
  });

  it('returns error for unauthenticated user', async () => {
    unauthenticatedUser();

    const result = await getGroupWalletAction(GROUP_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain('logged in');
  });
});

// ---------------------------------------------------------------------------
// depositToGroupWalletAction
// ---------------------------------------------------------------------------
describe('depositToGroupWalletAction', () => {
  it('transfers from personal wallet to group wallet for member', async () => {
    mockMembership('join');
    mockTransferP2P.mockResolvedValue({ id: 'tx-group-deposit' });

    const result = await depositToGroupWalletAction(GROUP_ID, 1000);

    expect(result.success).toBe(true);
    expect(mockTransferP2P).toHaveBeenCalledWith(
      PERSONAL_WALLET.id,
      GROUP_WALLET.id,
      1000,
      'Group deposit'
    );
  });

  it('rejects non-member', async () => {
    mockNoMembership();

    const result = await depositToGroupWalletAction(GROUP_ID, 1000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('member');
    expect(mockTransferP2P).not.toHaveBeenCalled();
  });

  it('rejects when rate limited', async () => {
    rateLimitExhausted();

    const result = await depositToGroupWalletAction(GROUP_ID, 1000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limit');
  });

  it('rejects invalid group ID', async () => {
    const result = await depositToGroupWalletAction('bad', 1000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid group');
  });

  it('rejects amount above transfer maximum', async () => {
    const result = await depositToGroupWalletAction(GROUP_ID, 60_000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Maximum transfer');
  });
});

// ---------------------------------------------------------------------------
// recordEthPaymentAction
// ---------------------------------------------------------------------------
describe('recordEthPaymentAction', () => {
  it('records ETH payment between two agents', async () => {
    mockRecordEthPayment.mockResolvedValue({ id: 'tx-eth' });

    const result = await recordEthPaymentAction(
      RECIPIENT_AGENT_ID,
      5000,
      VALID_ETH_TX_HASH,
      'Payment for services'
    );

    expect(result.success).toBe(true);
    expect(mockRecordEthPayment).toHaveBeenCalledWith(
      PERSONAL_WALLET.id,
      RECIPIENT_WALLET.id,
      5000,
      VALID_ETH_TX_HASH,
      'Payment for services'
    );
  });

  it('rejects invalid ETH transaction hash', async () => {
    const result = await recordEthPaymentAction(
      RECIPIENT_AGENT_ID,
      5000,
      '0xabc123', // too short
      'Payment'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('transaction hash');
    expect(mockRecordEthPayment).not.toHaveBeenCalled();
  });

  it('rejects empty description', async () => {
    const result = await recordEthPaymentAction(
      RECIPIENT_AGENT_ID,
      5000,
      VALID_ETH_TX_HASH,
      '   '
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Description is required');
  });

  it('rejects invalid recipient', async () => {
    const result = await recordEthPaymentAction(
      'not-uuid',
      5000,
      VALID_ETH_TX_HASH,
      'Payment'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid recipient');
  });

  it('rejects when rate limited', async () => {
    rateLimitExhausted();

    const result = await recordEthPaymentAction(
      RECIPIENT_AGENT_ID,
      5000,
      VALID_ETH_TX_HASH,
      'Payment'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limit');
  });

  it('returns error for unauthenticated user', async () => {
    unauthenticatedUser();

    const result = await recordEthPaymentAction(
      RECIPIENT_AGENT_ID,
      5000,
      VALID_ETH_TX_HASH,
      'Payment'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('logged in');
  });
});
