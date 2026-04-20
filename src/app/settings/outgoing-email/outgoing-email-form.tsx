"use client";

/**
 * Admin form for `/settings/outgoing-email` (ticket #106).
 *
 * Lets instance admins configure / test / remove this Rivr instance's
 * outgoing transactional SMTP credentials. Federated-auth email is
 * explicitly called out as non-configurable here — it always routes
 * through the global identity authority.
 *
 * Consumes:
 *   GET    /api/admin/smtp-config          — render current state
 *   POST   /api/admin/smtp-config          — save
 *   POST   /api/admin/smtp-config/test     — test send
 *   DELETE /api/admin/smtp-config          — revert to relay
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  Loader2,
  Mail,
  Shield,
  Trash2,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";

export interface OutgoingEmailConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  passwordSecretRef: string;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
}

export interface OutgoingEmailInitial {
  instanceId: string;
  instanceType: string;
  instanceSlug: string;
  config: OutgoingEmailConfig | null;
}

const DEFAULT_PASSWORD_REF = "PEER_SMTP_PASSWORD";

const BACK_LABEL = "Back to settings";

function emptyConfig(): OutgoingEmailConfig {
  return {
    enabled: false,
    host: "",
    port: 587,
    secure: false,
    username: "",
    fromAddress: "",
    passwordSecretRef: DEFAULT_PASSWORD_REF,
    lastTestAt: null,
    lastTestStatus: null,
    lastTestError: null,
  };
}

export function OutgoingEmailForm({ initial }: { initial: OutgoingEmailInitial }) {
  const router = useRouter();
  const { toast } = useToast();

  const [config, setConfig] = useState<OutgoingEmailConfig>(
    initial.config ?? emptyConfig(),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [testResult, setTestResult] = useState<
    | { status: "ok"; recipient?: string; messageId?: string | null; testedAt?: string }
    | { status: "failed"; error: string; testedAt?: string }
    | null
  >(
    initial.config?.lastTestStatus === "ok"
      ? {
          status: "ok",
          testedAt: initial.config.lastTestAt ?? undefined,
        }
      : initial.config?.lastTestStatus === "failed"
        ? {
            status: "failed",
            error: initial.config.lastTestError ?? "Previous test failed",
            testedAt: initial.config.lastTestAt ?? undefined,
          }
        : null,
  );
  const [testRecipient, setTestRecipient] = useState("");

  const hasSavedConfig = initial.config !== null;

  const isPeerInstance = useMemo(
    () => initial.instanceType !== "global",
    [initial.instanceType],
  );

  async function handleSave() {
    setIsSaving(true);
    try {
      const response = await fetch("/api/admin/smtp-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: config.enabled,
          host: config.host.trim(),
          port: Number(config.port),
          secure: config.secure,
          username: config.username.trim(),
          fromAddress: config.fromAddress.trim(),
          passwordSecretRef: config.passwordSecretRef.trim(),
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${response.status}`);
      }
      toast({
        title: "Outgoing SMTP saved",
        description: "The new config is live and will be used for outgoing transactional email.",
      });
      router.refresh();
    } catch (error) {
      toast({
        title: "Could not save",
        description:
          error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleTest() {
    setIsTesting(true);
    setTestResult(null);
    try {
      const response = await fetch("/api/admin/smtp-config/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          testRecipient.trim().length > 0
            ? { testRecipient: testRecipient.trim() }
            : {},
        ),
      });
      const json = await response.json();
      if (response.status === 400) {
        // Validation / "not configured" errors.
        setTestResult({
          status: "failed",
          error: json.error ?? "Test rejected by server",
        });
        return;
      }
      if (json.ok) {
        setTestResult({
          status: "ok",
          recipient: json.recipient,
          messageId: json.messageId ?? null,
          testedAt: json.testedAt,
        });
        toast({ title: "Test send succeeded" });
      } else {
        setTestResult({
          status: "failed",
          error: json.error ?? "Test send failed",
          testedAt: json.testedAt,
        });
        toast({
          title: "Test send failed",
          description: json.error ?? "Unknown error",
          variant: "destructive",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTestResult({ status: "failed", error: message });
      toast({
        title: "Test send failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsTesting(false);
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        "Remove the peer SMTP config and fall back to the global federation relay? Federated-auth email is unaffected.",
      )
    ) {
      return;
    }
    setIsDeleting(true);
    try {
      const response = await fetch("/api/admin/smtp-config", {
        method: "DELETE",
      });
      if (!response.ok) {
        const json = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(json.error ?? `HTTP ${response.status}`);
      }
      setConfig(emptyConfig());
      setTestResult(null);
      toast({
        title: "Peer SMTP config removed",
        description: "Outgoing transactional email now routes through the global relay.",
      });
      router.refresh();
    } catch (error) {
      toast({
        title: "Could not remove config",
        description:
          error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center gap-4 mb-6">
        <Button
          variant="ghost"
          className="p-0"
          onClick={() => router.push("/settings")}
          aria-label={BACK_LABEL}
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-2xl font-bold">Outgoing SMTP</h1>
      </div>

      {/* Federated-auth rule callout — always visible */}
      <Alert className="mb-6">
        <Shield className="h-4 w-4" />
        <AlertTitle>Federated auth email always routes through global</AlertTitle>
        <AlertDescription>
          Signup verification, password-reset, and account recovery are
          always delivered by the global identity authority regardless of
          what you configure here. This page only controls <em>outgoing
          transactional</em> email (group broadcasts, login notifications,
          billing receipts) sent by this instance.
        </AlertDescription>
      </Alert>

      {!isPeerInstance && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>You are on the global instance</AlertTitle>
          <AlertDescription>
            The global instance already ships transactional email via its
            own SMTP. This page is intended for peer/sovereign instances
            (person, group, locale, region). Saving here will have no
            effect on the global mailer.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Peer outgoing SMTP
          </CardTitle>
          <CardDescription>
            Instance: <code>{initial.instanceSlug}</code> ({initial.instanceType})
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between rounded-md border p-4">
            <div className="space-y-0.5">
              <Label className="text-base">Enable peer outgoing SMTP</Label>
              <p className="text-sm text-muted-foreground">
                When off, outgoing transactional email for this peer falls
                through to the global federation relay.
              </p>
            </div>
            <Switch
              checked={config.enabled}
              onCheckedChange={(enabled) =>
                setConfig((c) => ({ ...c, enabled }))
              }
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="smtp-host">Host</Label>
              <Input
                id="smtp-host"
                placeholder="smtp.gmail.com"
                value={config.host}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, host: e.target.value }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="smtp-port">Port</Label>
              <Input
                id="smtp-port"
                type="number"
                min={1}
                max={65535}
                value={config.port}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, port: Number(e.target.value) }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="smtp-username">Username</Label>
              <Input
                id="smtp-username"
                placeholder="peer@example.com"
                value={config.username}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, username: e.target.value }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="smtp-from">From address</Label>
              <Input
                id="smtp-from"
                placeholder="peer@example.com"
                value={config.fromAddress}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, fromAddress: e.target.value }))
                }
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border p-4">
            <div className="space-y-0.5">
              <Label className="text-base">Implicit TLS (port 465)</Label>
              <p className="text-sm text-muted-foreground">
                Off uses STARTTLS (typical for port 587). On uses implicit
                TLS (typical for port 465).
              </p>
            </div>
            <Switch
              checked={config.secure}
              onCheckedChange={(secure) =>
                setConfig((c) => ({ ...c, secure }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="smtp-secret-ref">Password secret reference</Label>
            <Input
              id="smtp-secret-ref"
              placeholder={DEFAULT_PASSWORD_REF}
              value={config.passwordSecretRef}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  passwordSecretRef: e.target.value,
                }))
              }
            />
            <p className="text-sm text-muted-foreground">
              Never paste the actual password here. Provide either a{" "}
              <code>process.env</code> variable name (e.g.{" "}
              <code>{DEFAULT_PASSWORD_REF}</code>) or a Docker secret mount
              path (e.g. <code>/run/secrets/peer_smtp_password</code>). The
              password is read from that source at send time.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save configuration
            </Button>
            {hasSavedConfig && (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={isDeleting}
              >
                {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Trash2 className="mr-2 h-4 w-4" />
                Remove config
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-lg">Test send</CardTitle>
          <CardDescription>
            Verifies the SMTP handshake and, if a recipient is provided,
            sends a short test message to confirm credentials work.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
            <div className="space-y-2">
              <Label htmlFor="smtp-test-recipient">Recipient (optional)</Label>
              <Input
                id="smtp-test-recipient"
                placeholder={config.fromAddress || "you@example.com"}
                value={testRecipient}
                onChange={(e) => setTestRecipient(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Defaults to the configured from-address if left blank.
              </p>
            </div>
            <Button
              onClick={handleTest}
              disabled={isTesting || !hasSavedConfig}
            >
              {isTesting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send test email
            </Button>
          </div>

          {testResult && testResult.status === "ok" && (
            <Alert>
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertTitle>Test succeeded</AlertTitle>
              <AlertDescription>
                Sent to <code>{testResult.recipient}</code>.
                {testResult.messageId && (
                  <>
                    {" "}
                    Message id: <code>{testResult.messageId}</code>.
                  </>
                )}
                {testResult.testedAt && (
                  <>
                    {" "}
                    At {new Date(testResult.testedAt).toLocaleString()}.
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}

          {testResult && testResult.status === "failed" && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Test failed</AlertTitle>
              <AlertDescription>
                {testResult.error}
                {testResult.testedAt && (
                  <>
                    {" "}
                    (at {new Date(testResult.testedAt).toLocaleString()})
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
