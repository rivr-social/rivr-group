/**
 * Guided messenger login via mautrix bridges.
 *
 * Drives the mautrix bridgev2 provisioning API on behalf of the target
 * agent's Matrix account, so an admin links Telegram / WhatsApp / Signal /
 * etc. by scanning a QR or entering a phone code — never by pasting a bridge
 * token. On completion the `user_connectors` row is upserted as connected.
 *
 * Actions (POST body):
 *  - `start`  { targetAgentId?, provider }                → first LoginStep
 *  - `submit` { targetAgentId?, provider, loginId, stepId, stepType, inputs? } → next LoginStep
 *
 * Auth mirrors `/api/connectors`: self, or a group admin acting on a
 * group-like agent. Credentials never cross the client boundary.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { db } from "@/db";
import { agents, userConnectors } from "@/db/schema";
import { isGroupAgentType } from "@/lib/agent-types";
import { getBridgeForProvider } from "@/lib/matrix-bridge/bridge-registry";
import { getAgentMatrixAuth } from "@/lib/matrix-bridge/matrix-token";
import {
  BridgeProvisioningError,
  listLoginFlows,
  startLogin,
  submitLoginStep,
  type LoginStep,
  type LoginStepType,
} from "@/lib/matrix-bridge/provisioning-client";

export const dynamic = "force-dynamic";

async function resolveSubject(requested?: string) {
  const session = await auth();
  const actorId = session?.user?.id;
  if (!actorId) return { error: "Unauthorized", status: 401 } as const;
  const targetAgentId = requested?.trim() || actorId;
  if (targetAgentId !== actorId) {
    const [target] = await db
      .select({ type: agents.type })
      .from(agents)
      .where(eq(agents.id, targetAgentId))
      .limit(1);
    if (!target || !isGroupAgentType(target.type) || !(await isGroupAdmin(actorId, targetAgentId))) {
      return { error: "You must be a group admin to manage these connectors.", status: 403 } as const;
    }
  }
  return { actorId, targetAgentId } as const;
}

const VALID_STEP_TYPES: LoginStepType[] = ["display_and_wait", "user_input", "cookies", "complete"];

/** Strips server-only fields; only what the UI needs to render/advance a step. */
function publicStep(step: LoginStep) {
  return {
    type: step.type,
    loginId: step.login_id,
    stepId: step.step_id,
    instructions: step.instructions ?? null,
    display: step.display_and_wait ?? null,
    fields: step.user_input?.fields ?? null,
    complete: step.complete ? { name: step.complete.user_login_name } : null,
  };
}

/** On a `complete` step, mark the connector connected (idempotent upsert). */
async function persistCompletion(targetAgentId: string, provider: string, step: LoginStep): Promise<void> {
  if (step.type !== "complete" || !step.complete) return;
  const accountEmail = step.complete.user_login_name;
  const bridgeLoginId = step.complete.user_login_id;
  const existing = await db
    .select({ id: userConnectors.id })
    .from(userConnectors)
    .where(and(eq(userConnectors.userAgentId, targetAgentId), eq(userConnectors.provider, provider)))
    .limit(1);
  if (existing[0]) {
    await db
      .update(userConnectors)
      .set({
        accountEmail,
        metadata: { bridge: true, bridgeLoginId },
        lastSyncedAt: new Date(),
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(userConnectors.id, existing[0].id));
  } else {
    await db.insert(userConnectors).values({
      userAgentId: targetAgentId,
      provider,
      accountEmail,
      metadata: { bridge: true, bridgeLoginId },
      lastSyncedAt: new Date(),
    });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as null | {
    targetAgentId?: string;
    provider?: string;
    action?: "start" | "submit";
    loginId?: string;
    stepId?: string;
    stepType?: string;
    inputs?: Record<string, string>;
  };
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const subject = await resolveSubject(body.targetAgentId);
  if ("error" in subject) return NextResponse.json({ error: subject.error }, { status: subject.status });

  const provider = body.provider ?? "";
  const bridge = getBridgeForProvider(provider);
  if (!bridge) {
    return NextResponse.json(
      { error: "Guided login isn't available for this connector on this instance." },
      { status: 400 },
    );
  }

  let matrixAuth;
  try {
    matrixAuth = await getAgentMatrixAuth(subject.targetAgentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't prepare your Matrix account.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  try {
    if (body.action === "start") {
      const flows = await listLoginFlows(bridge.config, matrixAuth);
      if (flows.length === 0) {
        return NextResponse.json({ error: "This bridge has no login flows available." }, { status: 502 });
      }
      // Prefer a QR flow for qr-kind bridges, else the first advertised flow.
      const preferred =
        bridge.loginKind === "qr"
          ? flows.find((flow) => /qr/i.test(flow.id) || /qr/i.test(flow.name)) ?? flows[0]
          : flows[0];
      const step = await startLogin(bridge.config, matrixAuth, preferred.id);
      await persistCompletion(subject.targetAgentId, provider, step);
      return NextResponse.json({ hint: bridge.hint, loginKind: bridge.loginKind, step: publicStep(step) });
    }

    if (body.action === "submit") {
      const loginId = body.loginId?.trim();
      const stepId = body.stepId?.trim();
      const stepType = body.stepType ?? "";
      if (!loginId || !stepId || !VALID_STEP_TYPES.includes(stepType as LoginStepType)) {
        return NextResponse.json({ error: "Missing or invalid step parameters." }, { status: 400 });
      }
      const step = await submitLoginStep(bridge.config, matrixAuth, {
        loginId,
        stepId,
        stepType: stepType as LoginStepType,
        inputs: body.inputs,
      });
      await persistCompletion(subject.targetAgentId, provider, step);
      return NextResponse.json({ step: publicStep(step) });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (error instanceof BridgeProvisioningError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    const message = error instanceof Error ? error.message : "Bridge login failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
