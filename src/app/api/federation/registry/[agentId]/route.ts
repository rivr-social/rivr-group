import { NextResponse } from "next/server";
import { resolveHomeInstance } from "@/lib/federation/resolution";

/** UUID v1–v5 validation pattern. */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * GET /api/federation/registry/[agentId]
 *
 * Resolves the authoritative home instance for a specific agent.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { agentId } = await params;

    if (!UUID_REGEX.test(agentId)) {
      return NextResponse.json(
        { success: false, error: "Invalid agent ID format" },
        { status: 400 },
      );
    }

    const homeInstance = await resolveHomeInstance(agentId);
    return NextResponse.json({ success: true, homeInstance });
  } catch (error) {
    console.error("Failed to resolve home instance:", error);
    return NextResponse.json(
      { success: false, error: "Failed to resolve home instance" },
      { status: 500 },
    );
  }
}
