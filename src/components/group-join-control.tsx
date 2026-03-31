"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Loader2, Lock, UserPlus } from "lucide-react";
import { requestGroupMembership, fetchGroupJoinRuntime } from "@/app/actions/group-access";
import { toggleJoinGroup } from "@/app/actions/interactions";
import { JoinType, type GroupJoinSettings, type JoinQuestion } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/components/ui/use-toast";

type GroupJoinControlProps = {
  groupId: string;
  groupName: string;
  joinSettings?: GroupJoinSettings;
  initiallyJoined: boolean;
};

export function GroupJoinControl({
  groupId,
  groupName,
  joinSettings,
  initiallyJoined,
}: GroupJoinControlProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [joined, setJoined] = useState(initiallyJoined);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const inviteToken = searchParams.get("invite") ?? searchParams.get("token") ?? undefined;
  const questions = joinSettings?.questions ?? [];
  const requiresApproval =
    joinSettings?.joinType === JoinType.ApprovalRequired ||
    joinSettings?.joinType === JoinType.InviteAndApply ||
    Boolean(joinSettings?.approvalRequired);
  const requiresPassword = Boolean(joinSettings?.passwordRequired);
  const inviteOnly =
    joinSettings?.joinType === JoinType.InviteOnly || joinSettings?.joinType === JoinType.InviteAndApply;
  const requiresDialog = requiresPassword || requiresApproval || questions.length > 0;

  useEffect(() => {
    let cancelled = false;
    fetchGroupJoinRuntime(groupId)
      .then((state) => {
        if (cancelled) return;
        setJoined(state.joined);
        setPendingRequestId(state.pendingRequestId ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setPendingRequestId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const ctaLabel = useMemo(() => {
    if (joined) return "Leave Group";
    if (pendingRequestId) return "Request Pending";
    if (requiresApproval) return "Apply to Join";
    if (inviteOnly && !inviteToken) return "Invite Required";
    return "Join Group";
  }, [inviteOnly, inviteToken, joined, pendingRequestId, requiresApproval]);

  const onPrimaryAction = () => {
    if (joined) {
      startTransition(async () => {
        const result = await toggleJoinGroup(groupId, "group");
        if (!result.success) {
          toast({ title: "Could not leave group", description: result.message, variant: "destructive" });
          return;
        }
        setJoined(false);
        setPendingRequestId(null);
        toast({ title: "Left group", description: result.message });
        router.refresh();
      });
      return;
    }

    if (pendingRequestId) return;
    if (inviteOnly && !inviteToken) {
      toast({
        title: "Invite required",
        description: "This group requires a valid invite link before you can join.",
        variant: "destructive",
      });
      return;
    }

    if (!requiresDialog) {
      submitJoin();
      return;
    }

    setShowDialog(true);
  };

  const submitJoin = () => {
    setError(null);
    const validationErrors = questions
      .filter((question) => question.required && !String(answers[question.id] ?? "").trim())
      .map((question) => question.label || question.question);

    if (validationErrors.length > 0) {
      setError("Please answer all required questions.");
      return;
    }

    if (requiresPassword && password.trim().length === 0) {
      setError("Please enter the group password.");
      return;
    }

    startTransition(async () => {
      const result = await requestGroupMembership(groupId, {
        answers: Object.entries(answers).map(([questionId, answer]) => ({ questionId, answer })),
        password: password.trim() || undefined,
        inviteToken,
      });

      if (!result.success) {
        setError(result.error ?? "Could not process your request.");
        return;
      }

      setShowDialog(false);
      setPassword("");
      setAnswers({});
      if (result.status === "requested") {
        setPendingRequestId(result.requestId ?? "pending");
        toast({
          title: "Application submitted",
          description: "An admin will review your request.",
        });
      } else {
        setJoined(true);
        setPendingRequestId(null);
        toast({
          title: "Joined group",
          description: "You now have access to this group.",
        });
      }
      router.refresh();
    });
  };

  const renderQuestion = (question: JoinQuestion) => {
    const label = question.label || question.question;
    switch (question.type) {
      case "textarea":
        return (
          <div key={question.id} className="space-y-2">
            <Label htmlFor={question.id}>{label}{question.required ? " *" : ""}</Label>
            <Textarea
              id={question.id}
              value={answers[question.id] || ""}
              onChange={(event) => setAnswers((prev) => ({ ...prev, [question.id]: event.target.value }))}
              rows={4}
            />
          </div>
        );
      case "checkbox":
        return (
          <div key={question.id} className="space-y-2">
            <div className="flex items-center space-x-2">
              <Checkbox
                id={question.id}
                checked={answers[question.id] === "true"}
                onCheckedChange={(checked) =>
                  setAnswers((prev) => ({ ...prev, [question.id]: checked ? "true" : "false" }))
                }
              />
              <Label htmlFor={question.id}>{label}{question.required ? " *" : ""}</Label>
            </div>
          </div>
        );
      case "radio":
      case "multipleChoice":
        return (
          <div key={question.id} className="space-y-2">
            <Label>{label}{question.required ? " *" : ""}</Label>
            <RadioGroup
              value={answers[question.id]}
              onValueChange={(value) => setAnswers((prev) => ({ ...prev, [question.id]: value }))}
            >
              {question.options?.map((option) => {
                const normalized = typeof option === "string" ? { value: option, label: option } : option;
                return (
                  <div key={normalized.value} className="flex items-center space-x-2">
                    <RadioGroupItem value={normalized.value} id={`${question.id}-${normalized.value}`} />
                    <Label htmlFor={`${question.id}-${normalized.value}`}>{normalized.label}</Label>
                  </div>
                );
              })}
            </RadioGroup>
          </div>
        );
      case "text":
      default:
        return (
          <div key={question.id} className="space-y-2">
            <Label htmlFor={question.id}>{label}{question.required ? " *" : ""}</Label>
            <Input
              id={question.id}
              value={answers[question.id] || ""}
              onChange={(event) => setAnswers((prev) => ({ ...prev, [question.id]: event.target.value }))}
            />
          </div>
        );
    }
  };

  return (
    <>
      <Button onClick={onPrimaryAction} disabled={isPending || Boolean(pendingRequestId)}>
        {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
        {ctaLabel}
      </Button>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{requiresApproval ? `Apply to join ${groupName}` : `Join ${groupName}`}</DialogTitle>
            <DialogDescription>
              {requiresApproval
                ? "Complete the information below so an admin can review your request."
                : "Complete the information below to join this group."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {joinSettings?.applicationInstructions ? (
              <p className="text-sm text-muted-foreground">{joinSettings.applicationInstructions}</p>
            ) : null}

            {requiresPassword ? (
              <div className="space-y-2">
                <Label htmlFor="group-password">
                  <span className="inline-flex items-center gap-2">
                    <Lock className="h-4 w-4" />
                    Group password
                  </span>
                </Label>
                <Input
                  id="group-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter the group password"
                />
              </div>
            ) : null}

            {questions.map((question) => renderQuestion(question))}

            {error ? (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={submitJoin} disabled={isPending}>
              {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {requiresApproval ? "Submit application" : "Join group"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
