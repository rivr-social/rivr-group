/**
 * @fileoverview StakeTab - Staking interface for group or ring governance tokens.
 *
 * Shown within group/ring detail pages. Allows users to view their staked amount,
 * stake/unstake tokens, and see staking rewards and voting power.
 *
 * Key props: groupId, memberStakes, totalStakes, recordedContributions
 */
"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  NetAllocationEditor,
  type NetAllocationClassOption,
  type NetAllocationMemberOption,
} from "@/components/net-allocation-editor"
import type { NetAllocationRule } from "@/lib/net-allocation"
import type { MemberStake } from "@/lib/types"

/**
 * A contributor surfaced because they completed one or more jobs. Recorded via
 * `recordJobContributionAction` (corrected J2 contribution model: completing a
 * job records a Stake contribution rather than awarding a badge).
 */
export interface RecordedContribution {
  contributorId: string
  contributorName: string
  contributorImage?: string | null
  jobCount: number
}

interface StakeTabProps {
  groupId: string
  /** Pre-fetched member stakes for the group (from server component parent or query). */
  memberStakes: MemberStake[]
  /** Pre-computed total stake percentage for the group. */
  totalStakes: number
  /**
   * Recorded job-contribution stakeholders. Defaults to an empty list so the
   * Contributions section is hidden when there are no recorded contributions.
   */
  recordedContributions?: RecordedContribution[]
  /**
   * Whether the current viewer can edit the org net-allocation tree. Only when
   * true is the admin-only {@link NetAllocationEditor} rendered.
   */
  isGroupAdmin?: boolean
  /** Saved net-allocation rules (`metadata.netAllocation.rules`) for the editor. */
  netAllocationRules?: NetAllocationRule[]
  /** Membership classes available as allocation targets in the editor. */
  netAllocationClasses?: NetAllocationClassOption[]
  /** Individual members available as allocation targets in the editor. */
  netAllocationMembers?: NetAllocationMemberOption[]
}

export function StakeTab({
  groupId,
  memberStakes,
  totalStakes,
  recordedContributions = [],
  isGroupAdmin = false,
  netAllocationRules = [],
  netAllocationClasses = [],
  netAllocationMembers = [],
}: StakeTabProps) {
  const [activeTab, setActiveTab] = useState("overview")

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Member Stakes</h2>
        <Button variant="outline">Propose Stake Changes</Button>
      </div>

      {isGroupAdmin && (
        <NetAllocationEditor
          groupId={groupId}
          initialRules={netAllocationRules}
          classOptions={netAllocationClasses}
          memberOptions={netAllocationMembers}
        />
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid grid-cols-2 w-full">
          <TabsTrigger value="overview">Stake Overview</TabsTrigger>
          <TabsTrigger value="metrics">Contribution Metrics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Group Stake Distribution</CardTitle>
              <CardDescription>Total allocated stakes: {totalStakes.toFixed(1)}% of group profits</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {memberStakes.map((stake) => (
                  <div
                    key={`${stake.user.id}-${stake.groupId}`}
                    className="flex items-center justify-between p-4 border rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <Avatar>
                        <AvatarImage src={stake.user.avatar || "/placeholder.svg"} alt={stake.user.name} />
                        <AvatarFallback>{stake.user.name.charAt(0)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium">{stake.user.name}</p>
                        <p className="text-sm text-muted-foreground">
                          Member since {new Date(stake.joinedAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-semibold">{stake.profitShare.toFixed(1)}%</div>
                      <div className="w-32">
                        <Progress value={(stake.profitShare / totalStakes) * 100} className="h-2" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="metrics" className="space-y-4 mt-4">
          <div className="grid gap-4">
            {memberStakes.map((stake) => (
              <Card key={`${stake.user.id}-${stake.groupId}-metrics`}>
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <Avatar>
                      <AvatarImage src={stake.user.avatar || "/placeholder.svg"} alt={stake.user.name} />
                      <AvatarFallback>{stake.user.name.charAt(0)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <CardTitle className="text-lg">{stake.user.name}</CardTitle>
                      <CardDescription>Stake: {stake.profitShare.toFixed(1)}%</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-blue-600">{stake.contributionMetrics.offersCreated}</div>
                      <div className="text-sm text-muted-foreground">Offers Created</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-green-600">
                        {stake.contributionMetrics.offersAccepted}
                      </div>
                      <div className="text-sm text-muted-foreground">Offers Accepted</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-purple-600">
                        {stake.contributionMetrics.thanksReceived}
                      </div>
                      <div className="text-sm text-muted-foreground">Thanks Received</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-orange-600">{stake.contributionMetrics.thanksGiven}</div>
                      <div className="text-sm text-muted-foreground">Thanks Given</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-red-600">
                        {stake.contributionMetrics.proposalsCreated}
                      </div>
                      <div className="text-sm text-muted-foreground">Proposals Created</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-indigo-600">
                        {stake.contributionMetrics.votesParticipated}
                      </div>
                      <div className="text-sm text-muted-foreground">Votes Participated</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {recordedContributions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recorded Contributions</CardTitle>
            <CardDescription>
              Contributors recognized for completing jobs in this group&apos;s projects.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recordedContributions.map((contribution) => (
                <div
                  key={contribution.contributorId}
                  className="flex items-center justify-between p-4 border rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <Avatar>
                      <AvatarImage
                        src={contribution.contributorImage || "/placeholder.svg"}
                        alt={contribution.contributorName}
                      />
                      <AvatarFallback>{contribution.contributorName.charAt(0)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{contribution.contributorName}</p>
                      <p className="text-sm text-muted-foreground">Contributor</p>
                    </div>
                  </div>
                  <Badge variant="secondary">
                    {contribution.jobCount} {contribution.jobCount === 1 ? "job" : "jobs"} completed
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
