/**
 * @fileoverview GroupAccessDialog - Password-challenge dialog for protected groups.
 *
 * Displayed when a user attempts to access a group that requires a password.
 * Calls the `challengeGroupAccess` server action to verify the password and,
 * upon success, notifies the parent via `onAccessGranted` with the new membership ID.
 *
 * Key props: groupId, groupName, open, onOpenChange, onAccessGranted
 */
"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock, AlertCircle, CheckCircle2 } from "lucide-react";
import { challengeGroupAccess } from "@/app/actions/group-access";

interface GroupAccessDialogProps {
  groupId: string;
  groupName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccessGranted?: (membershipId: string, expiresAt: string) => void;
}

/**
 * Renders a password-entry dialog that verifies group access via a server action.
 *
 * @param {GroupAccessDialogProps} props
 * @param {string} props.groupId - ID of the password-protected group
 * @param {string} props.groupName - Display name shown in the dialog title
 * @param {boolean} props.open - Controlled dialog open state
 * @param {(open: boolean) => void} props.onOpenChange - Callback to toggle dialog visibility
 * @param {(membershipId: string, expiresAt: string) => void} [props.onAccessGranted] - Callback invoked after successful access
 */
export function GroupAccessDialog({
  groupId,
  groupName,
  open,
  onOpenChange,
  onAccessGranted,
}: GroupAccessDialogProps) {
  /** The password text the user has typed */
  const [password, setPassword] = useState("");
  /** Error message from a failed access attempt, or null */
  const [error, setError] = useState<string | null>(null);
  /** Whether the server action is currently in-flight */
  const [isLoading, setIsLoading] = useState(false);
  /** Brief success state shown before the dialog auto-closes */
  const [isSuccess, setIsSuccess] = useState(false);

  /**
   * Form submission handler: calls the `challengeGroupAccess` server action
   * with the group ID and password. On success, shows a brief confirmation
   * before closing the dialog. On failure, displays an error message.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const result = await challengeGroupAccess(groupId, password);

      if (!result.success) {
        setError(result.error ?? "Access denied.");
        setIsLoading(false);
        return;
      }

      setIsSuccess(true);
      setIsLoading(false);

      if (result.membershipId && result.expiresAt && onAccessGranted) {
        onAccessGranted(result.membershipId, result.expiresAt);
      }

      // Close dialog after a brief delay to show success state
      setTimeout(() => {
        setIsSuccess(false);
        setPassword("");
        onOpenChange(false);
      }, 1500);
    } catch {
      setError("An unexpected error occurred. Please try again.");
      setIsLoading(false);
    }
  };

  /** Resets local state (password, error, success) when the dialog is closed. */
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setPassword("");
      setError(null);
      setIsSuccess(false);
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Access {groupName}
          </DialogTitle>
          <DialogDescription>
            This group is password-protected. Enter the group password to gain
            membership access.
          </DialogDescription>
        </DialogHeader>

        {isSuccess ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle2 className="h-12 w-12 text-green-500" />
            <p className="text-sm font-medium text-green-700 dark:text-green-400">
              Access granted! You are now a member.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="group-password">Group Password</Label>
                <Input
                  id="group-password"
                  type="password"
                  placeholder="Enter group password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  disabled={isLoading}
                  autoFocus
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 text-sm text-red-500">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={isLoading}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading || password.length === 0}>
                {isLoading ? "Verifying..." : "Unlock Access"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
