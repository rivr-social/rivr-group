/**
 * Subscribe page for `/subscribe` on a sovereign group instance.
 *
 * Purpose:
 * - This instance serves a single primary group. `/subscribe` lets a member
 *   subscribe to that group's own membership plan (configured in the group's
 *   Settings → Memberships, stored in `metadata.membershipPlans`).
 *
 * This is the sovereign counterpart of the global hub's `/subscribe`, but it
 * only ever sells the local group's plans — it never renders the cooperative
 * RIVR membership tiers (those belong to the global hub).
 *
 * Rendering: Server Component. Auth: redirects unauthenticated visitors to
 * `/auth/login?next=/subscribe`.
 *
 * @module subscribe/page
 */
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { readGroupMembershipPlans } from "@/lib/group-memberships";
import { getActiveGroupSubscriptionPlanId } from "@/lib/group-subscriptions";
import {
  GroupSubscribePlans,
  type GroupSubscribePlanCard,
} from "./group-subscribe-plans";

export const dynamic = "force-dynamic";

/**
 * Server-rendered subscription landing page for this group instance.
 */
export default async function SubscribePage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/auth/login?next=/subscribe");
  }

  const instance = getInstanceConfig();

  if (instance.instanceType === "group" && instance.primaryAgentId) {
    return (
      <GroupSubscribeView
        groupId={instance.primaryAgentId}
        memberAgentId={session.user.id}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-16 max-w-2xl text-center">
        <h1 className="text-3xl font-bold mb-3">Membership</h1>
        <p className="text-muted-foreground">
          Memberships aren&apos;t offered on this instance.
        </p>
      </div>
    </div>
  );
}

/**
 * Renders the membership-plan picker for the primary group this instance serves.
 *
 * @param props.groupId The primary group agent id this instance serves.
 * @param props.memberAgentId The signed-in subscriber's id.
 */
async function GroupSubscribeView({
  groupId,
  memberAgentId,
}: {
  groupId: string;
  memberAgentId: string;
}) {
  const [group] = await db
    .select({ name: agents.name, metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, groupId))
    .limit(1);

  const metadata =
    group?.metadata && typeof group.metadata === "object" && !Array.isArray(group.metadata)
      ? (group.metadata as Record<string, unknown>)
      : {};

  const plans = readGroupMembershipPlans(metadata).filter((plan) => plan.active);
  const currentPlanId = await getActiveGroupSubscriptionPlanId(memberAgentId, groupId);

  const cards: GroupSubscribePlanCard[] = plans.map((plan) => {
    const monthlyCents = plan.amountMonthlyCents;
    const isFree = monthlyCents === null || monthlyCents <= 0;
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      monthlyPriceUsd: isFree ? 0 : monthlyCents / 100,
      isFree,
      perks: plan.perks,
    };
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-3">Membership</h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            {group?.name
              ? `Become a member of ${group.name}.`
              : "Become a member of this group."}{" "}
            Choose a plan below.
          </p>
        </div>

        {cards.length === 0 ? (
          <p className="text-center text-muted-foreground">
            This group hasn&apos;t published any membership plans yet.
          </p>
        ) : (
          <GroupSubscribePlans
            groupId={groupId}
            plans={cards}
            currentPlanId={currentPlanId}
          />
        )}
      </div>
    </div>
  );
}
