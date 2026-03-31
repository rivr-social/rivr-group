/**
 * Terms agreement step for `/auth/signup/terms`.
 *
 * Purpose:
 * - Displays the platform's Terms, Privacy Policy, and EULA for user acceptance.
 * - Navigates to `/auth/signup/login-method` when the user agrees.
 *
 * Rendering: Client Component (`"use client"`).
 * Data requirements: None.
 * Auth: No auth gate (this is a signup flow).
 * Metadata: No `metadata` export; metadata is inherited from the layout.
 *
 * @module auth/signup/terms/page
 */
"use client"
import { Button } from "@/components/ui/button"
import { ChevronLeft } from "lucide-react"
import { useRouter } from "next/navigation"
import Link from "next/link"

/**
 * Client-rendered terms agreement page.
 *
 * @returns Terms content with an "I agree" CTA.
 */
export default function TermsPage() {
  const router = useRouter()

  /** Returns to the signup step where acceptance is stored and enforced. */
  const handleAgree = () => {
    router.push("/auth/signup/email")
  }

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <div className="p-4">
        <Link href="/auth/signup/save-login">
          <ChevronLeft className="h-6 w-6" />
        </Link>
      </div>
      <div className="flex-1 flex flex-col p-6">
        <h1 className="text-2xl font-bold mb-4">Review RIVR&apos;s terms and policies</h1>
        <p className="text-gray-600 mb-6">Review the terms below, then return to signup to accept them and create your account.</p>

        <p className="mb-6">
          By creating an account, you agree to RIVR&apos;s{" "}
          <Link href="#terms" className="text-primary hover:underline">
            Terms and Conditions
          </Link>
          ,{" "}
          <Link href="#privacy" className="text-primary hover:underline">
            Privacy Policy
          </Link>
          , and{" "}
          <Link href="#eula" className="text-primary hover:underline">
            EULA
          </Link>
          .
        </p>

        <div className="space-y-4 text-sm text-muted-foreground">
          <section id="terms" className="scroll-mt-24">
            <h2 className="font-medium text-foreground">Terms and Conditions</h2>
            <p>
              You agree to use the platform responsibly, provide accurate account information, and respect
              other members and community spaces.
            </p>
          </section>
          <section id="privacy" className="scroll-mt-24">
            <h2 className="font-medium text-foreground">Privacy Policy</h2>
            <p>
              We use signup details like email, birthday, and phone to operate your account, improve safety, and
              support login, verification, and recovery flows.
            </p>
          </section>
          <section id="eula" className="scroll-mt-24">
            <h2 className="font-medium text-foreground">EULA</h2>
            <p>
              Your use of the application is subject to the product rules and any future updates delivered through the
              service.
            </p>
          </section>
        </div>

        <div className="mt-auto">
          <Button onClick={handleAgree} className="w-full h-14 text-base font-medium">
            Return to signup
          </Button>
        </div>
      </div>

      <div className="p-6 text-center">
        <Link href="/auth/login" className="text-primary hover:underline">
          I already have an account
        </Link>
      </div>
    </div>
  )
}
