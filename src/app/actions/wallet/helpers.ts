'use server';

import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/db';
import { agents } from '@/db/schema';
import { getSettlementWalletForAgent } from '@/lib/wallet';

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function getAgentRecord(agentId: string): Promise<{
  id: string;
  type: string;
  email: string | null;
  name: string;
  metadata: Record<string, unknown> | null;
} | null> {
  const [agent] = await db
    .select({
      id: agents.id,
      type: agents.type,
      email: agents.email,
      name: agents.name,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent) return null;

  return {
    ...agent,
    metadata: (agent.metadata ?? {}) as Record<string, unknown>,
  };
}

export async function canManageWalletOwner(currentUserId: string, ownerId: string): Promise<boolean> {
  if (currentUserId === ownerId) return true;

  const owner = await getAgentRecord(ownerId);
  if (!owner) return false;

  const creatorId = typeof owner.metadata?.creatorId === 'string' ? owner.metadata.creatorId : null;
  const adminIds = Array.isArray(owner.metadata?.adminIds) ? owner.metadata.adminIds : [];

  return creatorId === currentUserId || adminIds.includes(currentUserId);
}

export async function resolveManagedWalletTarget(currentUserId: string, ownerId?: string): Promise<{
  ownerId: string;
  walletId: string;
  walletType: 'personal' | 'group';
  email: string | null;
  name: string;
}> {
  const resolvedOwnerId = ownerId ?? currentUserId;
  const allowed = await canManageWalletOwner(currentUserId, resolvedOwnerId);
  if (!allowed) {
    throw new Error('You are not allowed to manage payments for this treasury.');
  }

  const owner = await getAgentRecord(resolvedOwnerId);
  if (!owner) {
    throw new Error('Payment owner not found.');
  }

  const wallet = await getSettlementWalletForAgent(resolvedOwnerId);

  return {
    ownerId: resolvedOwnerId,
    walletId: wallet.id,
    walletType: wallet.type,
    email: owner.email,
    name: owner.name,
  };
}
