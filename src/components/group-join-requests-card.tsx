"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { fetchGroupJoinRequests, reviewGroupJoinRequest } from "@/app/actions/group-access";
import { JoinRequestsManager } from "@/components/join-requests-manager";
import type { JoinRequest, User } from "@/lib/types";
import { useToast } from "@/components/ui/use-toast";

type GroupJoinRequestsCardProps = {
  groupId: string;
};

type RequestRecord = JoinRequest & {
  userName?: string;
  username?: string;
  avatar?: string;
};

export function GroupJoinRequestsCard({ groupId }: GroupJoinRequestsCardProps) {
  const { toast } = useToast();
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [, startTransition] = useTransition();

  const loadRequests = async () => {
    setIsLoading(true);
    const result = await fetchGroupJoinRequests(groupId);
    if (!result.success) {
      toast({
        title: "Could not load join requests",
        description: result.error ?? "Please try again.",
        variant: "destructive",
      });
      setIsLoading(false);
      return;
    }
    setRequests(result.requests ?? []);
    setIsLoading(false);
  };

  useEffect(() => {
    void loadRequests();
  }, [groupId]);

  const usersById = useMemo(() => {
    const map = new Map<string, User>();
    for (const request of requests) {
      map.set(request.userId, {
        id: request.userId,
        name: request.userName || request.userId,
        username: request.username || request.userId,
        avatar: request.avatar || "/placeholder-user.jpg",
        followers: 0,
        following: 0,
      });
    }
    return map;
  }, [requests]);

  const onReview = (requestId: string, decision: "approved" | "rejected", notes?: string) => {
    startTransition(async () => {
      const result = await reviewGroupJoinRequest(groupId, requestId, decision, notes);
      if (!result.success) {
        toast({
          title: `Could not ${decision === "approved" ? "approve" : "reject"} request`,
          description: result.error ?? "Please try again.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: decision === "approved" ? "Request approved" : "Request rejected",
      });
      await loadRequests();
    });
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading join requests...</div>;
  }

  return (
    <JoinRequestsManager
      groupId={groupId}
      requests={requests}
      getUser={(userId) => usersById.get(userId)}
      onApprove={(requestId, notes) => onReview(requestId, "approved", notes)}
      onReject={(requestId, notes) => onReview(requestId, "rejected", notes)}
    />
  );
}
