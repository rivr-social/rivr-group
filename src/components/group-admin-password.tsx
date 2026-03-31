/**
 * @fileoverview GroupAdminPassword - Admin UI for managing group password protection.
 *
 * Rendered inside the group admin settings panel. Allows administrators to set,
 * update, or remove a password that new members must enter before joining the group.
 * Uses the `setGroupPassword` and `removeGroupPassword` server actions.
 *
 * Key props: groupId, hasPassword
 */
"use client";

import { useState, useTransition, useCallback, type FormEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Lock,
  LockOpen,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ShieldCheck,
  Eye,
  EyeOff,
} from "lucide-react";
import { setGroupPassword, removeGroupPassword } from "@/app/actions/group-admin";

// =============================================================================
// Constants
// =============================================================================

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;

// =============================================================================
// Props
// =============================================================================

interface GroupAdminPasswordProps {
  groupId: string;
  hasPassword: boolean;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a card with a password form for setting/updating/removing group password protection.
 *
 * @param {GroupAdminPasswordProps} props
 * @param {string} props.groupId - The group whose password is being managed
 * @param {boolean} props.hasPassword - Whether the group currently has a password set
 */
export function GroupAdminPassword({ groupId, hasPassword: initialHasPassword }: GroupAdminPasswordProps) {
  const [hasPassword, setHasPassword] = useState(initialHasPassword);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const resetForm = useCallback(() => {
    setNewPassword("");
    setConfirmPassword("");
    setShowNewPassword(false);
    setShowConfirmPassword(false);
    setError(null);
  }, []);

  const clearMessages = useCallback(() => {
    setError(null);
    setSuccessMessage(null);
  }, []);

  const handleSetPassword = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      clearMessages();

      // Client-side validation
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }

      if (newPassword.length > MAX_PASSWORD_LENGTH) {
        setError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
        return;
      }

      if (newPassword !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }

      startTransition(async () => {
        const result = await setGroupPassword(groupId, newPassword);

        if (result.success) {
          setHasPassword(true);
          setSuccessMessage(
            hasPassword
              ? "Group password updated successfully."
              : "Group password has been set. Members will now need a password to join."
          );
          resetForm();
        } else {
          setError(result.error ?? "Failed to set group password.");
        }
      });
    },
    [newPassword, confirmPassword, groupId, hasPassword, clearMessages, resetForm]
  );

  const handleRemovePassword = useCallback(() => {
    clearMessages();

    startTransition(async () => {
      const result = await removeGroupPassword(groupId);

      if (result.success) {
        setHasPassword(false);
        setSuccessMessage("Password protection has been removed from this group.");
        resetForm();
      } else {
        setError(result.error ?? "Failed to remove group password.");
      }
    });
  }, [groupId, clearMessages, resetForm]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            Password Protection
          </CardTitle>
          <Badge
            variant={hasPassword ? "default" : "outline"}
            className={
              hasPassword
                ? "bg-green-100 text-green-800"
                : "text-muted-foreground"
            }
          >
            {hasPassword ? (
              <span className="flex items-center gap-1">
                <Lock className="h-3 w-3" />
                Enabled
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <LockOpen className="h-3 w-3" />
                Disabled
              </span>
            )}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Status description */}
        <p className="text-sm text-muted-foreground">
          {hasPassword
            ? "This group requires a password for new members to join. You can update the password or remove protection."
            : "This group is not password-protected. Set a password to require new members to enter it before joining."}
        </p>

        {/* Success alert */}
        {successMessage && (
          <Alert>
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-700">
              {successMessage}
            </AlertDescription>
          </Alert>
        )}

        {/* Error alert */}
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Password form */}
        <form onSubmit={handleSetPassword} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-group-password">
              {hasPassword ? "New Password" : "Group Password"}
            </Label>
            <div className="relative">
              <Input
                id="new-group-password"
                type={showNewPassword ? "text" : "password"}
                placeholder={`Minimum ${MIN_PASSWORD_LENGTH} characters`}
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  clearMessages();
                }}
                disabled={isPending}
                autoComplete="new-password"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                onClick={() => setShowNewPassword(!showNewPassword)}
                tabIndex={-1}
              >
                {showNewPassword ? (
                  <EyeOff className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Eye className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-group-password">Confirm Password</Label>
            <div className="relative">
              <Input
                id="confirm-group-password"
                type={showConfirmPassword ? "text" : "password"}
                placeholder="Re-enter the password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  clearMessages();
                }}
                disabled={isPending}
                autoComplete="new-password"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                tabIndex={-1}
              >
                {showConfirmPassword ? (
                  <EyeOff className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Eye className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>
            </div>
          </div>

          {/* Inline password strength hint */}
          {newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH && (
            <p className="text-xs text-muted-foreground">
              {MIN_PASSWORD_LENGTH - newPassword.length} more character
              {MIN_PASSWORD_LENGTH - newPassword.length !== 1 ? "s" : ""} needed.
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button
              type="submit"
              disabled={
                isPending ||
                newPassword.length < MIN_PASSWORD_LENGTH ||
                confirmPassword.length === 0
              }
            >
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Lock className="h-4 w-4 mr-2" />
                  {hasPassword ? "Update Password" : "Set Password"}
                </>
              )}
            </Button>

            {hasPassword && (
              <Button
                type="button"
                variant="outline"
                onClick={handleRemovePassword}
                disabled={isPending}
                className="text-destructive hover:text-destructive"
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Removing...
                  </>
                ) : (
                  <>
                    <LockOpen className="h-4 w-4 mr-2" />
                    Remove Password
                  </>
                )}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
