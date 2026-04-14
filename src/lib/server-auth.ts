"use server";

import { cookies } from "next/headers";
import { auth } from "@/auth";
import {
  REMOTE_VIEWER_COOKIE_NAME,
  validateRemoteViewerToken,
} from "@/lib/federation-remote-session";
import { getInstanceConfig } from "@/lib/federation/instance-config";

export type AuthenticatedActor =
  | {
      actorId: string;
      authType: "local";
      homeBaseUrl?: undefined;
    }
  | {
      actorId: string;
      authType: "remote";
      homeBaseUrl: string;
    };

export async function getAuthenticatedActor(): Promise<AuthenticatedActor | null> {
  const session = await auth();
  if (session?.user?.id) {
    return {
      actorId: session.user.id,
      authType: "local",
    };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(REMOTE_VIEWER_COOKIE_NAME)?.value;
  if (!token) return null;

  const config = getInstanceConfig();
  const remoteSession = validateRemoteViewerToken(token, config.instanceId);
  if (!remoteSession) return null;

  return {
    actorId: remoteSession.actorId,
    homeBaseUrl: remoteSession.homeBaseUrl,
    authType: "remote",
  };
}

export async function getAuthenticatedActorId(): Promise<string | null> {
  const actor = await getAuthenticatedActor();
  return actor?.actorId ?? null;
}
