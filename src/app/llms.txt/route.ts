import { NextResponse } from "next/server";
import { getInstanceConfig } from "@/lib/federation/instance-config";

export async function GET() {
  const config = getInstanceConfig();
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const body = `# RIVR ${config.instanceType} instance

This RIVR instance exposes canonical state and actions for agents.

- Base URL: ${baseUrl}
- Instance ID: ${config.instanceId}
- Primary agent ID: ${config.primaryAgentId ?? "none"}
- MCP discovery: ${baseUrl}/.well-known/mcp
- MCP endpoint: ${baseUrl}/api/mcp
- Universal Manifest: ${baseUrl}/.well-known/universal-manifest.json
- OAuth/federated login discovery: ${baseUrl}/.well-known/openid-configuration
- Federated SSO start: ${baseUrl}/api/federation/sso/start?homeBaseUrl={canonical-home}

Agents should authenticate through federated SSO or a configured MCP bearer token, then call MCP tools for reads and writes.
`;

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
