"use client";

import { useState, useTransition } from "react";
import { Loader2, Mail, Send } from "lucide-react";
import { sendGroupBroadcastAction } from "@/app/actions/email";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";

type GroupBroadcastCardProps = {
  groupId: string;
  groupName: string;
};

export function GroupBroadcastCard({ groupId, groupName }: GroupBroadcastCardProps) {
  const { toast } = useToast();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [isPending, startTransition] = useTransition();

  const onSend = () => {
    startTransition(async () => {
      const result = await sendGroupBroadcastAction(groupId, subject, body);

      if (!result.success) {
        toast({
          title: "Could not send announcement",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        });
        return;
      }

      setSubject("");
      setBody("");
      const summary = [
        `${result.sent ?? 0} sent`,
        `${result.failed ?? 0} failed`,
        typeof result.skipped === "number" && result.skipped > 0 ? `${result.skipped} skipped` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      toast({
        title: "Announcement sent",
        description: summary || `Your ${groupName} members have been notified.`,
      });
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Email Announcements
        </CardTitle>
        <CardDescription>
          Send an email announcement to active members of {groupName}. Members who disabled email
          notifications globally are skipped.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="group-broadcast-subject">Subject</Label>
          <Input
            id="group-broadcast-subject"
            value={subject}
            maxLength={200}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Tonight's meeting moved to 7pm"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="group-broadcast-body">Message</Label>
          <Textarea
            id="group-broadcast-body"
            value={body}
            rows={8}
            maxLength={10000}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Share the update, agenda, or announcement you want members to receive."
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Replies go to the sender email on file when available.
          </p>
          <Button
            type="button"
            disabled={isPending || subject.trim().length === 0 || body.trim().length === 0}
            onClick={onSend}
          >
            {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Send announcement
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
