"use client"

/**
 * Create Proposal modal form.
 * Used in group governance/voting flows where members draft a proposal with
 * voting threshold and duration settings before submitting to the parent view.
 * Key props: `isOpen` controls dialog visibility, `onClose` dismisses the modal,
 * and `onSubmit` receives normalized proposal data.
 */
import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  EMPTY_GATE_OPTIONS,
  GovernanceEligibilityPicker,
  draftToGateInput,
  makeGateDraft,
  type GovernanceGateOptions,
} from "@/components/governance-eligibility-picker"
import {
  GovernanceWeightPicker,
  draftToWeightInput,
  makeWeightDraft,
} from "@/components/governance-weight-picker"
import type { WeightConfig } from "@/lib/governance-weight"

interface CreateProposalModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (proposalData: {
    title: string
    description: string
    threshold: number
    duration: number
    voteEligibility?: { kind: string; badgeId?: string; shareClassId?: string; minShares?: number }
    voteWeight?: { kind: string; badgeId?: string }
    quorum?: number
  }) => void
  /** P2: the group's badges/share classes the eligibility picker offers. */
  gateOptions?: GovernanceGateOptions
  /** P3: the org's default vote weight (seeds the weight picker). */
  defaultWeight?: WeightConfig
}

/**
 * Renders a modal that collects proposal details and emits them to the parent.
 *
 * @param props - Dialog state and proposal submission handlers.
 * @param props.isOpen - Whether the modal is visible.
 * @param props.onClose - Called when the user cancels/closes the modal.
 * @param props.onSubmit - Called with proposal title, description, threshold, and duration.
 */
export function CreateProposalModal({ isOpen, onClose, onSubmit, gateOptions = EMPTY_GATE_OPTIONS, defaultWeight }: CreateProposalModalProps) {
  // Local controlled-input state for proposal form fields.
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [threshold, setThreshold] = useState("66")
  const [duration, setDuration] = useState("7")
  const [voteGate, setVoteGate] = useState(makeGateDraft())
  const [voteWeight, setVoteWeight] = useState(() => makeWeightDraft(defaultWeight))
  // P4: minimum raw voter participation for the outcome to stand (0 = none).
  const [quorum, setQuorum] = useState("0")

  // Submit handler validates required fields, normalizes numeric strings, and resets local form state.
  const handleSubmit = () => {
    if (title && description) {
      // Client callback only; this component does not directly call a server action.
      onSubmit({
        title,
        description,
        threshold: Number.parseInt(threshold),
        duration: Number.parseInt(duration),
        voteEligibility: draftToGateInput(voteGate),
        voteWeight: draftToWeightInput(voteWeight),
        quorum: Math.max(0, Number.parseInt(quorum, 10) || 0),
      })
      // Side effect: close modal after successful submission.
      onClose()
      // Reset local inputs to defaults for the next time the modal opens.
      setTitle("")
      setDescription("")
      setThreshold("66")
      setDuration("7")
      setVoteGate(makeGateDraft())
      setVoteWeight(makeWeightDraft(defaultWeight))
      setQuorum("0")
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create New Proposal</DialogTitle>
          <DialogDescription>Create a proposal for the group to vote on</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              placeholder="Enter proposal title..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="Describe your proposal in detail..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="threshold">Threshold (%)</Label>
              <Input
                id="threshold"
                type="number"
                min="50"
                max="100"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="duration">Duration (days)</Label>
              <Input
                id="duration"
                type="number"
                min="1"
                max="30"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
          </div>

          <GovernanceEligibilityPicker
            label="Who can vote"
            value={voteGate}
            onChange={setVoteGate}
            options={gateOptions}
            idPrefix="proposal-eligibility"
          />

          <GovernanceWeightPicker
            label="Vote weight"
            value={voteWeight}
            onChange={setVoteWeight}
            badges={gateOptions.badges}
            hasVotingShares={gateOptions.hasVotingShares ?? false}
            idPrefix="proposal-weight"
          />

          <div className="space-y-2">
            <Label htmlFor="proposal-quorum">Quorum (voters, 0 = none)</Label>
            <Input
              id="proposal-quorum"
              type="number"
              min="0"
              value={quorum}
              onChange={(e) => setQuorum(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Minimum number of voters for the outcome to stand when the window closes.
            </p>
          </div>
        </div>

        <DialogFooter>
          {/* Event handlers: cancel closes without state changes; submit is disabled until required fields are filled. */}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!title || !description}>
            Create Proposal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
