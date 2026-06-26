/**
 * Terms agreement step for `/auth/signup/terms`.
 *
 * Purpose:
 * - Summarizes the platform's Terms of Service and Privacy Policy and links to
 *   the full canonical documents at `/terms` and `/privacy`.
 * - Navigates back to the signup step where acceptance is stored and enforced.
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
          <Link href="/terms" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            Privacy Policy
          </Link>
          . The summaries below are for convenience only; the full documents govern your use of the Service.
        </p>

        <div className="space-y-4 text-sm text-muted-foreground">
          <section id="terms" className="scroll-mt-24">
            <h2 className="font-medium text-foreground">Terms of Service</h2>
            <p>
              You agree to use the platform responsibly, provide accurate account information, and respect other
              members and community spaces. Because RIVR is federated, content you make public or share may be
              transmitted to other instances and networks. You keep ownership of your content and grant RIVR a
              license to host, display, and federate it as needed to run the Service.{" "}
              <Link href="/terms" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                Read the full Terms of Service
              </Link>
              .
            </p>
          </section>
          <section id="privacy" className="scroll-mt-24">
            <h2 className="font-medium text-foreground">Privacy Policy</h2>
            <p>
              We collect account details, content you create, and usage data to operate, secure, and improve the
              Service, and to support login, verification, and recovery. Information you choose to share may federate
              to other instances. You can manage notification preferences and request deletion of your account.{" "}
              <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                Read the full Privacy Policy
              </Link>
              .
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
