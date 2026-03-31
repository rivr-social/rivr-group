/**
 * @fileoverview GovernanceTab - Tabbed interface for group governance features.
 *
 * Displayed within the group detail page. Surfaces issues, polls, and proposals
 * for a given group. Users can view issue details, vote on polls, cast votes on
 * proposals, and create new proposals via modal dialogs.
 *
 * Data is passed via props from the parent server component (fetched from group
 * metadata via `fetchGroupDetail`). No mock data dependencies.
 *
 * Key props: groupId, issues, polls, proposals
 */
"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ResponsiveTabsList } from "@/components/responsive-tabs-list"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

import { VotingModal } from "./voting-modal"
import { CreateProposalModal } from "./create-proposal-modal"
import type { Poll, Proposal } from "@/lib/types"
import { castGovernanceVoteAction, createGovernanceIssueAction, createGovernanceProposalAction } from "@/app/actions/create-resources"
import { useToast } from "@/components/ui/use-toast"

/** Minimal issue shape derived from group metadata. */
interface GovernanceIssue {
  id: string
  title: string
  description: string
  status: string
  creator: { name: string }
  createdAt: string
  tags?: string[]
  votes: { up: number; down: number }
  comments: number
}

interface GovernanceTabProps {
  /** The unique group identifier */
  groupId: string
  /** Issues extracted from group metadata, defaults to empty */
  issues?: GovernanceIssue[]
  /** Polls extracted from group metadata, defaults to empty */
  polls?: Poll[]
  /** Proposals extracted from group metadata, defaults to empty */
  proposals?: Proposal[]
}

/**
 * Renders the governance section for a group, with tabs for issues/polls and proposals/votes.
 *
 * Data is passed via props from the parent component which reads governance items
 * from the group agent's metadata (proposals, polls, issues keys).
 *
 * @param {GovernanceTabProps} props
 * @param {string} props.groupId - The unique group identifier
 * @param {GovernanceIssue[]} props.issues - Issues from group metadata
 * @param {Poll[]} props.polls - Polls from group metadata
 * @param {Proposal[]} props.proposals - Proposals from group metadata
 */
export function GovernanceTab({ groupId, issues = [], polls = [], proposals = [] }: GovernanceTabProps) {
  const router = useRouter()
  /** Tracks which governance sub-tab is active: "issues" (issues & polls) or "proposals" */
  const [activeTab, setActiveTab] = useState("issues")
  const [issueItems, setIssueItems] = useState(issues)
  const [proposalItems, setProposalItems] = useState(proposals)

  /** State for the voting modal -- holds the item being voted on and its type, or null when closed */
  const [votingModal, setVotingModal] = useState<{ isOpen: boolean; item: Poll | Proposal; type: "proposal" | "poll" } | null>(null)
  /** Controls visibility of the Create Proposal modal */
  const [createProposalModal, setCreateProposalModal] = useState(false)
  const [createIssueModal, setCreateIssueModal] = useState(false)
  const [issueTitle, setIssueTitle] = useState("")
  const [issueDescription, setIssueDescription] = useState("")

  const [, startTransition] = useTransition()
  const { toast } = useToast()

  /**
   * Handles submitting a vote on a poll or proposal.
   * Persists the vote via the governance vote server action and closes the modal on success.
   */
  const handleVote = (vote: string, comment?: string) => {
    if (!votingModal) return
    const targetId = votingModal.item.id
    const targetType = votingModal.type
    startTransition(async () => {
      const result = await castGovernanceVoteAction({ groupId, targetId, targetType, vote, comment })
      if (result.success) {
        toast({ title: "Vote recorded", description: "Your vote has been submitted." })
        setVotingModal(null)
      } else {
        toast({ title: "Vote failed", description: result.message, variant: "destructive" })
      }
    })
  }

  /**
   * Handles creating a new governance proposal.
   * Persists the proposal via the proposal creation server action and closes the modal on success.
   */
  const handleCreateProposal = (proposalData: { title: string; description: string; threshold: number; duration: number }) => {
    startTransition(async () => {
      const result = await createGovernanceProposalAction({ groupId, ...proposalData })
      if (result.success) {
        setProposalItems((current) => [
          {
            id: result.resourceId ?? `proposal-${Date.now()}`,
            title: proposalData.title,
            description: proposalData.description,
            status: "active" as Proposal["status"],
            votes: { yes: 0, no: 0, abstain: 0 },
            quorum: 0,
            threshold: proposalData.threshold,
            endDate: new Date(Date.now() + proposalData.duration * 24 * 60 * 60 * 1000).toISOString(),
            creator: { id: "", name: "You", username: "you", avatar: "", followers: 0, following: 0 },
            createdAt: new Date().toISOString(),
            comments: 0,
            groupId,
          },
          ...current,
        ])
        toast({ title: "Proposal created", description: "Your proposal has been submitted." })
        setCreateProposalModal(false)
        router.refresh()
      } else {
        toast({ title: "Proposal creation failed", description: result.message, variant: "destructive" })
      }
    })
  }

  const handleCreateIssue = () => {
    startTransition(async () => {
      const result = await createGovernanceIssueAction({
        groupId,
        title: issueTitle,
        description: issueDescription,
      })
      if (result.success) {
        setIssueItems((current) => [
          {
            id: result.resourceId ?? `issue-${Date.now()}`,
            title: issueTitle.trim(),
            description: issueDescription.trim(),
            status: "open",
            creator: { name: "You" },
            createdAt: new Date().toISOString(),
            tags: [],
            votes: { up: 0, down: 0 },
            comments: 0,
          },
          ...current,
        ])
        setIssueTitle("")
        setIssueDescription("")
        setCreateIssueModal(false)
        toast({ title: "Issue created", description: "Your issue has been submitted." })
        router.refresh()
      } else {
        toast({ title: "Issue creation failed", description: result.message, variant: "destructive" })
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Voice</h2>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setCreateIssueModal(true)}>Create Issue</Button>
          <Button variant="default" onClick={() => setCreateProposalModal(true)}>
            Create Proposal
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <ResponsiveTabsList>
          <TabsTrigger value="issues">Issues & Polls</TabsTrigger>
          <TabsTrigger value="proposals">Proposals & Votes</TabsTrigger>
        </ResponsiveTabsList>

        <TabsContent value="issues" className="space-y-4 mt-4">
          <div className="space-y-4">
            <h3 className="text-xl font-semibold">Issues</h3>
            {issueItems.map((issue) => (
              <Card key={issue.id}>
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-lg">{issue.title}</CardTitle>
                    <span className="px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      {issue.status}
                    </span>
                  </div>
                  <CardDescription>
                    Created by {issue.creator.name} • {new Date(issue.createdAt).toLocaleDateString()}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pb-2">
                  <p className="text-sm line-clamp-2">{issue.description}</p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {issue.tags?.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
                <CardFooter className="flex justify-between pt-2">
                  <div className="flex items-center gap-4 text-sm text-gray-500">
                    <span className="flex items-center gap-1">
                      <span className="text-green-500">↑</span> {issue.votes.up}
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="text-red-500">↓</span> {issue.votes.down}
                    </span>
                    <span>{issue.comments} comments</span>
                  </div>
                  <Button variant="ghost" size="sm">
                    View Details
                  </Button>
                </CardFooter>
              </Card>
            ))}
            {issueItems.length === 0 && (
              <Card>
                <CardContent className="p-8 text-center text-gray-500">
                  <p>No issues found for this group. Create the first issue to get started!</p>
                </CardContent>
              </Card>
            )}

            <h3 className="text-xl font-semibold mt-6">Polls</h3>
            {polls.map((poll) => (
              <Card key={poll.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg">{poll.question}</CardTitle>
                  <CardDescription>
                    Created by {poll.creator.name} • Ends {new Date(poll.endDate).toLocaleDateString()}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pb-2">
                  {poll.description && <p className="text-sm mb-4">{poll.description}</p>}
                  <div className="space-y-3">
                    {poll.options.map((option) => {
                      const percentage = Math.round((option.votes / poll.totalVotes) * 100) || 0
                      return (
                        <div key={option.id} className="space-y-1">
                          <div className="flex justify-between text-sm">
                            <span>{option.text}</span>
                            <span>
                              {percentage}% ({option.votes})
                            </span>
                          </div>
                          <div className="w-full bg-gray-100 rounded-full h-2">
                            <div
                              className={`h-2 rounded-full ${poll.userVoted === option.id ? "bg-blue-500" : "bg-gray-400"}`}
                              style={{ width: `${percentage}%` }}
                            ></div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
                <CardFooter className="flex justify-between pt-2">
                  <div className="text-sm text-gray-500">{poll.totalVotes} votes</div>
                  <Button
                    variant={poll.userVoted ? "outline" : "default"}
                    size="sm"
                    onClick={() => setVotingModal({ isOpen: true, item: poll, type: "poll" })}
                  >
                    {poll.userVoted ? "Change Vote" : "Vote"}
                  </Button>
                </CardFooter>
              </Card>
            ))}
            {polls.length === 0 && (
              <Card>
                <CardContent className="p-8 text-center text-gray-500">
                  <p>No polls found for this group. Create the first poll to get started!</p>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="proposals" className="space-y-4 mt-4">
          <h3 className="text-xl font-semibold">Proposals</h3>
          <div className="grid grid-cols-1 gap-4">
            {proposalItems.map((proposal) => (
              <Card key={proposal.id}>
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-lg">{proposal.title}</CardTitle>
                    <span className="px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                      {proposal.status}
                    </span>
                  </div>
                  <CardDescription>
                    Created by {proposal.creator.name} • Ends {new Date(proposal.endDate).toLocaleDateString()}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pb-2">
                  <p className="text-sm line-clamp-2 mb-3">{proposal.description}</p>

                  <div className="space-y-3">
                    <div className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span>Yes</span>
                        <span>
                          {Math.round(
                            (proposal.votes.yes / (proposal.votes.yes + proposal.votes.no + proposal.votes.abstain)) *
                              100,
                          )}
                          % ({proposal.votes.yes})
                        </span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-2">
                        <div
                          className="h-2 rounded-full bg-green-500"
                          style={{
                            width: `${Math.round((proposal.votes.yes / (proposal.votes.yes + proposal.votes.no + proposal.votes.abstain)) * 100)}%`,
                          }}
                        ></div>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span>No</span>
                        <span>
                          {Math.round(
                            (proposal.votes.no / (proposal.votes.yes + proposal.votes.no + proposal.votes.abstain)) *
                              100,
                          )}
                          % ({proposal.votes.no})
                        </span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-2">
                        <div
                          className="h-2 rounded-full bg-red-500"
                          style={{
                            width: `${Math.round((proposal.votes.no / (proposal.votes.yes + proposal.votes.no + proposal.votes.abstain)) * 100)}%`,
                          }}
                        ></div>
                      </div>
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="flex justify-between pt-2">
                  <div className="text-sm text-gray-500">
                    {proposal.comments} comments • Threshold: {proposal.threshold}%
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setVotingModal({ isOpen: true, item: proposal, type: "proposal" })}
                  >
                    Vote
                  </Button>
                </CardFooter>
              </Card>
            ))}
            {proposalItems.length === 0 && (
              <Card>
                <CardContent className="p-8 text-center text-gray-500">
                  <p>No proposals found for this group. Create the first proposal to get started!</p>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>
      {votingModal && (
        <VotingModal
          isOpen={votingModal.isOpen}
          onClose={() => setVotingModal(null)}
          item={votingModal.item}
          type={votingModal.type}
          onVote={handleVote}
        />
      )}

      <CreateProposalModal
        isOpen={createProposalModal}
        onClose={() => setCreateProposalModal(false)}
        onSubmit={handleCreateProposal}
      />

      <Dialog open={createIssueModal} onOpenChange={setCreateIssueModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Issue</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="governance-issue-title">Title</Label>
              <Input id="governance-issue-title" value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="governance-issue-description">Description</Label>
              <Textarea id="governance-issue-description" value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} rows={5} />
            </div>
            <Button onClick={handleCreateIssue} disabled={!issueTitle.trim() || !issueDescription.trim()}>
              Create Issue
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
