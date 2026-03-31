"use client"

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { setReactionOnTarget, type ReactionType } from "@/app/actions/interactions"
import { useToast } from "@/components/ui/use-toast"

const REACTIONS: Array<{ type: ReactionType; emoji: string; label: string }> = [
  { type: "like", emoji: "👍", label: "Like" },
  { type: "love", emoji: "❤️", label: "Love" },
  { type: "laugh", emoji: "😂", label: "Haha" },
  { type: "wow", emoji: "😮", label: "Wow" },
  { type: "sad", emoji: "😢", label: "Sad" },
  { type: "angry", emoji: "😡", label: "Angry" },
]

type ReactionSummary = {
  counts?: Partial<Record<ReactionType, number>>
  totalCount?: number
  currentUserReaction?: ReactionType | null
}

interface ReactionButtonProps {
  targetId: string
  targetType: "post" | "comment"
  summary?: ReactionSummary
  className?: string
  size?: "sm" | "default"
}

export function ReactionButton({
  targetId,
  targetType,
  summary,
  className,
  size = "sm",
}: ReactionButtonProps) {
  const [open, setOpen] = useState(false)
  const [counts, setCounts] = useState<Partial<Record<ReactionType, number>>>(summary?.counts ?? {})
  const [currentReaction, setCurrentReaction] = useState<ReactionType | null>(summary?.currentUserReaction ?? null)
  const [isSaving, setIsSaving] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    setCounts(summary?.counts ?? {})
    setCurrentReaction(summary?.currentUserReaction ?? null)
  }, [summary])

  const totalCount = useMemo(
    () => Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0),
    [counts],
  )

  const selectedReaction = REACTIONS.find((reaction) => reaction.type === currentReaction)

  const handleSelectReaction = async (reactionType: ReactionType) => {
    if (isSaving) return
    setIsSaving(true)
    const previousReaction = currentReaction
    const nextCounts = { ...counts }

    if (previousReaction) {
      nextCounts[previousReaction] = Math.max((nextCounts[previousReaction] ?? 1) - 1, 0)
    }
    if (previousReaction !== reactionType) {
      nextCounts[reactionType] = (nextCounts[reactionType] ?? 0) + 1
    }

    setCounts(nextCounts)
    setCurrentReaction(previousReaction === reactionType ? null : reactionType)

    const result = await setReactionOnTarget(targetId, targetType, reactionType)
    setIsSaving(false)

    if (!result.success) {
      setCounts(counts)
      setCurrentReaction(previousReaction)
      toast({ title: "Could not update reaction", description: result.message, variant: "destructive" })
      return
    }

    setCurrentReaction(result.reactionType ?? null)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size={size} className={className} type="button">
          <span className="mr-2 text-base leading-none">{selectedReaction?.emoji ?? "👍"}</span>
          {selectedReaction?.label ?? "Like"}
          {totalCount > 0 ? <span className="ml-2 text-xs text-muted-foreground">{totalCount}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto rounded-full px-2 py-2" align="start">
        <div className="flex items-center gap-1">
          {REACTIONS.map((reaction) => (
            <button
              key={reaction.type}
              type="button"
              className="rounded-full p-2 text-2xl transition-transform hover:scale-110"
              aria-label={reaction.label}
              onClick={() => void handleSelectReaction(reaction.type)}
            >
              {reaction.emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
