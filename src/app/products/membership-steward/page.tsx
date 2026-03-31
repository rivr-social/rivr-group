/**
 * Steward membership product page for `/products/membership-steward`.
 *
 * Purpose:
 * - Markets the Steward membership tier (highest tier) with governance rights,
 *   cooperative ownership, and a checkout card with monthly/yearly billing toggle.
 * - Initiates Stripe checkout via `createCheckoutAction("steward", billingPeriod)`.
 *
 * Rendering: Client Component (`"use client"`).
 * Data requirements: None on mount; checkout triggers a server action.
 * Auth: No explicit auth gate; billing action handles unauthenticated users.
 * Metadata: No `metadata` export; metadata is inherited from the layout.
 *
 * @module products/membership-steward/page
 */
"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Check, Star, Crown, Shield, Vote, Loader2 } from "lucide-react"
import Link from "next/link"
import { createCheckoutAction } from "@/app/actions/billing"
import { getMembershipConnectSurchargeDollars } from "@/lib/membership-pricing"

/**
 * Client-rendered Steward membership landing and checkout page.
 *
 * @returns Marketing content and a billing checkout card for the Steward tier.
 */
export default function StewardMembershipPage() {
  const [billingPeriod, setBillingPeriod] = useState<"monthly" | "yearly">("monthly")
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const pricing = {
    monthly: { price: 39 + getMembershipConnectSurchargeDollars("monthly"), total: 39 + getMembershipConnectSurchargeDollars("monthly"), savings: null },
    yearly: { price: 32 + getMembershipConnectSurchargeDollars("monthly"), total: 389 + getMembershipConnectSurchargeDollars("yearly"), savings: 79 }
  }

  const features = [
    "All previous membership tier features",
    "Platform governance voting rights",
    "Steward shares in the cooperative",
    "Access to cooperative financial reports",
    "Participation in annual general meetings",
    "Priority in platform development decisions",
    "Early access to new features and beta testing",
    "Direct communication with development team",
    "Influence on platform roadmap and strategy",
    "Profit-sharing opportunities",
    "Exclusive steward-only community forums",
    "Recognition as a cooperative steward"
  ]

  /** Initiates the Stripe checkout session for the Steward tier and redirects on success. */
  const handleSubscribe = () => {
    setError(null)
    startTransition(async () => {
      const result = await createCheckoutAction("steward", billingPeriod)
      if (result.success && result.url) {
        window.location.href = result.url
      } else {
        setError(result.error ?? "Something went wrong. Please try again.")
      }
    })
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-4">
            <div className="w-12 h-12 rounded-lg bg-yellow-100 flex items-center justify-center">
              <Crown className="h-6 w-6 text-yellow-600" />
            </div>
            <Badge className="bg-yellow-100 text-yellow-800">STEWARD MEMBERSHIP</Badge>
          </div>
          <h1 className="text-4xl font-bold mb-4">Steward Membership</h1>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Platform governance rights and steward shares in the cooperative
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-5 w-5" />
                  What&apos;s Included
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {features.map((feature, index) => (
                    <div key={index} className="flex items-start gap-3">
                      <Check className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
                      <span className="text-sm">{feature}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Vote className="h-5 w-5" />
                  Perfect For
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <Star className="h-4 w-4 text-yellow-500 mt-1" />
                    <div>
                      <h4 className="font-medium">Platform Champions</h4>
                      <p className="text-sm text-muted-foreground">Long-term users who want to shape the platform&apos;s future</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Star className="h-4 w-4 text-yellow-500 mt-1" />
                    <div>
                      <h4 className="font-medium">Cooperative Leaders</h4>
                      <p className="text-sm text-muted-foreground">Experienced cooperative members and movement leaders</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Star className="h-4 w-4 text-yellow-500 mt-1" />
                    <div>
                      <h4 className="font-medium">Strategic Partners</h4>
                      <p className="text-sm text-muted-foreground">Organizations seeking deep partnership and governance participation</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-yellow-200 bg-yellow-50/50">
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-8 h-8 rounded-full bg-yellow-100 flex items-center justify-center">
                    <Crown className="h-4 w-4 text-yellow-600" />
                  </div>
                  <h3 className="font-semibold text-yellow-900">Become a Cooperative Steward</h3>
                </div>
                <p className="text-sm text-yellow-800 mb-3">
                  As a steward, you&apos;re not just a user—you&apos;re a co-owner with real decision-making power
                  in how this platform evolves to serve our communities.
                </p>
                <div className="flex items-start gap-2 text-sm text-yellow-800">
                  <Shield className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <span>Steward shares represent ownership in the cooperative and may appreciate in value as the platform grows.</span>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="border-2 border-yellow-200">
              <CardHeader className="text-center">
                <CardTitle>Membership Checkout</CardTitle>
                <div className="flex items-center justify-center gap-2 mt-4">
                  <div className="w-12 h-12 rounded-lg bg-yellow-100 flex items-center justify-center">
                    <Crown className="h-6 w-6 text-yellow-600" />
                  </div>
                  <Badge className="bg-yellow-100 text-yellow-800">Steward</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-center">
                    <div className="flex bg-muted rounded-lg p-1">
                      <button
                        onClick={() => setBillingPeriod("monthly")}
                        className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                          billingPeriod === "monthly"
                            ? "bg-background shadow-sm"
                            : "text-muted-foreground"
                        }`}
                      >
                        Monthly
                      </button>
                      <button
                        onClick={() => setBillingPeriod("yearly")}
                        className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                          billingPeriod === "yearly"
                            ? "bg-background shadow-sm"
                            : "text-muted-foreground"
                        }`}
                      >
                        Yearly
                      </button>
                    </div>
                  </div>

                  <div className="text-center">
                    <div className="text-3xl font-bold">
                      ${pricing[billingPeriod].price}
                      <span className="text-lg font-normal text-muted-foreground">
                        /{billingPeriod === "monthly" ? "month" : "month"}
                      </span>
                    </div>
                    {billingPeriod === "yearly" && (
                      <div className="text-sm text-muted-foreground mt-1">
                        Billed ${pricing.yearly.total} yearly • Save ${pricing.yearly.savings}
                      </div>
                    )}
                  </div>

                  {error && (
                    <p className="text-sm text-red-600 text-center">{error}</p>
                  )}

                  <Button
                    className="w-full"
                    size="lg"
                    onClick={handleSubscribe}
                    disabled={isPending}
                  >
                    {isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Redirecting...
                      </>
                    ) : (
                      "Become a Steward"
                    )}
                  </Button>

                  <p className="text-xs text-muted-foreground text-center">
                    Join the cooperative governance and help shape our shared future
                  </p>
                </div>
              </CardContent>
            </Card>

            <div className="text-center">
              <Link href="/profile" className="text-sm text-muted-foreground hover:underline">
                ← Back to Profile
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
