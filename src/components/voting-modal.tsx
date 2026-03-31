/**
 * @fileoverview VotingModal - Dialog for casting votes on polls and proposals.
 *
 * Used in the governance tab to let users vote on polls (select an option)
 * or proposals (yes/no/abstain), with an optional comment field.
 */
"use client"

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
import { Textarea } from "@/components/ui/textarea"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"

interface VotingItem {
  title?: string
  question?: string
  description?: string
  options?: { id: string; text: string }[]
}

interface VotingModalProps {
  isOpen: boolean
  onClose: () => void
  item: VotingItem
  type: "proposal" | "poll"
  onVote: (vote: string, comment?: string) => void
}

export function VotingModal({ isOpen, onClose, item, type, onVote }: VotingModalProps) {
  const [selectedVote, setSelectedVote] = useState("")
  const [comment, setComment] = useState("")

  const handleSubmit = () => {
    if (selectedVote) {
      onVote(selectedVote, comment)
      onClose()
      setSelectedVote("")
      setComment("")
    }
  }

  if (!item) return null

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{type === "proposal" ? "Vote on Proposal" : "Vote in Poll"}</DialogTitle>
          <DialogDescription>{type === "proposal" ? item.title : item.question}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="text-sm text-muted-foreground">{item.description}</div>

          <RadioGroup value={selectedVote} onValueChange={setSelectedVote}>
            {type === "proposal" ? (
              <>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="yes" id="yes" />
                  <Label htmlFor="yes">Yes</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="no" id="no" />
                  <Label htmlFor="no">No</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="abstain" id="abstain" />
                  <Label htmlFor="abstain">Abstain</Label>
                </div>
              </>
            ) : (
              item.options?.map((option: { id: string; text: string }) => (
                <div key={option.id} className="flex items-center space-x-2">
                  <RadioGroupItem value={option.id} id={option.id} />
                  <Label htmlFor={option.id}>{option.text}</Label>
                </div>
              ))
            )}
          </RadioGroup>

          <div className="space-y-2">
            <Label htmlFor="comment">Comment (optional)</Label>
            <Textarea
              id="comment"
              placeholder="Add a comment about your vote..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!selectedVote}>
            Submit Vote
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
