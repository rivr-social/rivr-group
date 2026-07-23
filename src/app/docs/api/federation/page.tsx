/**
 * Federation protocol page — authored trust-model prose.
 *
 * The hosted global app renders a GENERATED endpoint table here (from
 * `tools/docs-gen-api.ts`); this sovereign build ships the prose trust model
 * only. The live endpoint list is the `/api/federation/**` + `/.well-known/**`
 * route tree on this instance (there is no `/api/universal-manifest` here —
 * the manifest is served only at `/.well-known/universal-manifest.json`).
 */
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Federation protocol",
  description:
    "The Ed25519-signed event + peer-registry endpoints this sovereign RIVR instance federates through.",
};

export default function FederationPage() {
  return (
    <div>
      <h1 className="mb-3 text-3xl font-bold tracking-tight text-foreground">Federation protocol</h1>
      <p className="mb-4 max-w-2xl leading-7 text-foreground/85">
        This sovereign group instance runs independently and federates into the hosted{" "}
        <strong className="font-semibold text-foreground">global</strong> app for aggregation, discovery, and
        cross-instance interaction. Federation uses a PeerMesh protocol built on{" "}
        <strong className="font-semibold text-foreground">Ed25519-signed events</strong> authenticated against a{" "}
        <strong className="font-semibold text-foreground">peer registry</strong> — the signature, not an asserted
        node id, is the principal. See <Link href="/docs/api/auth" className="text-primary hover:underline">Auth models</Link>{" "}
        for how this sits alongside session and MCP-token auth.
      </p>

      <h2 className="mb-2 mt-8 border-b border-border/60 pb-1.5 text-2xl font-semibold text-foreground">
        Trust model
      </h2>
      <ul className="my-3 ml-6 list-disc space-y-1.5 text-foreground/85">
        <li>
          <strong className="font-semibold text-foreground">Signed events.</strong> Each federated mutation is an
          Ed25519-signed event. The receiver verifies the signature against the sender&apos;s registered peer key
          before materializing anything.
        </li>
        <li>
          <strong className="font-semibold text-foreground">Peer registry.</strong> Instances register each other
          (<code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">/api/federation/peers</code>) with a
          shared secret + public key; unknown peers cannot inject events.
        </li>
        <li>
          <strong className="font-semibold text-foreground">Replay protection.</strong> Signature + nonce dedup
          reject replays. A locally-initiated pull-sync cron may set{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">allowHistorical</code> to catch up after
          &gt;7-day downtime; push/import routes stay strict.
        </li>
        <li>
          <strong className="font-semibold text-foreground">FK-safe actors.</strong> Imported events bind{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">actorId</code> to the materialized local
          agent id, never the raw remote external id. If a resource event arrives before its owner, the importer
          projects a minimal private placeholder agent that the next agent upsert upgrades in place.
        </li>
        <li>
          <strong className="font-semibold text-foreground">Credential authority.</strong> This instance delegates
          password verification to <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">app.rivr.social/api/federation/sso/issue</code>{" "}
          with a local bcrypt fallback.
        </li>
      </ul>

      <h2 className="mb-2 mt-8 border-b border-border/60 pb-1.5 text-2xl font-semibold text-foreground">
        Endpoints
      </h2>
      <p className="my-3 max-w-2xl leading-7 text-foreground/85">
        The federation surface lives under{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">/api/federation/**</code> (registry,
        mutations, sync, remote-auth), with the Universal Manifest served at{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">/.well-known/universal-manifest.json</code>{" "}
        only — there is no{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">/api/universal-manifest</code> route on this
        instance — alongside the rest of discovery under{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">/.well-known/**</code>.
        These prefixes are auth-optional (peer signatures gate the mutating routes) per{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">PUBLIC_API_PREFIXES</code> in{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">src/lib/route-access.ts</code>.
      </p>

      <p className="mt-6 text-sm text-muted-foreground">
        See also the{" "}
        <Link href="/docs/wiki/federation-identity" className="text-primary hover:underline">
          Federation &amp; SSO identity wiki page
        </Link>{" "}
        for the user-facing side of sovereign homes and cross-instance identity.
      </p>
    </div>
  );
}
