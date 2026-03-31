"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { verifyAtprotoCredentials } from "@/lib/atproto";
import { buildFederationIdentityStatus, type FederationIdentityStatus } from "@/lib/federation-identities";
import { parsePeermeshIdentityInput } from "@/lib/peermesh";

type IdentityResult<T = undefined> = {
  success: boolean;
  error?: string;
  data?: T;
};

async function requireUserId(): Promise<string> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("You must be signed in.");
  }
  return userId;
}

export async function getFederationIdentityStatusAction(): Promise<IdentityResult<FederationIdentityStatus>> {
  try {
    const userId = await requireUserId();
    return {
      success: true,
      data: await buildFederationIdentityStatus(userId),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unable to load federation status.",
    };
  }
}

export async function linkPeermeshIdentityAction(input: {
  manifestInput: string;
}): Promise<IdentityResult<FederationIdentityStatus>> {
  try {
    const userId = await requireUserId();
    const parsed = await parsePeermeshIdentityInput(input.manifestInput);

    await db
      .update(agents)
      .set({
        peermeshHandle: parsed.handle,
        peermeshDid: parsed.did,
        peermeshPublicKey: parsed.publicKey,
        peermeshManifestId: parsed.manifestId,
        peermeshManifestUrl: parsed.manifestUrl,
        peermeshLinkedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, userId));

    revalidatePath("/settings");
    revalidatePath("/profile");

    return {
      success: true,
      data: await buildFederationIdentityStatus(userId),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unable to link PeerMesh identity.",
    };
  }
}

export async function unlinkPeermeshIdentityAction(): Promise<IdentityResult<FederationIdentityStatus>> {
  try {
    const userId = await requireUserId();

    await db
      .update(agents)
      .set({
        peermeshHandle: null,
        peermeshDid: null,
        peermeshPublicKey: null,
        peermeshManifestId: null,
        peermeshManifestUrl: null,
        peermeshLinkedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, userId));

    revalidatePath("/settings");
    revalidatePath("/profile");

    return {
      success: true,
      data: await buildFederationIdentityStatus(userId),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unable to unlink PeerMesh identity.",
    };
  }
}

export async function linkAtprotoIdentityAction(input: {
  handle: string;
  appPassword: string;
}): Promise<IdentityResult<FederationIdentityStatus>> {
  try {
    const userId = await requireUserId();
    const identity = await verifyAtprotoCredentials(input);

    await db
      .update(agents)
      .set({
        atprotoHandle: identity.handle,
        atprotoDid: identity.did,
        atprotoLinkedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, userId));

    revalidatePath("/settings");
    revalidatePath("/profile");

    return {
      success: true,
      data: await buildFederationIdentityStatus(userId),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unable to link Bluesky identity.",
    };
  }
}

export async function unlinkAtprotoIdentityAction(): Promise<IdentityResult<FederationIdentityStatus>> {
  try {
    const userId = await requireUserId();

    await db
      .update(agents)
      .set({
        atprotoHandle: null,
        atprotoDid: null,
        atprotoLinkedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, userId));

    revalidatePath("/settings");
    revalidatePath("/profile");

    return {
      success: true,
      data: await buildFederationIdentityStatus(userId),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unable to unlink Bluesky identity.",
    };
  }
}
