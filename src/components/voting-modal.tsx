/**
 * @fileoverview VotingModal - Dialog for casting votes on polls and proposals.
 *
 * Proposals use a yes/no/abstain radio. Polls render a per-ballot-style input
 * (P1, `governance-decision-model-scope-2026-07-16.md` §4): multiple-choice
 * (radio), approval (checkboxes), score (sliders), ranked (reorderable list),
 * rate+rank (score + importance sliders), quadratic (credit allocation with a
 * live budget). The built ballot is validated client-side (parity with the
 * server) before submit is enabled.
 */
"use client"

import { useMemo, useState } from "react"
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
import { Checkbox } from "@/components/ui/checkbox"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { ChevronDown, ChevronUp } from "lucide-react"
import {
  DEFAULT_BALLOT_STYLE,
  DEFAULT_IMPORTANCE_MAX,
  isBallotStyle,
  resolveCreditsPerVoter,
  resolveScoreMax,
  validateBallot,
  type BallotStyle,
  type PollBallotConfig,
} from "@/lib/governance-ballot"

interface VotingItem {
  title?: string
  question?: string
  description?: string
  options?: { id: string; text: string }[]
  ballotStyle?: string
  scoreMax?: number
  creditsPerVoter?: number
}

/** The vote payload passed up to the governance tab: either a scalar `vote`
 *  (proposal / multiple-choice) or a raw `ballot` object (other styles). */
export type VotePayload = { vote?: string; ballot?: unknown }

interface VotingModalProps {
  isOpen: boolean
  onClose: () => void
  item: VotingItem
  type: "proposal" | "poll"
  onVote: (payload: VotePayload, comment?: string) => void
}

export function VotingModal({ isOpen, onClose, item, type, onVote }: VotingModalProps) {
  const options = item.options ?? []
  const optionIds = options.map((o) => o.id)
  const style: BallotStyle =
    type === "poll" && isBallotStyle(item.ballotStyle) ? item.ballotStyle : DEFAULT_BALLOT_STYLE
  const config: PollBallotConfig = useMemo(
    () => ({ ballotStyle: style, scoreMax: item.scoreMax, creditsPerVoter: item.creditsPerVoter }),
    [style, item.scoreMax, item.creditsPerVoter],
  )
  const scoreMax = resolveScoreMax(config)
  const creditBudget = resolveCreditsPerVoter(config)

  // Proposal + multiple-choice.
  const [selectedVote, setSelectedVote] = useState("")
  // Approval.
  const [approvals, setApprovals] = useState<Record<string, boolean>>({})
  // Score.
  const [scores, setScores] = useState<Record<string, number>>({})
  // Ranked (ordered list of option ids).
  const [ranking, setRanking] = useState<string[]>(optionIds)
  // Rate + rank.
  const [ratings, setRatings] = useState<Record<string, { score: number; importance: number }>>({})
  // Quadratic.
  const [credits, setCredits] = useState<Record<string, number>>({})

  const [comment, setComment] = useState("")

  const creditsSpent = Object.values(credits).reduce((a, c) => a + (Number.isFinite(c) ? c : 0), 0)
  const creditsRemaining = creditBudget - creditsSpent

  const reset = () => {
    setSelectedVote("")
    setApprovals({})
    setScores({})
    setRanking(optionIds)
    setRatings({})
    setCredits({})
    setComment("")
  }

  /** Build the raw ballot for the current style (or the scalar for MC). */
  const buildRaw = (): unknown => {
    switch (style) {
      case "multiple-choice":
        return selectedVote
      case "approval":
        return { selections: Object.keys(approvals).filter((id) => approvals[id]) }
      case "score":
        return { scores }
      case "ranked":
        return { ranking }
      case "rate-rank":
        return { ratings }
      case "quadratic":
        return { credits }
    }
  }

  const pollValid = useMemo(() => {
    if (type !== "poll") return false
    return validateBallot(config, optionIds, buildRaw()).ok
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, config, optionIds, style, selectedVote, approvals, scores, ranking, ratings, credits])

  const canSubmit = type === "proposal" ? selectedVote !== "" : pollValid

  const handleSubmit = () => {
    if (!canSubmit) return
    if (type === "proposal" || style === "multiple-choice") {
      onVote({ vote: selectedVote }, comment)
    } else {
      onVote({ ballot: buildRaw() }, comment)
    }
    onClose()
    reset()
  }

  const moveRank = (index: number, dir: -1 | 1) => {
    setRanking((cur) => {
      const next = [...cur]
      const j = index + dir
      if (j < 0 || j >= next.length) return cur
      ;[next[index], next[j]] = [next[j], next[index]]
      return next
    })
  }

  if (!item) return null

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[480px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{type === "proposal" ? "Vote on Proposal" : "Vote in Poll"}</DialogTitle>
          <DialogDescription>{type === "proposal" ? item.title : item.question}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {item.description && <div className="text-sm text-muted-foreground">{item.description}</div>}

          {type === "proposal" && (
            <RadioGroup value={selectedVote} onValueChange={setSelectedVote}>
              {["yes", "no", "abstain"].map((v) => (
                <div key={v} className="flex items-center space-x-2">
                  <RadioGroupItem value={v} id={`vote-${v}`} />
                  <Label htmlFor={`vote-${v}`} className="capitalize">
                    {v}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          )}

          {type === "poll" && style === "multiple-choice" && (
            <RadioGroup value={selectedVote} onValueChange={setSelectedVote}>
              {options.map((option) => (
                <div key={option.id} className="flex items-center space-x-2">
                  <RadioGroupItem value={option.id} id={option.id} />
                  <Label htmlFor={option.id}>{option.text}</Label>
                </div>
              ))}
            </RadioGroup>
          )}

          {type === "poll" && style === "approval" && (
            <div className="space-y-2">
              {options.map((option) => (
                <div key={option.id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`app-${option.id}`}
                    checked={!!approvals[option.id]}
                    onCheckedChange={(c) => setApprovals((cur) => ({ ...cur, [option.id]: c === true }))}
                  />
                  <Label htmlFor={`app-${option.id}`}>{option.text}</Label>
                </div>
              ))}
            </div>
          )}

          {type === "poll" && style === "score" && (
            <div className="space-y-4">
              {options.map((option) => (
                <div key={option.id} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <Label>{option.text}</Label>
                    <span className="text-muted-foreground">
                      {scores[option.id] ?? 0} / {scoreMax}
                    </span>
                  </div>
                  <Slider
                    min={0}
                    max={scoreMax}
                    step={1}
                    value={[scores[option.id] ?? 0]}
                    onValueChange={([v]) => setScores((cur) => ({ ...cur, [option.id]: v }))}
                  />
                </div>
              ))}
            </div>
          )}

          {type === "poll" && style === "ranked" && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Order the options — top is your first choice.</p>
              {ranking.map((id, index) => {
                const option = options.find((o) => o.id === id)
                if (!option) return null
                return (
                  <div key={id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                    <span className="text-sm font-medium text-muted-foreground w-5">{index + 1}.</span>
                    <span className="flex-1 text-sm">{option.text}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${option.text} up`}
                      disabled={index === 0}
                      onClick={() => moveRank(index, -1)}
                    >
                      <ChevronUp className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${option.text} down`}
                      disabled={index === ranking.length - 1}
                      onClick={() => moveRank(index, 1)}
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}

          {type === "poll" && style === "rate-rank" && (
            <div className="space-y-5">
              {options.map((option) => {
                const r = ratings[option.id] ?? { score: 0, importance: 0 }
                return (
                  <div key={option.id} className="space-y-2 rounded-md border p-3">
                    <Label className="text-sm font-medium">{option.text}</Label>
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Score</span>
                        <span>
                          {r.score} / {scoreMax}
                        </span>
                      </div>
                      <Slider
                        min={0}
                        max={scoreMax}
                        step={1}
                        value={[r.score]}
                        onValueChange={([v]) => setRatings((cur) => ({ ...cur, [option.id]: { ...r, score: v } }))}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>How much it matters</span>
                        <span>
                          {r.importance} / {DEFAULT_IMPORTANCE_MAX}
                        </span>
                      </div>
                      <Slider
                        min={0}
                        max={DEFAULT_IMPORTANCE_MAX}
                        step={1}
                        value={[r.importance]}
                        onValueChange={([v]) =>
                          setRatings((cur) => ({ ...cur, [option.id]: { ...r, importance: v } }))
                        }
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {type === "poll" && style === "quadratic" && (
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Credits</span>
                <span className={creditsRemaining < 0 ? "text-destructive font-medium" : "text-muted-foreground"}>
                  {creditsRemaining} / {creditBudget} left
                </span>
              </div>
              {options.map((option) => (
                <div key={option.id} className="flex items-center gap-3">
                  <Label className="flex-1 text-sm">{option.text}</Label>
                  <Input
                    type="number"
                    min="0"
                    max={creditBudget}
                    className="w-24"
                    aria-label={`Credits for ${option.text}`}
                    value={credits[option.id] ?? 0}
                    onChange={(e) =>
                      setCredits((cur) => ({ ...cur, [option.id]: Math.max(0, Number.parseInt(e.target.value) || 0) }))
                    }
                  />
                  <span className="w-16 text-right text-xs text-muted-foreground">
                    √ = {Math.sqrt(Math.max(0, credits[option.id] ?? 0)).toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
          )}

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
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            Submit Vote
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
