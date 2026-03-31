/**
 * @fileoverview SessionProvider - Next-Auth session provider wrapper.
 *
 * Wraps the application in Next-Auth's SessionProvider so that session data
 * is available via useSession() throughout the component tree.
 *
 * Accepts an optional `session` prop from the server layout so that
 * useSession() returns session data on the very first render, eliminating
 * the loading flash that causes the avatar / authenticated UI to flicker.
 */
"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import type { ReactNode } from "react";

interface SessionProviderProps {
  children: ReactNode;
  session?: Session | null;
}

export function SessionProvider({ children, session }: SessionProviderProps) {
  return (
    <NextAuthSessionProvider session={session ?? undefined}>
      {children}
    </NextAuthSessionProvider>
  );
}
