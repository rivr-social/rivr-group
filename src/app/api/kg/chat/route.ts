/**
 * POST /api/kg/chat — Chat with group-scoped KG context
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import * as kg from "@/lib/kg/autobot-kg-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://ai.camalot.me";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { message, scope_type, scope_id, history, max_context_chars } = body;

  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  if (!scope_id) {
    return NextResponse.json({ error: "scope_id (group ID) is required" }, { status: 400 });
  }

  const scopeType = scope_type || "group";
  const scopeId = scope_id;

  try {
    const { context } = await kg.buildContext(scopeType, scopeId, max_context_chars || 3000);

    const kgSystemPrompt = context
      ? `You have access to a knowledge graph for this ${scopeType}. Use these facts to inform your answers:\n\n${context}\n\n`
      : "";

    const openclawRes = await fetch(`${OPENCLAW_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: session.user.name || "user",
        message: `${kgSystemPrompt}User question: ${message}`,
        history: history || [],
        channel: `kg-chat:${scopeType}:${scopeId}`,
      }),
    });

    if (!openclawRes.ok) {
      const errText = await openclawRes.text();
      return NextResponse.json(
        { error: `OpenClaw error: ${openclawRes.status}`, detail: errText },
        { status: openclawRes.status },
      );
    }

    const data = await openclawRes.json();
    return NextResponse.json({
      ...data,
      kg_context_length: context.length,
      scope: { type: scopeType, id: scopeId },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "KG chat failed" },
      { status: 500 },
    );
  }
}
