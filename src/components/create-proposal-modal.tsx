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

interface CreateProposalModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (proposalData: { title: string; description: string; threshold: number; duration: number }) => void
}

/**
 * Renders a modal that collects proposal details and emits them to the parent.
 *
 * @param props - Dialog state and proposal submission handlers.
 * @param props.isOpen - Whether the modal is visible.
 * @param props.onClose - Called when the user cancels/closes the modal.
 * @param props.onSubmit - Called with proposal title, description, threshold, and duration.
 */
export function CreateProposalModal({ isOpen, onClose, onSubmit }: CreateProposalModalProps) {
  // Local controlled-input state for proposal form fields.
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [threshold, setThreshold] = useState("66")
  const [duration, setDuration] = useState("7")

  // Submit handler validates required fields, normalizes numeric strings, and resets local form state.
  const handleSubmit = () => {
    if (title && description) {
      // Client callback only; this component does not directly call a server action.
      onSubmit({
        title,
        description,
        threshold: Number.parseInt(threshold),
        duration: Number.parseInt(duration),
      })
      // Side effect: close modal after successful submission.
      onClose()
      // Reset local inputs to defaults for the next time the modal opens.
      setTitle("")
      setDescription("")
      setThreshold("66")
      setDuration("7")
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
