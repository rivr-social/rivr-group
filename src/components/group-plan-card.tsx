"use client"

/**
 * Group membership plan card for the group About tab.
 *
 * Renders a single plan (name, status badges, description, monthly/yearly price,
 * perks) and a primary "Subscribe" CTA that POSTs to `/api/billing/group-subscribe`
 * (mirroring the `/subscribe` page's group-subscribe flow). The subscribing
 * member identity is always derived server-side from the session; this client
 * only sends `{ groupId, planId, billingPeriod }`.
 *
 * Gating:
 * - Signed-out visitors get a "Sign in to subscribe" link to the login page.
 * - The viewer's already-subscribed plan shows a disabled "Subscribed" state.
 * - Inactive plans render without a subscribe CTA.
 */

import { useState } from "react"
import Link from "next/link"
import { Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"

export interface GroupPlanCardPlan {
  id: string
  name: string
  description?: string
  active: boolean
  isDefault: boolean
  amountMonthlyCents: number | null
  amountYearlyCents: number | null
  perks: string[]
}

interface GroupPlanCardProps {
  groupId: string
  plan: GroupPlanCardPlan
  /** Signed-in viewer id, or null when anonymous. */
  currentUserId: string | null
  /** True when the viewer already holds this plan (hides the subscribe CTA). */
  isSubscribed: boolean
}

/** Formats a cents value as USD, or "Custom pricing" when null. */
function formatCurrency(cents: number | null): string {
  return cents === null
    ? "Custom pricing"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

export function GroupPlanCard({ groupId, plan, currentUserId, isSubscribed }: GroupPlanCardProps) {
  const { toast } = useToast()
  const [pending, setPending] = useState(false)

  // Prefer a monthly cadence; fall back to yearly for yearly-only plans.
  const billingPeriod: "monthly" | "yearly" =
    plan.amountMonthlyCents === null && plan.amountYearlyCents !== null ? "yearly" : "monthly"

  async function handleSubscribe() {
    setPending(true)
    try {
      const response = await fetch("/api/billing/group-subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId, planId: plan.id, billingPeriod }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        url?: string
        free?: boolean
        error?: string
      }

      if (!response.ok) {
        toast({
          title: "Unable to subscribe",
          description: data.error ?? "Something went wrong. Please try again.",
          variant: "destructive",
        })
        setPending(false)
        return
      }

      if (data.free) {
        toast({ title: "You're a member", description: "Your membership is now active." })
        window.location.reload()
        return
      }

      if (data.url) {
        window.location.href = data.url
        return
      }

      toast({
        title: "Unable to subscribe",
        description: "No checkout URL was returned.",
        variant: "destructive",
      })
      setPending(false)
    } catch {
      toast({
        title: "Unable to subscribe",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
      setPending(false)
    }
  }

  return (
    <div className={`rounded-md border p-3 space-y-2 ${isSubscribed ? "border-primary" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{plan.name}</p>
        <div className="flex items-center gap-2">
          {isSubscribed && <Badge>Subscribed</Badge>}
          {!plan.active && <Badge variant="outline">Inactive</Badge>}
          {plan.isDefault && <Badge>Default</Badge>}
        </div>
      </div>
      {plan.description && <p className="text-sm text-muted-foreground">{plan.description}</p>}
      <p className="text-sm text-muted-foreground">
        Monthly: {formatCurrency(plan.amountMonthlyCents)} · Yearly: {formatCurrency(plan.amountYearlyCents)}
      </p>
      {plan.perks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {plan.perks.map((perk) => (
            <Badge key={perk} variant="secondary">
              {perk}
            </Badge>
          ))}
        </div>
      )}

      {plan.active && !isSubscribed && (
        currentUserId ? (
          <Button size="sm" onClick={handleSubscribe} disabled={pending} className="mt-1">
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Starting...
              </>
            ) : (
              "Subscribe"
            )}
          </Button>
        ) : (
          <Button size="sm" variant="outline" asChild className="mt-1">
            <Link href={`/auth/login?callbackUrl=${encodeURIComponent(`/groups/${groupId}`)}`}>
              Sign in to subscribe
            </Link>
          </Button>
        )
      )}
    </div>
  )
}
