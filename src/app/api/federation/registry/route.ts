import { NextResponse } from "next/server";
import { listInstances } from "@/lib/federation/resolution";

/**
 * GET /api/federation/registry
 *
 * Returns all registered instances in the federation registry.
 */
export async function GET() {
  try {
    const instances = await listInstances();
    return NextResponse.json({ success: true, instances });
  } catch (error) {
    console.error("Failed to list federation instances:", error);
    return NextResponse.json(
      { success: false, error: "Failed to list instances" },
      { status: 500 },
    );
  }
}
