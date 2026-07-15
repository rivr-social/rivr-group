"use client";

/**
 * CustomDomainPanel — connect a published builder site to the owner's own
 * domain (host-dispatch serving). Group adaptation of the person app's panel:
 * manual DNS only (no DNS-write connectors on this app), and the owner may be
 * a GROUP the caller administers (`targetAgentId` names it; authority is
 * enforced server-side in `/api/builder/domain`, never trusted from here).
 *
 * Flow: enter a domain → shown the exact A/CNAME records to add → Verify
 * (server node:dns check against the app host) → Connect (persists the
 * binding so the middleware host-dispatch serves the published snapshot).
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Globe } from "lucide-react";

const API_DOMAIN = "/api/builder/domain";

interface PublicationState {
  agentId: string;
  publishedVersionNumber: number | null;
  customDomain: string | null;
  domainStatus: string;
  domainError: string | null;
}

interface DnsRecord {
  type: string;
  name: string;
  value: string;
  purpose: string;
}

interface VerificationResult {
  verified: boolean;
  detail: string;
}

type Busy = "idle" | "verifying" | "binding" | "unbinding";

const STATUS_LABEL: Record<string, string> = {
  unbound: "Not connected",
  pending: "Pending DNS",
  bound: "Live",
  error: "Error",
};

/**
 * @param targetAgentId The site owner (a group id when building a group's
 *   site); omitted = the signed-in user's own site.
 * @param isPublished Whether a live published version exists (binding requires
 *   one — the parent tracks publish state).
 */
export function CustomDomainPanel({
  targetAgentId,
  isPublished,
}: {
  targetAgentId?: string;
  isPublished: boolean;
}) {
  const [publication, setPublication] = useState<PublicationState | null>(null);
  const [appHostname, setAppHostname] = useState<string | null>(null);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [busy, setBusy] = useState<Busy>("idle");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadState = useCallback(async () => {
    try {
      const query = targetAgentId ? `?target=${encodeURIComponent(targetAgentId)}` : "";
      const res = await fetch(`${API_DOMAIN}${query}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setPublication(data.publication ?? null);
      setAppHostname(data.appHostname ?? null);
      setDnsRecords(Array.isArray(data.dnsRecords) ? data.dnsRecords : []);
      if (data.publication?.customDomain) {
        setDomainInput((current) => current || data.publication.customDomain);
      }
    } catch {
      // non-fatal: panel still renders with defaults
    }
  }, [targetAgentId]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const postDomain = useCallback(
    async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = await fetch(API_DOMAIN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, targetAgentId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      return data;
    },
    [targetAgentId],
  );

  const verify = useCallback(async () => {
    setError("");
    setMessage("");
    setVerification(null);
    setBusy("verifying");
    try {
      const data = await postDomain({ action: "verify", domain: domainInput });
      const result = (data?.verification ?? null) as VerificationResult | null;
      setVerification(result);
      if (result?.verified) setMessage("Domain resolves to this instance — ready to connect.");
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy("idle");
    }
  }, [domainInput, postDomain, loadState]);

  const bind = useCallback(async () => {
    setError("");
    setMessage("");
    setBusy("binding");
    try {
      await postDomain({ action: "bind", domain: domainInput });
      setMessage(`${domainInput} is now serving the published site.`);
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setBusy("idle");
    }
  }, [domainInput, postDomain, loadState]);

  const unbind = useCallback(async () => {
    setError("");
    setMessage("");
    setBusy("unbinding");
    try {
      const res = await fetch(API_DOMAIN, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetAgentId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Disconnect failed");
      }
      setMessage("Custom domain disconnected.");
      setVerification(null);
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setBusy("idle");
    }
  }, [targetAgentId, loadState]);

  const status = publication?.domainStatus ?? "unbound";
  const disabled = busy !== "idle";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4" /> Custom domain
        </CardTitle>
        <CardDescription>
          Serve the published site on your own domain. Add the DNS record, verify, then connect.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">Status</span>
          <Badge variant={status === "bound" ? "default" : "outline"}>
            {STATUS_LABEL[status] ?? status}
          </Badge>
          {publication?.customDomain && (
            <span className="text-xs text-muted-foreground">{publication.customDomain}</span>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="custom-domain" className="text-xs">
            Your domain
          </Label>
          <Input
            id="custom-domain"
            placeholder="example.com or www.example.com"
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value.trim())}
            disabled={disabled}
          />
        </div>

        {appHostname && (
          <div className="rounded-md bg-muted/50 p-2 text-[11px] space-y-1">
            <div className="font-medium">DNS records to add</div>
            {(dnsRecords.length > 0
              ? dnsRecords
              : [
                  {
                    type: "A",
                    name: domainInput || "your-domain.com",
                    value: `<same IP as ${appHostname}>`,
                    purpose: `Point an A record at the same IP that ${appHostname} resolves to.`,
                  },
                  {
                    type: "CNAME",
                    name: domainInput || "www.your-domain.com",
                    value: appHostname,
                    purpose: `Or CNAME to ${appHostname} (subdomains).`,
                  },
                ]
            ).map((rec, i) => (
              <div key={i} className="font-mono">
                <span className="font-semibold">{rec.type}</span> {rec.name} → {rec.value}
                <div className="font-sans text-muted-foreground">{rec.purpose}</div>
              </div>
            ))}
          </div>
        )}

        {!isPublished && (
          <p className="text-[11px] text-muted-foreground">
            Publish the site first — a domain connects to the live published version.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={verify}
            disabled={disabled || !domainInput || !isPublished}
          >
            {busy === "verifying" ? "Verifying…" : "Verify DNS"}
          </Button>
          <Button size="sm" onClick={bind} disabled={disabled || !domainInput || !isPublished}>
            {busy === "binding" ? "Connecting…" : "Connect domain"}
          </Button>
          {(status === "bound" || status === "pending") && (
            <Button size="sm" variant="ghost" onClick={unbind} disabled={disabled}>
              {busy === "unbinding" ? "Disconnecting…" : "Disconnect"}
            </Button>
          )}
        </div>

        {verification && (
          <div
            className={`rounded-md p-2 text-[11px] ${
              verification.verified
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
            }`}
          >
            {verification.detail}
          </div>
        )}
        {message && (
          <div className="text-[11px] text-emerald-600 dark:text-emerald-400">{message}</div>
        )}
        {error && <div className="text-[11px] text-red-600 dark:text-red-400">{error}</div>}
        {publication?.domainError && !error && (
          <div className="text-[11px] text-amber-600 dark:text-amber-400">
            {publication.domainError}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
