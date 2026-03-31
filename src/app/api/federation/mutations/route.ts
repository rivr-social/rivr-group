import { NextResponse } from "next/server";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resolveHomeInstance } from "@/lib/federation/resolution";

/** Mutation types that this endpoint recognizes for future dispatch. */
const KNOWN_MUTATION_TYPES = [
  "createGroupResource",
  "updateGroupResource",
  "deleteGroupResource",
  "createPostResource",
  "createEventResource",
  "toggleJoinGroup",
  "createOffering",
  "updateAgent",
  "createComment",
  "toggleReaction",
] as const;

/**
 * POST /api/federation/mutations
 *
 * Receives forwarded mutations from remote instances.
 * Phase 1: Validates headers, verifies target agent locality, logs the mutation.
 * Phase 2 (TODO): Full dispatch to server actions with parameter shape mapping.
 */
export async function POST(request: Request) {
  const config = getInstanceConfig();

  try {
    // 1. Validate instance identity headers
    const remoteInstanceId = request.headers.get("X-Instance-Id");
    const remoteInstanceSlug = request.headers.get("X-Instance-Slug");

    if (!remoteInstanceId || !remoteInstanceSlug) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required headers: X-Instance-Id, X-Instance-Slug",
        },
        { status: 400 }
      );
    }

    // 2. Parse mutation body
    const body = await request.json();
    const { type, actorId, targetAgentId, payload } = body;

    if (!type || !actorId || !targetAgentId) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required fields: type, actorId, targetAgentId",
        },
        { status: 400 }
      );
    }

    // 3. Verify the targetAgentId belongs to this instance
    const homeInstance = await resolveHomeInstance(targetAgentId);

    if (!homeInstance.isLocal) {
      return NextResponse.json(
        {
          success: false,
          error: `Agent ${targetAgentId} is not local to this instance. Home instance: ${homeInstance.slug} (${homeInstance.nodeId})`,
        },
        { status: 421 } // Misdirected Request
      );
    }

    // 4. Log the accepted mutation for audit trail
    console.log(
      `[federation/mutations] Accepted mutation from instance ${remoteInstanceSlug} (${remoteInstanceId}):`,
      {
        type,
        actorId,
        targetAgentId,
        payloadKeys: payload ? Object.keys(payload) : [],
      }
    );

    // 5. Check if this is a known mutation type
    const isKnownType = (KNOWN_MUTATION_TYPES as readonly string[]).includes(type);

    // TODO Phase 2: Full dispatch implementation.
    // Server actions have varied parameter shapes (some take FormData, some
    // take plain objects with different arg positions). Full dispatch requires
    // a normalized adapter layer that maps the JSON payload to each action's
    // expected signature. For now, accept and acknowledge the mutation.
    //
    // Dispatch map (Phase 2):
    //   "createGroupResource"  -> createGroupResource(formData)
    //   "updateGroupResource"  -> updateGroupResource(formData)
    //   "deleteGroupResource"  -> deleteGroupResource(resourceId)
    //   "createPostResource"   -> createPostResource(formData)
    //   "createEventResource"  -> createEventResource(formData)
    //   "toggleJoinGroup"      -> toggleJoinGroup(groupId)
    //   etc.
    //
    // Each adapter would need to reconstruct the expected input from the
    // JSON payload, including re-creating FormData where required.

    return NextResponse.json({
      success: true,
      phase: "forwarding-stub",
      instanceId: config.instanceId,
      accepted: true,
      knownType: isKnownType,
      message: isKnownType
        ? `Mutation type '${type}' recognized. Dispatch pending Phase 2 implementation.`
        : `Mutation type '${type}' not in known dispatch map. Logged for review.`,
    });
  } catch (error) {
    console.error("[federation/mutations] Error processing mutation:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to process mutation",
      },
      { status: 500 }
    );
  }
}
