"use client";

import { useState } from "react";
import type React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, Eye, EyeOff, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { signupAction } from "@/app/actions/auth";

const MINIMUM_PASSWORD_LENGTH = 8;

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [murmurationsPublishing, setMurmurationsPublishing] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    if (!name.trim() || !email.trim() || !password) {
      setError("Please fill in all required fields.");
      return;
    }

    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
      return;
    }

    setIsLoading(true);
    try {
      const result = await signupAction({
        name: name.trim(),
        email: email.trim(),
        password,
        emailNotifications,
        murmurationsPublishing,
        acceptedTerms,
      });

      if (!result.success) {
        setError(result.error || "Signup failed.");
        return;
      }

      router.push(`/auth/signup/verify?email=${encodeURIComponent(email.trim())}`);
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="p-4">
        <Link href="/auth/login">
          <ChevronLeft className="h-6 w-6" />
        </Link>
      </div>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col p-6">
        <div className="mb-8 space-y-3">
          <h1 className="text-3xl font-bold">Create your Rivr account</h1>
          <p className="text-muted-foreground">
            Join in one step. We&apos;ll send a verification email after signup and sign you in when you confirm it.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="signup-name">Full name</Label>
              <Input
                id="signup-name"
                name="name"
                placeholder="Your name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                disabled={isLoading}
                required
              />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="signup-email">Email</Label>
              <Input
                id="signup-email"
                name="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                disabled={isLoading}
                required
              />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="signup-password">Password</Label>
              <div className="relative">
                <Input
                  id="signup-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  placeholder={`At least ${MINIMUM_PASSWORD_LENGTH} characters`}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  disabled={isLoading}
                  required
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5 text-muted-foreground" />
                  ) : (
                    <Eye className="h-5 w-5 text-muted-foreground" />
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-4 rounded-xl border p-4">
            <div className="flex items-start gap-3">
              <Checkbox
                id="signup-email-notifications"
                checked={emailNotifications}
                onCheckedChange={(checked) => setEmailNotifications(checked === true)}
                className="mt-1"
              />
              <div className="space-y-1">
                <Label htmlFor="signup-email-notifications" className="text-sm font-medium">
                  Send me notification emails
                </Label>
                <p className="text-sm text-muted-foreground">
                  Receive account updates, reminders, and important community notifications by email.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Checkbox
                id="signup-murmurations-publishing"
                checked={murmurationsPublishing}
                onCheckedChange={(checked) => setMurmurationsPublishing(checked === true)}
                className="mt-1"
              />
              <div className="space-y-1">
                <Label htmlFor="signup-murmurations-publishing" className="text-sm font-medium">
                  Publish my eligible public profile to Murmurations
                </Label>
                <p className="text-sm text-muted-foreground">
                  If you choose this, Rivr can publish your eligible public profile and public objects to the Murmurations network.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Checkbox
                id="signup-accept-terms"
                checked={acceptedTerms}
                onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                className="mt-1"
              />
              <div className="space-y-1">
                <Label htmlFor="signup-accept-terms" className="text-sm font-medium">
                  I accept the Terms and Conditions
                </Label>
                <p className="text-sm text-muted-foreground">
                  By creating an account, you agree to the{" "}
                  <Link href="/auth/signup/terms" className="text-primary hover:underline">
                    Terms and Conditions
                  </Link>
                  .
                </p>
              </div>
            </div>
          </div>

          <Button
            type="submit"
            className="h-12 w-full text-base font-medium"
            disabled={isLoading || !name.trim() || !email.trim() || !password || !acceptedTerms}
          >
            {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Create account"}
          </Button>
        </form>

        <div className="mt-6 text-center">
          <Link href="/auth/login" className="text-primary hover:underline">
            I already have an account
          </Link>
        </div>
      </div>
    </div>
  );
}
