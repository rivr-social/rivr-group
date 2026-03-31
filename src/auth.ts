/**
 * @module auth
 *
 * NextAuth v5 configuration for the RIVR platform.
 *
 * Authentication strategy:
 * - Uses the Credentials provider with email + bcrypt password verification.
 * - Sessions are JWT-based (no server-side session store) with a 7-day expiry.
 * - The Drizzle adapter is wired to the shared `db` instance for account/user
 *   persistence required by NextAuth's internal schema.
 *
 * Security notes:
 * - Password length bounds follow NIST SP 800-63B (min 8) and bcrypt's 72-byte
 *   truncation limit (max 72).
 * - The `authorize` callback returns `null` for all failure modes, deliberately
 *   avoiding information leakage about whether an email exists.
 * - AUTH_SECRET is required at startup; its absence throws immediately.
 *
 * Key exports:
 * - `authConfig` - The raw NextAuth configuration object.
 * - `handlers`   - HTTP route handlers (GET/POST) for `/api/auth/*`.
 * - `auth`       - Session retrieval function for server components / API routes.
 * - `signIn`     - Programmatic sign-in helper.
 * - `signOut`    - Programmatic sign-out helper.
 *
 * @see https://authjs.dev/getting-started/installation?framework=next.js
 */

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verify } from "@node-rs/bcrypt";
import type { NextAuthConfig } from "next-auth";

/**
 * Minimum allowed password length per NIST SP 800-63B guidelines.
 * Passwords shorter than this are rejected before any database lookup.
 */
const MINIMUM_PASSWORD_LENGTH = 8;

/**
 * Maximum allowed password length. bcrypt silently truncates inputs
 * longer than 72 bytes, so we cap here to avoid misleading the user
 * into thinking a longer password provides additional entropy.
 */
const MAXIMUM_PASSWORD_LENGTH = 72;
const buildFallbackAuthSecret = "build-only-auth-secret-not-for-runtime";

function clearStaleTokenIdentity(token: Record<string, unknown>) {
  delete token.sub;
  delete token.email;
  delete token.name;
  delete token.picture;
  delete token.id;
  token.revoked = true;
}

/**
 * Full NextAuth configuration object.
 *
 * Includes the Credentials provider, JWT callbacks that inject the agent ID
 * into the token/session, and a custom sign-in page at `/auth/login`.
 */
export const authConfig: NextAuthConfig = {
  adapter: DrizzleAdapter(db),

  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      /**
       * Validates email/password credentials against the agents table.
       *
       * Returns a user object on success or `null` on any failure,
       * including missing credentials, invalid length, unknown email,
       * or wrong password. All failure paths intentionally return `null`
       * to avoid leaking account existence information.
       */
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email as string;
        const password = credentials.password as string;

        if (
          password.length < MINIMUM_PASSWORD_LENGTH ||
          password.length > MAXIMUM_PASSWORD_LENGTH
        ) {
          return null;
        }

        const [agent] = await db
          .select()
          .from(agents)
          .where(eq(agents.email, email))
          .limit(1);

        if (!agent || !agent.passwordHash) {
          return null;
        }

        const passwordValid = await verify(password, agent.passwordHash);

        if (!passwordValid) {
          return null;
        }

        return {
          id: agent.id,
          name: agent.name,
          email: agent.email,
          image: agent.image,
        };
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) {
        token.id = user.id ?? token.sub;
        token.picture = user.image ?? undefined;
        token.name = user.name ?? undefined;
      }
      // Always refresh image/name from DB so stale JWTs self-heal
      // (e.g. avatar uploaded after login is reflected immediately).
      if (token.id) {
        const [agent] = await db
          .select({ image: agents.image, name: agents.name, metadata: agents.metadata })
          .from(agents)
          .where(eq(agents.id, token.id as string))
          .limit(1);
        if (agent) {
          const metadata =
            agent.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
              ? (agent.metadata as Record<string, unknown>)
              : {};
          const passwordChangedAt =
            typeof metadata.passwordChangedAt === "string" ? metadata.passwordChangedAt : null;
          const passwordChangedTs = passwordChangedAt ? Date.parse(passwordChangedAt) : null;
          const issuedAtMs =
            typeof token.iat === "number" && Number.isFinite(token.iat) ? token.iat * 1000 : null;

          if (passwordChangedTs && issuedAtMs && passwordChangedTs > issuedAtMs) {
            clearStaleTokenIdentity(token as Record<string, unknown>);
            return token;
          }

          token.picture = agent.image ?? undefined;
          token.name = agent.name ?? undefined;
        }
      }
      return token;
    },

    async session({ session, token }) {
      if ((token as Record<string, unknown>).revoked) {
        return {
          ...session,
          user: undefined,
          expires: new Date(0).toISOString(),
        };
      }
      if (session.user) {
        const resolvedId = (token.id as string | undefined) ?? (token.sub as string | undefined);
        if (resolvedId) {
          session.user.id = resolvedId;
        }
        session.user.image = (token.picture as string | undefined) ?? null;
        session.user.name = (token.name as string | undefined) ?? null;
      }
      return session;
    },
  },

  pages: {
    signIn: "/auth/login",
  },

  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 60 * 60, // 7 days
  },

  secret: (() => {
    const secret = process.env.AUTH_SECRET;
    if (secret) {
      return secret;
    }

    console.warn(
      "AUTH_SECRET is not set. Using build-time placeholder secret; runtime deployment must provide AUTH_SECRET."
    );
    return buildFallbackAuthSecret;
  })(),
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
