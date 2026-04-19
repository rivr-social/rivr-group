import { NextResponse } from "next/server";
import { getInstanceConfig } from "@/lib/federation/instance-config";

export async function GET() {
  const config = getInstanceConfig();
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>RIVR Agent Discovery</title>
  </head>
  <body>
    <h1>RIVR ${config.instanceType} instance</h1>
    <p>This instance exposes canonical state and MCP actions for agents.</p>
    <ul>
      <li>Base URL: <code>${baseUrl}</code></li>
      <li>Instance ID: <code>${config.instanceId}</code></li>
      <li>Primary agent ID: <code>${config.primaryAgentId ?? "none"}</code></li>
      <li><a href="/.well-known/mcp">MCP discovery</a></li>
      <li><a href="/api/mcp">MCP endpoint</a></li>
      <li><a href="/.well-known/universal-manifest.json">Universal Manifest</a></li>
      <li><a href="/.well-known/openid-configuration">OAuth/federated login discovery</a></li>
    </ul>
  </body>
</html>`;

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
