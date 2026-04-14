"use client";

import { useSession } from "next-auth/react";
import { useRouter, usePathname } from "next/navigation";
import { useEffect } from "react";
import { isPublicPageRoute } from "@/lib/route-access";
import { useRemoteViewer } from "@/contexts/remote-viewer-context";

/**
 * Auth guard wrapper for client-rendered routes.
 *
 * Public routes render for all users. Protected routes redirect
 * unauthenticated users to `/auth/login` and suppress rendering
 * until auth state resolves.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const { isAuthenticated: remoteAuthenticated, loading: remoteLoading } = useRemoteViewer();
  const router = useRouter();
  const pathname = usePathname();
  const isPublic = isPublicPageRoute(pathname ?? "/");

  useEffect(() => {
    if (status === "loading" || remoteLoading) return;

    // Redirect unauthenticated users on protected routes to login.
    if (!session && !remoteAuthenticated && !isPublic) {
      router.push(`/auth/login?callbackUrl=${encodeURIComponent(pathname ?? "/")}`);
    }
  }, [session, status, remoteAuthenticated, remoteLoading, router, isPublic, pathname]);

  // Public routes always render, regardless of auth state.
  if (isPublic) {
    return <>{children}</>;
  }

  // Protected routes: trust the server-rendered content during hydration.
  // Returning null here would cause a hydration mismatch (React error #310)
  // because the server already rendered children with their hooks.
  if (status === "loading" || remoteLoading) {
    return <>{children}</>;
  }

  // Protected routes: suppress content for unauthenticated users (redirect in progress).
  if (!session && !remoteAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
