/**
 * @fileoverview GroupPasswordDialog - User-facing dialog to enter a group password for access.
 *
 * Shown when a user navigates to a password-protected group. Calls the
 * `challengeGroupAccess` server action and, on success, invokes `onAccessGranted`
 * before closing the dialog.
 *
 * Key props: groupId, groupName, open, onOpenChange, onAccessGranted
 */
"use client";

import { useState, useTransition, useCallback, type FormEvent } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Lock, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { challengeGroupAccess } from "@/app/actions/group-access";

// =============================================================================
// Constants
// =============================================================================

const PASSWORD_MIN_LENGTH = 1;

// =============================================================================
// Props
// =============================================================================

interface GroupPasswordDialogProps {
  groupId: string;
  groupName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccessGranted: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a dialog with a password input and verifies access via the `challengeGroupAccess` server action.
 *
 * @param {GroupPasswordDialogProps} props
 * @param {string} props.groupId - The protected group's identifier
 * @param {string} props.groupName - Display name shown in the dialog header
 * @param {boolean} props.open - Controlled open state
 * @param {(open: boolean) => void} props.onOpenChange - Toggle callback for dialog visibility
 * @param {() => void} props.onAccessGranted - Invoked after successful password verification
 */
export function GroupPasswordDialog({
  groupId,
  groupName,
  open,
  onOpenChange,
  onAccessGranted,
}: GroupPasswordDialogProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  const resetState = useCallback(() => {
    setPassword("");
    setError(null);
    setSuccess(false);
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        resetState();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, resetState]
  );

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);

      if (password.length < PASSWORD_MIN_LENGTH) {
        setError("Please enter the group password.");
        return;
      }

      startTransition(async () => {
        const result = await challengeGroupAccess(groupId, password);

        if (result.success) {
          setSuccess(true);
          // Brief delay so the user sees the success state before the dialog closes
          setTimeout(() => {
            onAccessGranted();
            handleOpenChange(false);
          }, 600);
        } else {
          setError(result.error ?? "Failed to verify password. Please try again.");
        }
      });
    },
    [password, groupId, onAccessGranted, handleOpenChange]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-muted-foreground" />
            Password Required
          </DialogTitle>
          <DialogDescription>
            Enter the password to access{" "}
            <span className="font-medium text-foreground">{groupName}</span>.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Error alert */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Success alert */}
          {success && (
            <Alert>
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-700">
                Access granted! Redirecting...
              </AlertDescription>
            </Alert>
          )}

          {/* Password input */}
          {!success && (
            <div className="space-y-2">
              <Label htmlFor="group-password">Group Password</Label>
              <Input
                id="group-password"
                type="password"
                placeholder="Enter group password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isPending}
                autoFocus
                autoComplete="off"
              />
            </div>
          )}

          <DialogFooter>
            {!success && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                  disabled={isPending}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isPending || password.length < PASSWORD_MIN_LENGTH}>
                  {isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    <>
                      <Lock className="h-4 w-4 mr-2" />
                      Submit
                    </>
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
