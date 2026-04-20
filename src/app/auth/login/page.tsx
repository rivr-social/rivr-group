/**
 * Login page for `/auth/login`.
 *
 * Purpose:
 * - Federation-aware entry point: tries the federated-SSO path first
 *   (global issues a signed assertion → this peer verifies + sets the
 *   `rivr_remote_viewer` cookie) and falls back to local NextAuth
 *   credentials when the user does not yet have a global
 *   `identity_authority` row (migration period for issues #101/#21).
 * - Local credentials path stays intact so users on peers that haven't
 *   been rolled onto federated SSO are unaffected.
 *
 * Rendering: Client Component (`"use client"`).
 * Data requirements: None on mount; submits credentials via
 *   `federatedLoginAction`, which internally falls back to `loginAction`.
 * Auth: This is the entry point for authentication; no auth gate.
 * Metadata: No `metadata` export; metadata is inherited from the layout.
 *
 * @module auth/login/page
 */
"use client";

import type React from "react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  EyeOff,
  Eye,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Globe,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { federatedLoginAction } from "@/app/actions/federated-login";
import { safeRedirectUrl } from "@/lib/safe-redirect";

/**
 * Client-rendered login form component.
 *
 * @returns Login card with email/password fields, optional home-instance
 *   hint, and a sign-in button that tries federated SSO with local
 *   credentials fallback.
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [homeBaseUrlHint, setHomeBaseUrlHint] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showHomeHint, setShowHomeHint] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [authBadge, setAuthBadge] = useState<{
    method: "federated-sso" | "local-credentials";
    homeBaseUrl?: string;
  } | null>(null);
  const searchParams = useSearchParams();
  const callbackUrl = safeRedirectUrl(searchParams.get("callbackUrl"));
  const isVerified = searchParams.get("verified") === "true";

  /**
   * Handles form submission: calls `federatedLoginAction` which tries
   * federated SSO first and falls back to local credentials on 401 so
   * users whose identity_authority row hasn't been provisioned yet
   * continue to authenticate locally during the signup migration.
   */
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setAuthBadge(null);
    setIsLoading(true);

    try {
      const result = await federatedLoginAction({
        email,
        password,
        homeBaseUrlHint: homeBaseUrlHint || undefined,
      });
      if (!result.success) {
        setError(result.error || "Invalid email or password.");
        return;
      }

      setAuthBadge({
        method: result.method,
        homeBaseUrl: result.homeBaseUrl,
      });

      // Full page reload ensures the root layout re-runs auth() server-side,
      // passing the fresh session to SessionProvider so avatar/user state
      // is immediately available without a second refresh.
      window.location.href = callbackUrl;
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-muted/40">
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center">
          <div className="w-16 h-16 rounded-2xl bg-primary flex items-center justify-center mb-4 shadow-md">
            <span className="text-primary-foreground text-2xl font-bold tracking-tight">R</span>
          </div>
        </div>

        {/* Login card */}
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Welcome back</CardTitle>
            <CardDescription>Sign in to your RIVR account</CardDescription>
          </CardHeader>

          <CardContent>
            {isVerified && (
              <div className="flex items-start gap-2 rounded-md bg-green-500/10 p-3 mb-4">
                <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                <p className="text-sm text-green-600">Email verified successfully! You can now log in.</p>
              </div>
            )}

            {authBadge && authBadge.method === "federated-sso" && (
              <div className="flex items-start gap-2 rounded-md bg-primary/10 p-3 mb-4">
                <Globe className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                <p className="text-sm text-primary">
                  Authenticated via{" "}
                  {authBadge.homeBaseUrl ?? "your home instance"}
                </p>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 mb-4">
                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <div className="space-y-2">
                  <p className="text-sm text-destructive">{error}</p>
                  {error.toLowerCase().includes("verify your email") && email && (
                    <Link
                      href={`/auth/signup/verify?email=${encodeURIComponent(email)}`}
                      className="inline-flex text-sm font-medium text-destructive underline underline-offset-4"
                    >
                      Resend verification email
                    </Link>
                  )}
                </div>
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isLoading}
                  required
                  autoComplete="email"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pr-10"
                    disabled={isLoading}
                    required
                    autoComplete="current-password"
                    minLength={8}
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              {showHomeHint ? (
                <div className="space-y-2">
                  <Label htmlFor="homeBaseUrlHint">Home instance (optional)</Label>
                  <Input
                    id="homeBaseUrlHint"
                    type="url"
                    placeholder="https://rivr.camalot.me"
                    value={homeBaseUrlHint}
                    onChange={(e) => setHomeBaseUrlHint(e.target.value)}
                    disabled={isLoading}
                    autoComplete="url"
                    inputMode="url"
                  />
                  <p className="text-xs text-muted-foreground">
                    Only needed if you know your sovereign home. Leave blank to
                    let us route you automatically.
                  </p>
                </div>
              ) : (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setShowHomeHint(true)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Have a home instance?
                  </button>
                </div>
              )}

              <div className="flex justify-end">
                <Link href="/auth/forgot-password" className="text-xs text-muted-foreground hover:text-foreground">
                  Forgot password?
                </Link>
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={isLoading || !email || !password}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Sign in"
                )}
              </Button>
            </form>
          </CardContent>

          <CardFooter className="flex flex-col gap-4">
            <div className="relative w-full">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-card px-2 text-muted-foreground">or</span>
              </div>
            </div>

            <Button variant="outline" className="w-full" asChild>
              <Link href="/auth/signup">Create new account</Link>
            </Button>
          </CardFooter>
        </Card>

        <p className="mt-8 text-xs text-muted-foreground">
          RIVR — Community, connected.
        </p>
      </div>
    </div>
  );
}
