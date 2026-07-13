"use client";

/**
 * Guided messenger login dialog (mautrix bridges).
 *
 * Walks an admin through linking Telegram / WhatsApp / Signal / etc. by
 * driving the `/api/connectors/bridge` provisioning flow: render a QR (built
 * from the bridge's login URI) or a phone/code form, long-poll while the user
 * completes the scan on their phone, then confirm. No tokens are ever pasted.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

interface StepField {
  id: string;
  name: string;
  type: string;
  description?: string;
}

interface BridgeStep {
  type: "display_and_wait" | "user_input" | "cookies" | "complete";
  loginId: string;
  stepId: string;
  instructions: string | null;
  display: { type: string; data?: string; image_url?: string } | null;
  fields: StepField[] | null;
  complete: { name: string } | null;
}

interface BridgeLoginDialogProps {
  provider: string;
  providerLabel: string;
  targetAgentId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}

export function BridgeLoginDialog({
  provider,
  providerLabel,
  targetAgentId,
  open,
  onOpenChange,
  onConnected,
}: BridgeLoginDialogProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<BridgeStep | null>(null);
  const [hint, setHint] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [done, setDone] = useState(false);
  const activeRef = useRef(false);

  const post = useCallback(
    async (payload: Record<string, unknown>) => {
      const response = await fetch("/api/connectors/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetAgentId, provider, ...payload }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Bridge login failed.");
      return data as { step: BridgeStep; hint?: string; loginKind?: string };
    },
    [targetAgentId, provider],
  );

  const applyStep = useCallback(
    (next: BridgeStep) => {
      setStep(next);
      setInputs({});
      setQrDataUrl(null);
      if (next.type === "complete") {
        setDone(true);
        setWaiting(false);
        return;
      }
      if (next.type === "display_and_wait" && next.display?.type === "qr" && next.display.data) {
        void QRCode.toDataURL(next.display.data, { margin: 1, width: 240 })
          .then(setQrDataUrl)
          .catch(() => setQrDataUrl(null));
      }
    },
    [],
  );

  // Long-poll a display_and_wait step until the external login resolves.
  const waitForCompletion = useCallback(
    async (current: BridgeStep) => {
      setWaiting(true);
      for (let attempt = 0; attempt < 60 && activeRef.current; attempt += 1) {
        try {
          const data = await post({
            action: "submit",
            loginId: current.loginId,
            stepId: current.stepId,
            stepType: current.type,
          });
          if (!activeRef.current) return;
          if (data.step.type !== current.type || data.step.stepId !== current.stepId) {
            applyStep(data.step);
            if (data.step.type !== "display_and_wait") return;
            current = data.step;
          }
        } catch (error) {
          if (!activeRef.current) return;
          toast({
            title: "Login didn't finish",
            description: error instanceof Error ? error.message : String(error),
            variant: "destructive",
          });
          setWaiting(false);
          return;
        }
      }
      setWaiting(false);
    },
    [post, applyStep, toast],
  );

  // Kick off the flow when the dialog opens.
  useEffect(() => {
    if (!open) return;
    activeRef.current = true;
    setStep(null);
    setDone(false);
    setQrDataUrl(null);
    setInputs({});
    setBusy(true);
    post({ action: "start" })
      .then((data) => {
        if (!activeRef.current) return;
        setHint(data.hint ?? "");
        applyStep(data.step);
        if (data.step.type === "display_and_wait") void waitForCompletion(data.step);
      })
      .catch((error) => {
        if (!activeRef.current) return;
        toast({
          title: `Couldn't start ${providerLabel} login`,
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
        onOpenChange(false);
      })
      .finally(() => activeRef.current && setBusy(false));
    return () => {
      activeRef.current = false;
    };
  }, [open, post, applyStep, waitForCompletion, providerLabel, toast, onOpenChange]);

  useEffect(() => {
    if (done) {
      toast({ title: `${providerLabel} connected` });
      onConnected();
    }
  }, [done, providerLabel, toast, onConnected]);

  const submitInputs = async () => {
    if (!step) return;
    setBusy(true);
    try {
      const data = await post({
        action: "submit",
        loginId: step.loginId,
        stepId: step.stepId,
        stepType: step.type,
        inputs,
      });
      applyStep(data.step);
      if (data.step.type === "display_and_wait") void waitForCompletion(data.step);
    } catch (error) {
      toast({
        title: "That didn't work",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect {providerLabel}</DialogTitle>
          {hint ? <DialogDescription>{hint}</DialogDescription> : null}
        </DialogHeader>

        <div className="space-y-4 py-2">
          {busy && !step ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Preparing…
            </div>
          ) : null}

          {done ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <CheckCircle2 className="h-10 w-10 text-emerald-600" />
              <p className="font-medium">{providerLabel} is connected.</p>
              {step?.complete?.name ? (
                <p className="text-sm text-muted-foreground">Signed in as {step.complete.name}</p>
              ) : null}
              <Button className="mt-2" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          ) : null}

          {!done && step?.type === "display_and_wait" ? (
            <div className="flex flex-col items-center gap-3">
              {step.instructions ? (
                <p className="text-sm text-muted-foreground text-center">{step.instructions}</p>
              ) : null}
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt="Login QR code" className="rounded-md border" width={240} height={240} />
              ) : step.display?.data ? (
                <code className="break-all rounded-md border bg-muted px-3 py-2 text-sm">{step.display.data}</code>
              ) : null}
              {waiting ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Waiting for you to finish on your phone…
                </div>
              ) : null}
            </div>
          ) : null}

          {!done && step?.type === "user_input" && step.fields ? (
            <div className="space-y-3">
              {step.instructions ? <p className="text-sm text-muted-foreground">{step.instructions}</p> : null}
              {step.fields.map((field) => (
                <div key={field.id} className="space-y-1">
                  <Label htmlFor={`bridge-${field.id}`}>{field.name}</Label>
                  <Input
                    id={`bridge-${field.id}`}
                    type={field.type === "password" || field.type === "2fa_code" ? "password" : "text"}
                    inputMode={field.type === "phone_number" ? "tel" : undefined}
                    value={inputs[field.id] ?? ""}
                    onChange={(event) => setInputs((prev) => ({ ...prev, [field.id]: event.target.value }))}
                  />
                  {field.description ? (
                    <p className="text-xs text-muted-foreground">{field.description}</p>
                  ) : null}
                </div>
              ))}
              <Button onClick={() => void submitInputs()} disabled={busy} className="w-full">
                {busy ? "Submitting…" : "Continue"}
              </Button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
