/**
 * Resolves the Matrix identity used to drive bridge provisioning for an agent.
 *
 * The mautrix provisioning API authenticates as the logged-in Matrix user, so
 * the bridge login flow acts as the AGENT's Matrix account. This ensures the
 * account exists (reusing the same `provisionMatrixUser` path as group chat)
 * and returns a decrypted access token for the provisioning calls.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { provisionMatrixUser } from "@/lib/matrix-admin";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-box";

export interface AgentMatrixAuth {
  userId: string;
  token: string;
}

/**
 * Ensures the agent has a Matrix account and returns its user id + decrypted
 * access token. Provisions on first use; persists the encrypted token.
 *
 * @throws when Synapse provisioning fails or the token cannot be resolved.
 */
export async function getAgentMatrixAuth(agentId: string): Promise<AgentMatrixAuth> {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    columns: { id: true, name: true, matrixUserId: true, matrixAccessToken: true },
  });
  if (!agent) throw new Error("Agent not found.");

  // Existing account with a stored token → use it.
  if (agent.matrixUserId && agent.matrixAccessToken) {
    const token = decryptSecret(agent.matrixAccessToken);
    if (token) return { userId: agent.matrixUserId, token };
  }

  // Provision (or re-mint a token for an account missing one).
  const localpart = agent.id.replace(/-/g, "");
  const result = await provisionMatrixUser({ localpart, displayName: agent.name });
  await db
    .update(agents)
    .set({
      matrixUserId: result.matrixUserId,
      matrixAccessToken: encryptSecret(result.accessToken),
    })
    .where(eq(agents.id, agent.id));

  return { userId: result.matrixUserId, token: result.accessToken };
}
