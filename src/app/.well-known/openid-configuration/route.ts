import { NextResponse } from "next/server";
import { getInstanceConfig } from "@/lib/federation/instance-config";

export async function GET() {
  const config = getInstanceConfig();
  const issuer = config.baseUrl.replace(/\/+$/, "");

  return NextResponse.json({
    issuer,
    authorization_endpoint: `${issuer}/api/federation/sso/start`,
    mcp_endpoint: `${issuer}/api/mcp`,
    token_endpoint: `${issuer}/api/federation/remote-auth`,
    userinfo_endpoint: `${issuer}/api/federation/remote-session`,
    jwks_uri: `${issuer}/.well-known/universal-manifest.json`,
    response_types_supported: ["code", "token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["HS256"],
    rivr: {
      instance_id: config.instanceId,
      instance_type: config.instanceType,
      primary_agent_id: config.primaryAgentId,
      universal_manifest: `${issuer}/.well-known/universal-manifest.json`,
      mcp_manifest: `${issuer}/.well-known/mcp`,
    },
  });
}
