"use client";

/**
 * Client-rendered plan grid for subscribing to a sovereign group's own
 * membership plans (shown on `/subscribe` when this instance is a group).
 *
 * Each card shows the plan name, price, perks, and a primary action:
 * - Current plan: "Current plan" badge, no action.
 * - Free plan: "Join" button (POST grants membership immediately).
 * - Paid plan: "Subscribe" button that POSTs to `/api/billing/group-subscribe`
 *   and redirects to the returned Stripe Checkout URL.
 *
 * Auth assumptions: the parent server component already redirected
 * unauthenticated visitors.
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

export type GroupSubscribePlanCard = {
  id: string;
  name: string;
  description: string;
  /** Monthly price in USD. 0 = free for the monthly period. */
  monthlyPriceUsd: number;
  /** True when the plan has no charge for the monthly period. */
  isFree: boolean;
  perks: string[];
};

interface GroupSubscribePlansProps {
  groupId: string;
  plans: GroupSubscribePlanCard[];
  /** The plan id the signed-in user is currently subscribed to, if any. */
  currentPlanId: string | null;
}

/**
 * Renders the group membership plan cards and orchestrates the subscribe flow.
 */
export function GroupSubscribePlans({
  groupId,
  plans,
  currentPlanId,
}: GroupSubscribePlansProps) {
  const { toast } = useToast();
  const [pendingPlanId, setPendingPlanId] = useState<string | null>(null);

  async function handleSubscribe(planId: string) {
    setPendingPlanId(planId);
    try {
      const response = await fetch("/api/billing/group-subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId, planId, billingPeriod: "monthly" }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        url?: string;
        free?: boolean;
        error?: string;
      };

      if (!response.ok) {
        toast({
          title: "Unable to subscribe",
          description: data.error ?? "Something went wrong. Please try again.",
          variant: "destructive",
        });
        setPendingPlanId(null);
        return;
      }

      if (data.free) {
        toast({
          title: "You're a member",
          description: "Your membership is now active.",
        });
        window.location.reload();
        return;
      }

      if (data.url) {
        window.location.href = data.url;
        return;
      }

      toast({
        title: "Unable to subscribe",
        description: "No checkout URL was returned.",
        variant: "destructive",
      });
      setPendingPlanId(null);
    } catch {
      toast({
        title: "Unable to subscribe",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
      setPendingPlanId(null);
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {plans.map((plan) => {
        const isCurrent = plan.id === currentPlanId;
        const isPending = pendingPlanId === plan.id;

        return (
          <Card
            key={plan.id}
            className={isCurrent ? "border-2 border-primary" : ""}
          >
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-2xl">{plan.name}</CardTitle>
                {isCurrent && <Badge variant="default">Current plan</Badge>}
              </div>
              <div className="mt-2">
                {plan.isFree ? (
                  <span className="text-3xl font-bold">Free</span>
                ) : (
                  <>
                    <span className="text-3xl font-bold">
                      ${plan.monthlyPriceUsd.toFixed(2)}
                    </span>
                    <span className="text-sm text-muted-foreground"> / month</span>
                  </>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {plan.description && (
                <p className="text-sm text-muted-foreground">{plan.description}</p>
              )}
              {plan.perks.length > 0 && (
                <ul className="space-y-2">
                  {plan.perks.map((perk) => (
                    <li key={perk} className="flex items-start gap-2 text-sm">
                      <Check className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                      <span>{perk}</span>
                    </li>
                  ))}
                </ul>
              )}

              {isCurrent ? (
                <Button className="w-full" variant="outline" disabled>
                  Current plan
                </Button>
              ) : (
                <Button
                  className="w-full"
                  onClick={() => handleSubscribe(plan.id)}
                  disabled={isPending || pendingPlanId !== null}
                >
                  {isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {plan.isFree ? "Joining..." : "Redirecting..."}
                    </>
                  ) : plan.isFree ? (
                    "Join"
                  ) : (
                    `Subscribe to ${plan.name}`
                  )}
                </Button>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
