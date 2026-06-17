"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSession } from "next-auth/react";

export type RemoteViewerSession = {
  actorId: string;
  homeBaseUrl: string;
  sessionToken: string;
  viewerState: "remotely_authenticated";
  displayName: string | null;
  image: string | null;
};

type RemoteViewerContextValue = {
  remoteViewer: RemoteViewerSession | null;
  loading: boolean;
  refresh: () => Promise<void>;
  clear: () => void;
  isAuthenticated: boolean;
};

const RemoteViewerContext = createContext<RemoteViewerContextValue>({
  remoteViewer: null,
  loading: true,
  refresh: async () => {},
  clear: () => {},
  isAuthenticated: false,
});

export function RemoteViewerProvider({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const [remoteViewer, setRemoteViewer] = useState<RemoteViewerSession | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    if (status === "loading") return;
    if (session?.user?.id) {
      setRemoteViewer(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/federation/remote-session", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        setRemoteViewer(null);
        return;
      }

      const json = (await response.json()) as Partial<RemoteViewerSession> & {
        success?: boolean;
        displayName?: string | null;
        image?: string | null;
      };
      if (
        json.success &&
        json.viewerState === "remotely_authenticated" &&
        typeof json.actorId === "string" &&
        typeof json.homeBaseUrl === "string" &&
        typeof json.sessionToken === "string"
      ) {
        setRemoteViewer({
          actorId: json.actorId,
          homeBaseUrl: json.homeBaseUrl,
          sessionToken: json.sessionToken,
          viewerState: "remotely_authenticated",
          displayName: typeof json.displayName === "string" ? json.displayName : null,
          image: typeof json.image === "string" ? json.image : null,
        });
      } else {
        setRemoteViewer(null);
      }
    } catch {
      setRemoteViewer(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [session?.user?.id, status]);

  const value = useMemo<RemoteViewerContextValue>(
    () => ({
      remoteViewer,
      loading,
      refresh,
      clear: () => setRemoteViewer(null),
      isAuthenticated: Boolean(session?.user?.id || remoteViewer),
    }),
    [loading, remoteViewer, session?.user?.id],
  );

  return <RemoteViewerContext.Provider value={value}>{children}</RemoteViewerContext.Provider>;
}

export function useRemoteViewer() {
  return useContext(RemoteViewerContext);
}
