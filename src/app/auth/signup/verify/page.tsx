"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { requestVerificationEmailAction } from "@/app/actions/auth";

export default function VerifyEmailPage() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";
  const [isResending, setIsResending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const maskedEmail = (() => {
    if (!email || !email.includes("@")) return "";
    const [localPart, domain] = email.split("@");
    if (!localPart || !domain) return "";
    const visible = localPart.slice(0, Math.min(2, localPart.length));
    return `${visible}${"*".repeat(Math.max(localPart.length - visible.length, 1))}@${domain}`;
  })();

  const handleResend = async () => {
    setError("");
    setSuccess("");
    setIsResending(true);

    try {
      const result = await requestVerificationEmailAction(email);
      if (!result.success) {
        setError(result.error || "Failed to resend verification email.");
        return;
      }

      setSuccess(
        email
          ? `If an unverified account exists for ${email}, we sent a fresh verification link.`
          : "If an unverified account exists for that email, we sent a fresh verification link."
      );
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background p-6 text-center">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
        <Mail className="h-8 w-8 text-primary" />
      </div>
      <h1 className="text-2xl font-bold mb-2">Check your email</h1>
      <p className="text-muted-foreground mb-6 max-w-sm">
        We sent a verification link to your email address. Click the link to
        verify your account, then log in.
      </p>
      {maskedEmail && (
        <p className="text-sm font-medium mb-6">{maskedEmail}</p>
      )}
      {error && (
        <p className="mb-4 max-w-sm text-sm text-destructive">{error}</p>
      )}
      {success && (
        <p className="mb-4 max-w-sm text-sm text-emerald-700">{success}</p>
      )}
      <div className="mb-3 flex flex-col gap-3 sm:flex-row">
        <Button
          variant="secondary"
          onClick={handleResend}
          disabled={isResending || !email}
        >
          {isResending ? "Resending..." : "Resend verification email"}
        </Button>
        {!email && (
          <Button asChild variant="outline">
            <Link href="/auth/signup">Back to Signup</Link>
          </Button>
        )}
      </div>
      <Button asChild variant="outline">
        <Link href="/auth/login">Go to Login</Link>
      </Button>
    </div>
  );
}
