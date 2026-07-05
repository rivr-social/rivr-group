/**
 * API developer-docs index for the sovereign group instance.
 *
 * Unlike the hosted global app, this build ships a STATIC API section (auth +
 * federation prose) rather than the machine-generated per-registry MCP /
 * per-group REST reference. The generated reference is driven by global's
 * `tools/docs-gen-{api,mcp}.ts` + a `prebuild` hook; porting it here needs a
 * group-adapted MCP generator (this repo's `MCP_TOOL_DEFINITIONS` is a single
 * array, not per-registry modules) and is tracked as follow-up work. The live
 * surface is still discoverable at runtime via `/.well-known/mcp`, `/llms.txt`,
 * and the `/api/mcp` endpoint.
 */
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "API reference",
  description: "Auth models, federation protocol, and the MCP/REST surface for building against this sovereign RIVR group instance.",
};

const CARDS = [
  {
    href: "/docs/api/auth",
    title: "Auth models",
    body: "The three principals RIVR authenticates: NextAuth session, MCP bearer token, and Ed25519 peer signature. Read this first.",
  },
  {
    href: "/docs/api/federation",
    title: "Federation protocol",
    body: "Signed-event + peer-registry endpoints this instance federates through — the verified-principal trust rail to the global hub.",
  },
];

export default function ApiIndexPage() {
  return (
    <div>
      <h1 className="mb-3 text-3xl font-bold tracking-tight text-foreground">API reference</h1>
      <p className="mb-6 max-w-2xl leading-7 text-foreground/85">
        Build against this sovereign group instance over REST, the Model Context Protocol (MCP), and the
        federation protocol. Every API surface derives identity{" "}
        <strong className="font-semibold text-foreground">server-side</strong> — client-supplied identity, owner,
        signer, or wallet is never trusted to bypass server derivation.
      </p>

      <div className="mb-8 grid gap-4 sm:grid-cols-2">
        {CARDS.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="rounded-xl border border-border bg-card/50 p-5 transition-colors hover:border-primary/50 hover:bg-card"
          >
            <h2 className="mb-1 text-lg font-semibold text-foreground">{card.title}</h2>
            <p className="text-sm leading-6 text-muted-foreground">{card.body}</p>
          </Link>
        ))}
      </div>

      <h2 className="mb-3 mt-8 text-xl font-semibold text-foreground">MCP &amp; REST surface</h2>
      <p className="mb-3 max-w-2xl leading-7 text-foreground/85">
        This instance exposes a Model Context Protocol tool surface over{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">POST /api/mcp</code> (advertised by{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">/.well-known/mcp</code> and{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">/llms.txt</code>) plus the REST route tree
        under <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">/api/**</code>. Every tool call runs
        in an act-as context and is written to the MCP provenance log. See{" "}
        <Link href="/docs/api/auth" className="text-primary hover:underline">Auth models</Link> for how callers
        authenticate.
      </p>
      <p className="max-w-2xl text-sm text-muted-foreground">
        The full per-tool and per-endpoint reference that the hosted{" "}
        <Link href="https://app.rivr.social/docs/api" className="text-primary hover:underline">global app</Link>{" "}
        generates from source is not built on this sovereign instance yet; the endpoints above are the source of
        truth in the meantime.
      </p>
    </div>
  );
}
