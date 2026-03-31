/**
 * Organizer membership product page for `/products/membership-organizer`.
 *
 * Purpose:
 * - Markets the Organizer membership tier with feature list, audience targeting,
 *   and a checkout card with monthly/yearly billing toggle.
 * - Initiates Stripe checkout via `createCheckoutAction("organizer", billingPeriod)`.
 *
 * Rendering: Client Component (`"use client"`).
 * Data requirements: None on mount; checkout triggers a server action.
 * Auth: No explicit auth gate; billing action handles unauthenticated users.
 * Metadata: No `metadata` export; metadata is inherited from the layout.
 *
 * @module products/membership-organizer/page
 */
"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Check, Star, Building2, Users, Zap, Loader2 } from "lucide-react"
import Link from "next/link"
import { createCheckoutAction } from "@/app/actions/billing"
import { getMembershipConnectSurchargeDollars } from "@/lib/membership-pricing"

/**
 * Client-rendered Organizer membership landing and checkout page.
 *
 * @returns Marketing content and a billing checkout card for the Organizer tier.
 */
export default function OrganizerMembershipPage() {
  const [billingPeriod, setBillingPeriod] = useState<"monthly" | "yearly">("monthly")
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const pricing = {
    monthly: { price: 44 + getMembershipConnectSurchargeDollars("monthly"), total: 44 + getMembershipConnectSurchargeDollars("monthly"), savings: null },
    yearly: { price: 31 + getMembershipConnectSurchargeDollars("monthly"), total: 367 + getMembershipConnectSurchargeDollars("yearly"), savings: 161 }
  }

  const features = [
    "All Host and Seller membership features",
    "Advanced organizational tools",
    "Ticket sales and event monetization",
    "Multi-event campaign management",
    "Team collaboration and role management",
    "Advanced analytics and reporting",
    "Custom event workflows and automation",
    "Sponsor and partner management",
    "White-label event hosting",
    "Priority technical support",
    "API access for integrations",
    "Custom organizational branding"
  ]

  /** Initiates the Stripe checkout session for the Organizer tier and redirects on success. */
  const handleSubscribe = () => {
    setError(null)
    startTransition(async () => {
      const result = await createCheckoutAction("organizer", billingPeriod)
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
            <div className="w-12 h-12 rounded-lg bg-purple-100 flex items-center justify-center">
              <Building2 className="h-6 w-6 text-purple-600" />
            </div>
            <Badge className="bg-purple-100 text-purple-800">ORGANIZER MEMBERSHIP</Badge>
          </div>
          <h1 className="text-4xl font-bold mb-4">Organizer Membership</h1>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Full organizational features including ticket sales and advanced coordination tools
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Zap className="h-5 w-5" />
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
                  <Users className="h-5 w-5" />
                  Perfect For
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <Star className="h-4 w-4 text-yellow-500 mt-1" />
                    <div>
                      <h4 className="font-medium">Large Organizations</h4>
                      <p className="text-sm text-muted-foreground">Nonprofits, cooperatives, and community groups</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Star className="h-4 w-4 text-yellow-500 mt-1" />
                    <div>
                      <h4 className="font-medium">Event Companies</h4>
                      <p className="text-sm text-muted-foreground">Professional event organizers and conference planners</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Star className="h-4 w-4 text-yellow-500 mt-1" />
                    <div>
                      <h4 className="font-medium">Movement Leaders</h4>
                      <p className="text-sm text-muted-foreground">Social movements and advocacy organizations</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-amber-200 bg-amber-50/50">
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
                    <Zap className="h-4 w-4 text-amber-600" />
                  </div>
                  <h3 className="font-semibold text-amber-900">Most Popular for Organizations</h3>
                </div>
                <p className="text-sm text-amber-800">
                  This membership tier is designed for established organizations that need comprehensive
                  event management, ticketing, and team coordination features.
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="border-2 border-purple-200">
              <CardHeader className="text-center">
                <CardTitle>Membership Checkout</CardTitle>
                <div className="flex items-center justify-center gap-2 mt-4">
                  <div className="w-12 h-12 rounded-lg bg-purple-100 flex items-center justify-center">
                    <Building2 className="h-6 w-6 text-purple-600" />
                  </div>
                  <Badge className="bg-purple-100 text-purple-800">Organizer</Badge>
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
                      "Upgrade to Organizer"
                    )}
                  </Button>

                  <p className="text-xs text-muted-foreground text-center">
                    Unlock the full power of cooperative organizing
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
