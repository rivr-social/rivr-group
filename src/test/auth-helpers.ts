/**
 * Auth session simulation for tests.
 *
 * Provides helpers to mock NextAuth sessions without a real HTTP context.
 *
 * Usage:
 *   import { mockAuthSession, mockUnauthenticated } from '@/test/auth-helpers';
 *
 *   vi.mock('@/auth', () => ({
 *     auth: vi.fn(),
 *     signIn: vi.fn(),
 *     signOut: vi.fn(),
 *   }));
 *
 *   import { auth } from '@/auth';
 *
 *   beforeEach(() => {
 *     vi.mocked(auth).mockResolvedValue(mockAuthSession(userId));
 *   });
 */

type MockSession = {
  user: {
    id: string;
    name?: string;
    email?: string;
    image?: string | null;
  };
  expires: string;
};

/**
 * Creates a mock NextAuth session object for an authenticated user.
 *
 * @param userId - The agent ID to embed in the session's `user.id` field.
 * @param extras - Optional overrides for name, email, image, and session expiry.
 * @returns A `MockSession` compatible with NextAuth's session shape.
 *
 * @example
 * ```ts
 * vi.mocked(auth).mockResolvedValue(mockAuthSession(userId));
 * ```
 */
export function mockAuthSession(
  userId: string,
  extras: {
    name?: string;
    email?: string;
    image?: string | null;
    expires?: string;
  } = {}
): MockSession {
  return {
    user: {
      id: userId,
      name: extras.name ?? "Test User",
      email: extras.email ?? "test@test.local",
      image: extras.image ?? null,
    },
    expires: extras.expires ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Returns `null` to simulate an unauthenticated (logged-out) session.
 *
 * @returns `null`, matching what `auth()` returns when no session exists.
 *
 * @example
 * ```ts
 * vi.mocked(auth).mockResolvedValue(mockUnauthenticated());
 * ```
 */
export function mockUnauthenticated(): null {
  return null;
}
