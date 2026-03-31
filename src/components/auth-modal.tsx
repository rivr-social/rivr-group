"use client"

/**
 * Auth modal for unauthenticated purchase flows.
 *
 * Displays login/signup forms inside a Dialog, with a "Continue as guest"
 * escape hatch. After successful login the session cookie is set server-side
 * via `loginAction`, then `onAuthenticated` is called so the parent can
 * proceed with the purchase.
 */

import type React from "react"
import { useState } from "react"
import { Loader2, AlertCircle, Eye, EyeOff, CheckCircle2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { loginAction, signupAction } from "@/app/actions/auth"

// NIST SP 800-63B minimum
const MINIMUM_PASSWORD_LENGTH = 8

type AuthView = "login" | "signup"

interface AuthModalProps {
  open: boolean
  onClose: () => void
  onAuthenticated: () => void
  onGuestContinue: () => void
  context?: string
}

export function AuthModal({
  open,
  onClose,
  onAuthenticated,
  onGuestContinue,
  context,
}: AuthModalProps) {
  const [view, setView] = useState<AuthView>("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState("")
  const [signupSuccess, setSignupSuccess] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const resetForm = () => {
    setEmail("")
    setPassword("")
    setName("")
    setShowPassword(false)
    setError("")
    setSignupSuccess(false)
    setIsLoading(false)
  }

  const switchView = (nextView: AuthView) => {
    resetForm()
    setView(nextView)
  }

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      resetForm()
      setView("login")
      onClose()
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setIsLoading(true)

    try {
      const result = await loginAction(email, password)
      if (!result.success) {
        setError(result.error || "Invalid email or password.")
        return
      }
      // Session cookie is set server-side by loginAction.
      // Trigger a full page reload so the root layout re-runs auth() and
      // the session is available everywhere, then let the caller proceed.
      onAuthenticated()
    } catch {
      setError("An unexpected error occurred. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")

    if (!name.trim()) {
      setError("Name is required.")
      return
    }

    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`)
      return
    }

    setIsLoading(true)

    try {
      const result = await signupAction({ name: name.trim(), email, password })
      if (!result.success) {
        setError(result.error || "Signup failed.")
        return
      }
      setSignupSuccess(true)
    } catch {
      setError("An unexpected error occurred. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {context || (view === "login" ? "Log in to continue" : "Create an account")}
          </DialogTitle>
          <DialogDescription>
            {view === "login"
              ? "Sign in to your RIVR account to continue."
              : "Create a RIVR account to track your purchases."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Error display */}
          {error && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3">
              <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          {/* Signup success message */}
          {signupSuccess && (
            <div className="flex items-start gap-2 rounded-md bg-green-500/10 p-3">
              <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
              <p className="text-sm text-green-600">
                Check your email to verify your account, or continue as guest below.
              </p>
            </div>
          )}

          {/* Login form */}
          {view === "login" && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="auth-modal-email">Email</Label>
                <Input
                  id="auth-modal-email"
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
                <Label htmlFor="auth-modal-password">Password</Label>
                <div className="relative">
                  <Input
                    id="auth-modal-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pr-10"
                    disabled={isLoading}
                    required
                    autoComplete="current-password"
                    minLength={MINIMUM_PASSWORD_LENGTH}
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

              <Button
                type="submit"
                className="w-full"
                disabled={isLoading || !email || !password}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Log in"
                )}
              </Button>

              <p className="text-center text-sm text-muted-foreground">
                Don&apos;t have an account?{" "}
                <button
                  type="button"
                  className="text-primary hover:underline font-medium"
                  onClick={() => switchView("signup")}
                >
                  Sign up
                </button>
              </p>
            </form>
          )}

          {/* Signup form */}
          {view === "signup" && !signupSuccess && (
            <form onSubmit={handleSignup} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="auth-modal-name">Name</Label>
                <Input
                  id="auth-modal-name"
                  type="text"
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isLoading}
                  required
                  autoComplete="name"
                  maxLength={100}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="auth-modal-signup-email">Email</Label>
                <Input
                  id="auth-modal-signup-email"
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
                <Label htmlFor="auth-modal-signup-password">Password</Label>
                <div className="relative">
                  <Input
                    id="auth-modal-signup-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Create a password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pr-10"
                    disabled={isLoading}
                    required
                    autoComplete="new-password"
                    minLength={MINIMUM_PASSWORD_LENGTH}
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

              <Button
                type="submit"
                className="w-full"
                disabled={isLoading || !email || !password || !name.trim()}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Sign up"
                )}
              </Button>

              <p className="text-center text-sm text-muted-foreground">
                Already have an account?{" "}
                <button
                  type="button"
                  className="text-primary hover:underline font-medium"
                  onClick={() => switchView("login")}
                >
                  Log in
                </button>
              </p>
            </form>
          )}

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-background px-2 text-muted-foreground">or</span>
            </div>
          </div>

          {/* Guest continue */}
          <Button
            variant="outline"
            className="w-full"
            onClick={onGuestContinue}
            disabled={isLoading}
          >
            Continue as guest
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
