"use client";

/**
 * GroupMembershipButton shows a join/leave action for a group and synchronizes
 * membership state with server actions.
 * It is used on group-facing pages where the current user can toggle membership.
 *
 * Key props:
 * - `groupId`: target group identifier used for loading and mutating join state.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchJoinState, toggleJoinGroup } from "@/app/actions/interactions";
import { useToast } from "@/components/ui/use-toast";

/**
 * Membership toggle button with initial state fetch and optimistic UI locking.
 *
 * @param props - Component props containing the `groupId` to query/update.
 */
export function GroupMembershipButton({ groupId }: { groupId: string }) {
  const { toast } = useToast();
  // Current membership flag for the rendered group.
  const [joined, setJoined] = useState(false);
  // Tracks whether the initial membership lookup is still in flight.
  const [loadingState, setLoadingState] = useState(true);
  // Prevents duplicate toggle submissions while mutation is pending.
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // Cancellation guard prevents state updates after unmount or groupId changes.
    let cancelled = false;
    // Server action call: fetches current user's join state for this group.
    fetchJoinState(groupId)
      .then((state) => {
        if (cancelled) return;
        setJoined(state.joined);
      })
      .catch(() => {
        if (cancelled) return;
        // Fallback state when lookup fails.
        setJoined(false);
      })
      .finally(() => {
        // Side effect: clears initial loading lock after request completion.
        if (!cancelled) setLoadingState(false);
      });

    // Cleanup flips cancellation guard for in-flight promise handlers.
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const onToggle = async () => {
    // Side effect: mark UI as pending to disable repeated clicks.
    setPending(true);
    try {
      // Server action call: toggles membership for the current group.
      const result = await toggleJoinGroup(groupId, "group");
      if (!result.success) {
        toast({ title: "Could not update membership", description: result.message, variant: "destructive" });
        return;
      }
      // Apply server-confirmed active state and show completion feedback.
      setJoined(Boolean(result.active));
      toast({ title: result.active ? "Joined group" : "Left group", description: result.message });
    } finally {
      // Always clear pending state regardless of success/failure.
      setPending(false);
    }
  };

  return (
    <Button onClick={() => void onToggle()} disabled={pending || loadingState}>
      {/* Label reflects pending mutation state first, then joined/unjoined state. */}
      {pending ? "Updating..." : joined ? "Leave Group" : "Join Group"}
    </Button>
  );
}
