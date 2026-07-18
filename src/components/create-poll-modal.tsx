"use client"

/**
 * Create Poll modal form.
 * Used in group governance flows where members with write access draft a poll
 * (a lightweight multi-option vote, distinct from a yes/no/abstain Proposal)
 * with a question, optional description, 2+ options, and a voting duration
 * before submitting to the parent view.
 *
 * Key props: `isOpen` controls dialog visibility, `onClose` dismisses the modal,
 * and `onSubmit` receives normalized poll data (options trimmed + empties
 * dropped here; the server action re-validates ≥2 options).
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Plus, X } from "lucide-react"
import {
  BALLOT_STYLES,
  BALLOT_STYLE_DESCRIPTIONS,
  BALLOT_STYLE_LABELS,
  DEFAULT_BALLOT_STYLE,
  DEFAULT_CREDITS_PER_VOTER,
  DEFAULT_SCORE_MAX,
  type BallotStyle,
} from "@/lib/governance-ballot"

interface CreatePollModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (pollData: {
    question: string
    description: string
    options: string[]
    duration: number
    ballotStyle: BallotStyle
    scoreMax?: number
    creditsPerVoter?: number
  }) => void
}

/** Minimum number of options a poll must have to be valid. */
const MIN_POLL_OPTIONS = 2
/** Maximum number of options the composer allows. */
const MAX_POLL_OPTIONS = 10
/** Default number of empty option rows shown when the modal opens. */
const DEFAULT_OPTION_ROWS = 2

/**
 * Renders a modal that collects poll details and emits them to the parent.
 *
 * @param props - Dialog state and poll submission handlers.
 * @param props.isOpen - Whether the modal is visible.
 * @param props.onClose - Called when the user cancels/closes the modal.
 * @param props.onSubmit - Called with poll question, description, options, and duration.
 */
export function CreatePollModal({ isOpen, onClose, onSubmit }: CreatePollModalProps) {
  const [question, setQuestion] = useState("")
  const [description, setDescription] = useState("")
  const [options, setOptions] = useState<string[]>(Array(DEFAULT_OPTION_ROWS).fill(""))
  const [duration, setDuration] = useState("7")
  const [ballotStyle, setBallotStyle] = useState<BallotStyle>(DEFAULT_BALLOT_STYLE)
  const [scoreMax, setScoreMax] = useState(String(DEFAULT_SCORE_MAX))
  const [creditsPerVoter, setCreditsPerVoter] = useState(String(DEFAULT_CREDITS_PER_VOTER))

  const filledOptions = options.map((o) => o.trim()).filter((o) => o.length > 0)
  const canSubmit = question.trim().length > 0 && filledOptions.length >= MIN_POLL_OPTIONS

  const resetForm = () => {
    setQuestion("")
    setDescription("")
    setOptions(Array(DEFAULT_OPTION_ROWS).fill(""))
    setDuration("7")
    setBallotStyle(DEFAULT_BALLOT_STYLE)
    setScoreMax(String(DEFAULT_SCORE_MAX))
    setCreditsPerVoter(String(DEFAULT_CREDITS_PER_VOTER))
  }

  const handleOptionChange = (index: number, value: string) => {
    setOptions((current) => current.map((o, i) => (i === index ? value : o)))
  }

  const handleAddOption = () => {
    setOptions((current) => (current.length >= MAX_POLL_OPTIONS ? current : [...current, ""]))
  }

  const handleRemoveOption = (index: number) => {
    setOptions((current) => (current.length <= MIN_POLL_OPTIONS ? current : current.filter((_, i) => i !== index)))
  }

  const handleSubmit = () => {
    if (!canSubmit) return
    onSubmit({
      question: question.trim(),
      description: description.trim(),
      options: filledOptions,
      duration: Number.parseInt(duration) || 1,
      ballotStyle,
      scoreMax:
        ballotStyle === "score" || ballotStyle === "rate-rank"
          ? Number.parseInt(scoreMax) || DEFAULT_SCORE_MAX
          : undefined,
      creditsPerVoter:
        ballotStyle === "quadratic" ? Number.parseInt(creditsPerVoter) || DEFAULT_CREDITS_PER_VOTER : undefined,
    })
    onClose()
    resetForm()
  }

  const handleClose = () => {
    onClose()
    resetForm()
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create New Poll</DialogTitle>
          <DialogDescription>Ask the group a question with two or more options to vote on</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="poll-question">Question</Label>
            <Input
              id="poll-question"
              placeholder="What should we decide?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="poll-description">Description (optional)</Label>
            <Textarea
              id="poll-description"
              placeholder="Add any context for voters..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label>Options</Label>
            <div className="space-y-2">
              {options.map((option, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    aria-label={`Option ${index + 1}`}
                    placeholder={`Option ${index + 1}`}
                    value={option}
                    onChange={(e) => handleOptionChange(index, e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove option ${index + 1}`}
                    onClick={() => handleRemoveOption(index)}
                    disabled={options.length <= MIN_POLL_OPTIONS}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            {options.length < MAX_POLL_OPTIONS && (
              <Button type="button" variant="outline" size="sm" onClick={handleAddOption} className="mt-1">
                <Plus className="h-4 w-4 mr-1" /> Add option
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="poll-ballot-style">Ballot style</Label>
            <Select value={ballotStyle} onValueChange={(v) => setBallotStyle(v as BallotStyle)}>
              <SelectTrigger id="poll-ballot-style">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BALLOT_STYLES.map((style) => (
                  <SelectItem key={style} value={style}>
                    {BALLOT_STYLE_LABELS[style]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{BALLOT_STYLE_DESCRIPTIONS[ballotStyle]}</p>
          </div>

          {(ballotStyle === "score" || ballotStyle === "rate-rank") && (
            <div className="space-y-2">
              <Label htmlFor="poll-score-max">Max score</Label>
              <Input
                id="poll-score-max"
                type="number"
                min="1"
                max="10"
                value={scoreMax}
                onChange={(e) => setScoreMax(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Voters rate each option from 0 to this value.</p>
            </div>
          )}

          {ballotStyle === "quadratic" && (
            <div className="space-y-2">
              <Label htmlFor="poll-credits">Credits per voter</Label>
              <Input
                id="poll-credits"
                type="number"
                min="1"
                max="10000"
                value={creditsPerVoter}
                onChange={(e) => setCreditsPerVoter(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Each voter spends this many credits across options; voice grows as √credits.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="poll-duration">Duration (days)</Label>
            <Input
              id="poll-duration"
              type="number"
              min="1"
              max="30"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            Create Poll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
