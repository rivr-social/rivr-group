import { NextResponse } from "next/server";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { validateFederatedAssertion } from "@/lib/federation-remote-session";

type VerifyRequestBody = {
  actorId?: string;
  homeBaseUrl?: string;
  targetBaseUrl?: string;
  assertion?: string;
  issuedAt?: string;
  expiresAt?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as VerifyRequestBody;
    if (
      !body.actorId ||
      !body.homeBaseUrl ||
      !body.targetBaseUrl ||
      !body.assertion ||
      !body.issuedAt ||
      !body.expiresAt
    ) {
      return NextResponse.json(
        { valid: false, error: "Missing required verification fields" },
        { status: 400 },
      );
    }

    const config = getInstanceConfig();
    const instanceBaseUrl = config.baseUrl.replace(/\/+$/, "");
    const validation = validateFederatedAssertion({
      token: body.assertion,
      actorId: body.actorId,
      homeBaseUrl: instanceBaseUrl,
      audienceBaseUrl: body.targetBaseUrl.replace(/\/+$/, ""),
      issuedAt: body.issuedAt,
      expiresAt: body.expiresAt,
    });

    if (!validation.valid) {
      return NextResponse.json(
        { valid: false, error: validation.error },
        { status: 401 },
      );
    }

    return NextResponse.json({
      valid: true,
      displayName: validation.payload.displayName ?? null,
      manifestUrl: validation.payload.manifestUrl ?? null,
      persona: validation.payload.persona ?? null,
      scope: validation.payload.scope,
      context: validation.payload["@context"],
      type: validation.payload["@type"],
    });
  } catch (error) {
    return NextResponse.json(
      {
        valid: false,
        error: error instanceof Error ? error.message : "Failed to verify assertion",
      },
      { status: 500 },
    );
  }
}
