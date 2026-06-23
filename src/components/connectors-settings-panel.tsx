"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Plug, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import type { ConnectorProvider } from "@/lib/connectors/catalog";

type Definition = { id: ConnectorProvider; label: string; credentialLabel: string | null; refreshCredentialLabel?: string; accountLabel: string; supportsTest?: boolean };
type Connection = { provider: string; accountEmail: string | null; hasCredential: boolean; lastSyncedAt: string | null };

export function ConnectorsSettingsPanel({ targetAgentId }: { targetAgentId?: string }) {
  const { toast } = useToast();
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [values, setValues] = useState<Record<string, { accountLabel: string; credential: string; refreshCredential: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const query = targetAgentId ? `?targetAgentId=${encodeURIComponent(targetAgentId)}` : "";
    const response = await fetch(`/api/connectors${query}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load connectors");
    setDefinitions(data.definitions ?? []);
    setConnections(data.connections ?? []);
    setValues((current) => Object.fromEntries((data.definitions ?? []).map((definition: Definition) => {
      const connection = (data.connections ?? []).find((item: Connection) => item.provider === definition.id);
      return [definition.id, {
        accountLabel: connection?.accountEmail ?? current[definition.id]?.accountLabel ?? "",
        credential: "",
        refreshCredential: "",
      }];
    })));
    setLoading(false);
  }, [targetAgentId]);

  useEffect(() => {
    async function loadInitialConnections() {
      try {
        await load();
      } catch (error) {
        setLoading(false);
        toast({ title: "Could not load connectors", description: String(error), variant: "destructive" });
      }
    }
    void loadInitialConnections();
  }, [load, toast]);

  async function mutate(provider: ConnectorProvider, action: "save" | "test" | "delete") {
    setBusy(`${provider}:${action}`);
    const method = action === "delete" ? "DELETE" : "POST";
    const response = await fetch("/api/connectors", {
      method, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetAgentId, provider, action: action === "delete" ? undefined : action, ...values[provider] }),
    });
    const data = await response.json();
    setBusy(null);
    if (!response.ok) {
      toast({ title: `${action === "test" ? "Connection test" : "Connector update"} failed`, description: data.error, variant: "destructive" });
      return;
    }
    toast({ title: action === "test" ? "Connection verified" : action === "delete" ? "Connector disconnected" : "Connector saved" });
    await load();
  }

  if (loading) return <Card><CardContent className="flex items-center gap-2 p-6"><Loader2 className="h-4 w-4 animate-spin" /> Loading connectors…</CardContent></Card>;

  return <div className="grid gap-4 md:grid-cols-2">
    {definitions.map((definition) => {
      const connection = connections.find((item) => item.provider === definition.id);
      const value = values[definition.id] ?? { accountLabel: "", credential: "", refreshCredential: "" };
      return <Card key={definition.id}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Plug className="h-4 w-4" />{definition.label}</CardTitle>
          <CardDescription>{connection ? <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" /> Connected as {connection.accountEmail}</span> : "Not connected"}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1"><Label>{definition.accountLabel}</Label><Input value={value.accountLabel} onChange={(event) => setValues((current) => ({ ...current, [definition.id]: { ...value, accountLabel: event.target.value } }))} /></div>
          {definition.credentialLabel ? <div className="space-y-1"><Label>{definition.credentialLabel}</Label><Input type="password" value={value.credential} placeholder={connection?.hasCredential ? "Leave blank to keep current credential" : "Required"} onChange={(event) => setValues((current) => ({ ...current, [definition.id]: { ...value, credential: event.target.value } }))} /></div> : null}
          {definition.refreshCredentialLabel ? <div className="space-y-1"><Label>{definition.refreshCredentialLabel}</Label><Input type="password" value={value.refreshCredential} placeholder="Required for long-running sync" onChange={(event) => setValues((current) => ({ ...current, [definition.id]: { ...value, refreshCredential: event.target.value } }))} /></div> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void mutate(definition.id, "save")} disabled={busy !== null}>{connection ? "Update" : "Connect"}</Button>
            {connection && definition.supportsTest !== false ? <Button size="sm" variant="outline" onClick={() => void mutate(definition.id, "test")} disabled={busy !== null}>Test</Button> : null}
            {connection ? <Button size="sm" variant="ghost" onClick={() => void mutate(definition.id, "delete")} disabled={busy !== null}><Trash2 className="mr-1 h-3.5 w-3.5" />Disconnect</Button> : null}
          </div>
        </CardContent>
      </Card>;
    })}
  </div>;
}
