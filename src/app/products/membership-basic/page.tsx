/**
 * Basic membership product page for `/products/membership-basic`.
 *
 * Purpose:
 * - Markets the Basic membership tier with feature list, audience targeting,
 *   and a checkout card with monthly/yearly billing toggle.
 * - Initiates Stripe checkout via `createCheckoutAction("basic", billingPeriod)`.
 *
 * Rendering: Client Component (`"use client"`).
 * Data requirements: None on mount; checkout triggers a server action.
 * Auth: No explicit auth gate; billing action handles unauthenticated users.
 * Metadata: No `metadata` export; metadata is inherited from the layout.
 *
 * @module products/membership-basic/page
 */
"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Check, Star, Heart, Users, MessageSquare, Loader2 } from "lucide-react"
import Link from "next/link"
import { createCheckoutAction } from "@/app/actions/billing"
import { getMembershipConnectSurchargeDollars } from "@/lib/membership-pricing"

/**
 * Client-rendered Basic membership landing and checkout page.
 *
 * @returns Marketing content and a billing checkout card for the Basic tier.
 */
export default function BasicMembershipPage() {
  const [billingPeriod, setBillingPeriod] = useState<"monthly" | "yearly">("monthly")
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const pricing = {
    monthly: { price: 7 + getMembershipConnectSurchargeDollars("monthly"), total: 7 + getMembershipConnectSurchargeDollars("monthly"), savings: null },
    yearly: { price: 5 + getMembershipConnectSurchargeDollars("monthly"), total: 58 + getMembershipConnectSurchargeDollars("yearly"), savings: 26 }
  }

  const features = [
    "Community profile",
    "Event discovery & RSVP",
    "Group membership",
    "Direct messaging",
    "Community calendar"
  ]

  /** Initiates the Stripe checkout session for the Basic tier and redirects on success. */
  const handleSubscribe = () => {
    setError(null)
    startTransition(async () => {
      const result = await createCheckoutAction("basic", billingPeriod)
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
            <div className="w-12 h-12 rounded-lg bg-green-100 flex items-center justify-center">
              <Heart className="h-6 w-6 text-green-600" />
            </div>
            <Badge className="bg-green-100 text-green-800">BASIC MEMBERSHIP</Badge>
          </div>
          <h1 className="text-4xl font-bold mb-4">Basic Membership</h1>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Support the cooperative and access core platform features
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5" />
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
                      <h4 className="font-medium">Community Members</h4>
                      <p className="text-sm text-muted-foreground">Join the cooperative and connect with your community</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Star className="h-4 w-4 text-yellow-500 mt-1" />
                    <div>
                      <h4 className="font-medium">Event Attendees</h4>
                      <p className="text-sm text-muted-foreground">Discover and RSVP to local events and gatherings</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Star className="h-4 w-4 text-yellow-500 mt-1" />
                    <div>
                      <h4 className="font-medium">Newcomers</h4>
                      <p className="text-sm text-muted-foreground">Get started with the platform and explore what the cooperative offers</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="border-2 border-green-200">
              <CardHeader className="text-center">
                <CardTitle>Membership Checkout</CardTitle>
                <div className="flex items-center justify-center gap-2 mt-4">
                  <div className="w-12 h-12 rounded-lg bg-green-100 flex items-center justify-center">
                    <Heart className="h-6 w-6 text-green-600" />
                  </div>
                  <Badge className="bg-green-100 text-green-800">Basic</Badge>
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
                      "Join as Basic Member"
                    )}
                  </Button>

                  <p className="text-xs text-muted-foreground text-center">
                    Support the cooperative and access core platform features
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
