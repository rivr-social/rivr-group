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

import { useEffect, useState, useTransition } from "react"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import { Settings } from "lucide-react"

import { VotingModal, type VotePayload } from "./voting-modal"
import { CreateProposalModal } from "./create-proposal-modal"
import { CreatePollModal } from "./create-poll-modal"
import {
  EMPTY_GATE_OPTIONS,
  GovernanceEligibilityPicker,
  draftToGateInput,
  makeGateDraft,
  type EligibilityGateDraft,
  type GovernanceGateOptions,
} from "./governance-eligibility-picker"
import type { Poll, Proposal } from "@/lib/types"
import { BALLOT_STYLE_LABELS, DEFAULT_BALLOT_STYLE, isBallotStyle, type BallotStyle } from "@/lib/governance-ballot"
import { DEFAULT_MIN_SHARES, isEligibilityKind, type EligibilityGate } from "@/lib/governance-eligibility"
import { GovernanceWeightPicker, draftToWeightInput, makeWeightDraft } from "./governance-weight-picker"
import type { WeightConfig } from "@/lib/governance-weight"
import { BOARD_ROLES, BOARD_ROLE_LABELS } from "@/lib/governance-resolution"
import { approveDecisionFinalizationAction, setBoardRoleAction } from "@/app/actions/governance-resolution"
import { castGovernanceVoteAction, createGovernanceIssueAction, createGovernancePollAction, createGovernanceProposalAction, setGovernanceProposeGateAction } from "@/app/actions/create-resources"
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
  /** P2: whether the viewer may create governance items (server-computed;
   *  defaults to true so legacy call sites keep the buttons — the server
   *  still enforces). */
  canPropose?: boolean
  /** P2: whether the viewer is a group admin (shows the settings gear). */
  isAdmin?: boolean
  /** P2: the group's current propose gate (seeds the settings dialog). */
  proposeGate?: EligibilityGate
  /** P2: badges/share classes offered by the eligibility pickers. */
  gateOptions?: GovernanceGateOptions
  /** P3: the org's default vote weight (seeds modals + settings dialog). */
  defaultWeight?: WeightConfig
  /** P4: whether the viewer holds a board role (shows finalize controls). */
  viewerIsBoard?: boolean
  /** P4: current board-role holders (settings display). */
  board?: Array<{ memberId: string; name: string; role: string }>
  /** P4: group members for the board-role picker (admins). */
  memberOptions?: Array<{ id: string; name: string }>
}

/** Seed the settings dialog's draft from the stored propose gate. */
function draftFromGate(gate?: EligibilityGate): EligibilityGateDraft {
  if (!gate || !isEligibilityKind(gate.kind)) return makeGateDraft("admin")
  return {
    kind: gate.kind,
    badgeId: gate.badgeId ?? "",
    shareClassId: gate.shareClassId ?? "",
    minShares: String(gate.minShares ?? DEFAULT_MIN_SHARES),
  }
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
export function GovernanceTab({
  groupId,
  issues = [],
  polls = [],
  proposals = [],
  canPropose = true,
  isAdmin = false,
  proposeGate,
  gateOptions = EMPTY_GATE_OPTIONS,
  defaultWeight,
  viewerIsBoard = false,
  board = [],
  memberOptions = [],
}: GovernanceTabProps) {
  const router = useRouter()
  /** Tracks which governance sub-tab is active: "issues" (issues & polls) or "proposals" */
  const [activeTab, setActiveTab] = useState("issues")
  const [issueItems, setIssueItems] = useState(issues)
  const [proposalItems, setProposalItems] = useState(proposals)
  const [pollItems, setPollItems] = useState(polls)

  // Re-sync from server props after a router.refresh() (e.g. once a vote's
  // recomputed tally lands) — the initial useState seed does not update on its
  // own, so without this the bars stay stale until a full page reload.
  useEffect(() => { setIssueItems(issues) }, [issues])
  useEffect(() => { setProposalItems(proposals) }, [proposals])
  useEffect(() => { setPollItems(polls) }, [polls])

  /** State for the voting modal -- holds the item being voted on and its type, or null when closed */
  const [votingModal, setVotingModal] = useState<{ isOpen: boolean; item: Poll | Proposal; type: "proposal" | "poll" } | null>(null)
  /** Controls visibility of the Create Proposal modal */
  const [createProposalModal, setCreateProposalModal] = useState(false)
  /** Controls visibility of the Create Poll modal */
  const [createPollModal, setCreatePollModal] = useState(false)
  const [createIssueModal, setCreateIssueModal] = useState(false)
  const [issueTitle, setIssueTitle] = useState("")
  const [issueDescription, setIssueDescription] = useState("")
  /** P2 admin governance settings (who can propose). */
  const [settingsModal, setSettingsModal] = useState(false)
  const [proposeGateDraft, setProposeGateDraft] = useState<EligibilityGateDraft>(() => draftFromGate(proposeGate))
  const [defaultWeightDraft, setDefaultWeightDraft] = useState(() => makeWeightDraft(defaultWeight))

  const [, startTransition] = useTransition()
  const { toast } = useToast()

  /**
   * Handles submitting a vote on a poll or proposal.
   * Persists the vote via the governance vote server action and closes the modal on success.
   */
  const handleVote = (payload: VotePayload, comment?: string) => {
    if (!votingModal) return
    const targetId = votingModal.item.id
    const targetType = votingModal.type
    startTransition(async () => {
      const result = await castGovernanceVoteAction({
        groupId,
        targetId,
        targetType,
        vote: payload.vote,
        ballot: payload.ballot,
        comment,
      })
      if (result.success) {
        toast({ title: "Vote recorded", description: "Your vote has been submitted." })
        setVotingModal(null)
        router.refresh()
      } else {
        toast({ title: "Vote failed", description: result.message, variant: "destructive" })
      }
    })
  }

  /**
   * Handles creating a new governance proposal.
   * Persists the proposal via the proposal creation server action and closes the modal on success.
   */
  const handleCreateProposal = (proposalData: {
    title: string
    description: string
    threshold: number
    duration: number
    voteEligibility?: { kind: string; badgeId?: string; shareClassId?: string; minShares?: number }
  }) => {
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

  /**
   * Handles creating a new governance poll.
   * Persists the poll via the poll creation server action and closes the modal on success.
   */
  const handleCreatePoll = (pollData: {
    question: string
    description: string
    options: string[]
    duration: number
    ballotStyle: BallotStyle
    scoreMax?: number
    creditsPerVoter?: number
    voteEligibility?: { kind: string; badgeId?: string; shareClassId?: string; minShares?: number }
  }) => {
    startTransition(async () => {
      const result = await createGovernancePollAction({ groupId, ...pollData })
      if (result.success) {
        setPollItems((current) => [
          {
            id: result.resourceId ?? `poll-${Date.now()}`,
            question: pollData.question,
            description: pollData.description,
            options: pollData.options.map((text, idx) => ({
              id: `${result.resourceId ?? "poll"}-opt-${idx}`,
              text,
              votes: 0,
            })),
            totalVotes: 0,
            ballotStyle: pollData.ballotStyle,
            scoreMax: pollData.scoreMax,
            creditsPerVoter: pollData.creditsPerVoter,
            endDate: new Date(Date.now() + pollData.duration * 24 * 60 * 60 * 1000).toISOString(),
            creator: { id: "", name: "You", username: "you", avatar: "", followers: 0, following: 0 },
            createdAt: new Date().toISOString(),
            groupId,
          },
          ...current,
        ])
        toast({ title: "Poll created", description: "Your poll has been submitted." })
        setCreatePollModal(false)
        router.refresh()
      } else {
        toast({ title: "Poll creation failed", description: result.message, variant: "destructive" })
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

  /** P2: persist the admin-authored propose gate. */
  const handleSaveGovernanceSettings = () => {
    startTransition(async () => {
      const result = await setGovernanceProposeGateAction({
        groupId,
        gate: draftToGateInput(proposeGateDraft),
        defaultWeight: draftToWeightInput(defaultWeightDraft),
      })
      if (result.success) {
        toast({ title: "Governance settings saved", description: "Propose authority updated." })
        setSettingsModal(false)
        router.refresh()
      } else {
        toast({ title: "Save failed", description: result.message, variant: "destructive" })
      }
    })
  }

  /** P4: a board holder's approval to finalize a closed decision. */
  const handleApproveFinalization = (targetId: string, targetType: "poll" | "proposal") => {
    startTransition(async () => {
      const result = await approveDecisionFinalizationAction({ groupId, targetId, targetType })
      if (result.success) {
        toast({
          title: result.finalized ? "Decision finalized" : "Approval recorded",
          description: result.message,
        })
        router.refresh()
      } else {
        toast({ title: "Finalization failed", description: result.message, variant: "destructive" })
      }
    })
  }

  /** P4: admin assigns/clears a member's board role from the settings dialog. */
  const handleSetBoardRole = (memberId: string, role: string) => {
    startTransition(async () => {
      const result = await setBoardRoleAction({ groupId, memberId, role: role === "none" ? null : role })
      if (result.success) {
        toast({ title: "Board updated", description: result.message })
        router.refresh()
      } else {
        toast({ title: "Board update failed", description: result.message, variant: "destructive" })
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Voice</h2>
        <div className="flex gap-2">
          {canPropose && (
            <>
              <Button variant="outline" onClick={() => setCreateIssueModal(true)}>Create Issue</Button>
              <Button variant="outline" onClick={() => setCreatePollModal(true)}>Create Poll</Button>
              <Button variant="default" onClick={() => setCreateProposalModal(true)}>
                Create Proposal
              </Button>
            </>
          )}
          {isAdmin && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Governance settings"
              onClick={() => {
                setProposeGateDraft(draftFromGate(proposeGate))
                setDefaultWeightDraft(makeWeightDraft(defaultWeight))
                setSettingsModal(true)
              }}
            >
              <Settings className="h-4 w-4" />
            </Button>
          )}
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
            {pollItems.map((poll) => {
              const pollStyle: BallotStyle = isBallotStyle(poll.ballotStyle) ? poll.ballotStyle : DEFAULT_BALLOT_STYLE
              const tallyById = new Map((poll.tally?.options ?? []).map((o) => [o.id, o]))
              const winnerId = poll.tally?.winnerId ?? null
              return (
              <Card key={poll.id}>
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start gap-2">
                    <CardTitle className="text-lg">{poll.question}</CardTitle>
    <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                      {poll.phase === "closed" && (
                        <Badge variant="outline" className="text-xs">Closed</Badge>
                      )}
                      {poll.phase === "finalized" && (
                        <Badge className="text-xs">Finalized</Badge>
                      )}
                      {poll.weightLabel && (
                        <Badge variant="secondary" className="text-xs">
                          {poll.weightLabel}
                        </Badge>
                      )}
                      {poll.eligibilityLabel && (
                        <Badge variant="secondary" className="text-xs">
                          {poll.eligibilityLabel}
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-xs">
                        {BALLOT_STYLE_LABELS[pollStyle]}
                      </Badge>
                    </div>
                  </div>
                  <CardDescription>
                    Created by {poll.creator.name} • Ends {new Date(poll.endDate).toLocaleDateString()}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pb-2">
                  {poll.description && <p className="text-sm mb-4">{poll.description}</p>}
                  <div className="space-y-3">
                    {poll.options.map((option) => {
                      // Prefer the recomputed per-style tally; fall back to legacy counts.
                      const t = tallyById.get(option.id)
                      const fraction = t ? t.fraction : poll.totalVotes > 0 ? option.votes / poll.totalVotes : 0
                      const percentage = Math.round(fraction * 100)
                      const label = t ? t.label : `${percentage}% (${option.votes})`
                      const isWinner = winnerId === option.id
                      return (
                        <div key={option.id} className="space-y-1">
                          <div className="flex justify-between text-sm">
                            <span className={isWinner ? "font-semibold" : undefined}>
                              {option.text}
                              {isWinner && <span className="ml-1 text-green-600">✓</span>}
                            </span>
                            <span className="text-muted-foreground">{label}</span>
                          </div>
                          <div className="w-full bg-gray-100 rounded-full h-2">
                            <div
                              className={`h-2 rounded-full ${
                                isWinner ? "bg-green-500" : poll.userVoted === option.id ? "bg-blue-500" : "bg-gray-400"
                              }`}
                              style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }}
                            ></div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
                <CardFooter className="flex justify-between pt-2">
                  <div className="text-sm text-gray-500">
                    {poll.totalVotes} votes
                    {poll.viewerVoteWeight != null && poll.phase !== "finalized" && (
                      <span className="ml-2 text-xs">· your weight: {poll.viewerVoteWeight}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {poll.phase === "finalized" ? (
                      <span className="text-xs text-muted-foreground">
                        {poll.outcome?.winnerId
                          ? `Recorded winner: ${poll.options.find((o) => o.id === poll.outcome?.winnerId)?.text ?? poll.outcome.winnerId}`
                          : "Recorded outcome: no winner"}{" "}
                        · enact manually
                      </span>
                    ) : poll.phase === "closed" ? (
                      <>
                        <span className="text-xs text-muted-foreground">
                          Voting closed · finalization {poll.finalizeApprovals ?? 0}/
                          {poll.finalizeRequired && Number.isFinite(poll.finalizeRequired) ? poll.finalizeRequired : "—"}
                        </span>
                        {viewerIsBoard && (
                          <Button size="sm" onClick={() => handleApproveFinalization(poll.id, "poll")}>
                            Approve finalization
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        {poll.viewerCanVote === false && poll.viewerVoteReason && (
                          <span className="text-xs text-muted-foreground">{poll.viewerVoteReason}</span>
                        )}
                        <Button
                          variant={poll.userVoted ? "outline" : "default"}
                          size="sm"
                          disabled={poll.viewerCanVote === false}
                          onClick={() => setVotingModal({ isOpen: true, item: poll, type: "poll" })}
                        >
                          {poll.userVoted ? "Change Vote" : "Vote"}
                        </Button>
                      </>
                    )}
                  </div>
                </CardFooter>
              </Card>
              )
            })}
            {pollItems.length === 0 && (
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
                  <div className="flex justify-between items-start gap-2">
                    <CardTitle className="text-lg">{proposal.title}</CardTitle>
                    <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                      {proposal.weightLabel && (
                        <Badge variant="secondary" className="text-xs">
                          {proposal.weightLabel}
                        </Badge>
                      )}
                      {proposal.eligibilityLabel && (
                        <Badge variant="secondary" className="text-xs">
                          {proposal.eligibilityLabel}
                        </Badge>
                      )}
                      {proposal.phase === "finalized" && proposal.outcome ? (
                        <span
                          className={`px-2 py-1 rounded-full text-xs font-medium ${
                            proposal.outcome.passed ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
                          }`}
                        >
                          {proposal.outcome.passed ? "Passed" : "Failed"}
                        </span>
                      ) : (
                        <span className="px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          {proposal.phase === "closed" ? "closed" : proposal.status}
                        </span>
                      )}
                    </div>
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
                  <div className="flex items-center gap-2">
                    {proposal.phase === "finalized" ? (
                      <span className="text-xs text-muted-foreground">
                        Recorded {proposal.outcome?.passed ? "PASSED" : "FAILED"}
                        {proposal.outcome?.quorumMet === false ? " (quorum not met)" : ""} · enact manually
                      </span>
                    ) : proposal.phase === "closed" ? (
                      <>
                        <span className="text-xs text-muted-foreground">
                          Voting closed · finalization {proposal.finalizeApprovals ?? 0}/
                          {proposal.finalizeRequired && Number.isFinite(proposal.finalizeRequired) ? proposal.finalizeRequired : "—"}
                        </span>
                        {viewerIsBoard && (
                          <Button size="sm" onClick={() => handleApproveFinalization(proposal.id, "proposal")}>
                            Approve finalization
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        {proposal.viewerCanVote === false && proposal.viewerVoteReason && (
                          <span className="text-xs text-muted-foreground">{proposal.viewerVoteReason}</span>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={proposal.viewerCanVote === false}
                          onClick={() => setVotingModal({ isOpen: true, item: proposal, type: "proposal" })}
                        >
                          Vote
                        </Button>
                      </>
                    )}
                  </div>
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
        gateOptions={gateOptions}
        defaultWeight={defaultWeight}
      />

      <CreatePollModal
        isOpen={createPollModal}
        onClose={() => setCreatePollModal(false)}
        onSubmit={handleCreatePoll}
        gateOptions={gateOptions}
        defaultWeight={defaultWeight}
      />

      <Dialog open={settingsModal} onOpenChange={setSettingsModal}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Governance Settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <GovernanceEligibilityPicker
              label="Who can propose"
              value={proposeGateDraft}
              onChange={setProposeGateDraft}
              options={gateOptions}
              idPrefix="governance-propose"
              context="propose"
            />
            <p className="text-xs text-muted-foreground">
              Admins can always create polls, proposals, and issues — this setting widens that authority.
            </p>
            <GovernanceWeightPicker
              label="Default vote weight"
              value={defaultWeightDraft}
              onChange={setDefaultWeightDraft}
              badges={gateOptions.badges}
              hasVotingShares={gateOptions.hasVotingShares ?? false}
              idPrefix="governance-default-weight"
            />
            <p className="text-xs text-muted-foreground">
              New polls and proposals start from this weight; the creator may override it per item.
            </p>
            <Button onClick={handleSaveGovernanceSettings}>Save</Button>

            <div className="space-y-2 border-t pt-4">
              <Label>Board roles</Label>
              <p className="text-xs text-muted-foreground">
                Finalizing a closed decision takes approval from 2/3 of board-role holders. Outcomes are
                recorded only — nothing executes automatically.
              </p>
              {memberOptions.length === 0 ? (
                <p className="text-xs text-muted-foreground">No members to assign.</p>
              ) : (
                memberOptions.map((member) => {
                  const held = board.find((b) => b.memberId === member.id)?.role ?? "none"
                  return (
                    <div key={member.id} className="flex items-center justify-between gap-2">
                      <span className="text-sm">{member.name}</span>
                      <Select value={held} onValueChange={(role) => handleSetBoardRole(member.id, role)}>
                        <SelectTrigger className="h-8 w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No board role</SelectItem>
                          {BOARD_ROLES.map((role) => (
                            <SelectItem key={role} value={role}>
                              {BOARD_ROLE_LABELS[role]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
