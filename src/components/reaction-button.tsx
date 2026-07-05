"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ThumbsUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { setReactionOnTarget, type ReactionType } from "@/app/actions/interactions"
import { useToast } from "@/components/ui/use-toast"
import { cn } from "@/lib/utils"

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
  onReactionChange?: () => void
}

/**
 * Single icon+count reaction control (x.com-style). Tapping toggles the default
 * "like"; the multi-emoji picker reveals on hover (desktop) or long-press
 * (touch) — no separate floating chevron. The optional `count` renders inline
 * next to the icon like the other post actions.
 */
export function ReactionButton({
  targetId,
  targetType,
  summary,
  className,
  size = "sm",
  onReactionChange,
}: ReactionButtonProps) {
  const [open, setOpen] = useState(false)
  const [counts, setCounts] = useState<Partial<Record<ReactionType, number>>>(summary?.counts ?? {})
  const [currentReaction, setCurrentReaction] = useState<ReactionType | null>(summary?.currentUserReaction ?? null)
  const [isSaving, setIsSaving] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    queueMicrotask(() => {
      setCounts(summary?.counts ?? {})
      setCurrentReaction(summary?.currentUserReaction ?? null)
    })
  }, [summary])

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
      if (longPressTimer.current) clearTimeout(longPressTimer.current)
    },
    [],
  )

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
    setOpen(false)

    const result = await setReactionOnTarget(targetId, targetType, reactionType)
    setIsSaving(false)

    if (!result.success) {
      setCounts(counts)
      setCurrentReaction(previousReaction)
      toast({ title: "Could not update reaction", description: result.message, variant: "destructive" })
      return
    }

    setCurrentReaction(result.reactionType ?? null)
    onReactionChange?.()
  }

  const handlePrimaryClick = () => {
    void handleSelectReaction(currentReaction ?? "like")
  }

  // Desktop: hover to reveal the picker (with a small close grace period so the
  // pointer can travel from the button to the popover). Touch: long-press.
  const openPicker = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 160)
  }
  const startLongPress = () => {
    longPressTimer.current = setTimeout(() => setOpen(true), 400)
  }
  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
  }

  const fillsWidth = Boolean(className && className.includes("w-full"))

  return (
    <div
      className={cn("relative inline-flex", fillsWidth && "w-full")}
      onMouseEnter={openPicker}
      onMouseLeave={scheduleClose}
    >
      <Button
        variant="ghost"
        size={size}
        type="button"
        onClick={handlePrimaryClick}
        onTouchStart={startLongPress}
        onTouchEnd={cancelLongPress}
        onTouchMove={cancelLongPress}
        aria-pressed={currentReaction !== null}
        aria-label={selectedReaction?.label ?? "Like"}
        className={cn(className, "gap-1.5", currentReaction && "text-primary")}
      >
        {selectedReaction ? (
          <span className="text-base leading-none">{selectedReaction.emoji}</span>
        ) : (
          <ThumbsUp className="h-4 w-4" />
        )}
        {totalCount > 0 ? <span className="text-xs tabular-nums">{totalCount}</span> : null}
      </Button>

      {open ? (
        <>
          {/* Tap-away layer for touch devices. */}
          <div className="fixed inset-0 z-40" aria-hidden onClick={() => setOpen(false)} />
          <div
            className="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 rounded-full border border-white/15 bg-popover/95 px-2 py-1.5 shadow-lg backdrop-blur-sm"
            onMouseEnter={openPicker}
            onMouseLeave={scheduleClose}
          >
            <div className="flex items-center gap-1">
              {REACTIONS.map((reaction) => (
                <button
                  key={reaction.type}
                  type="button"
                  className="rounded-full p-1.5 text-2xl leading-none transition-transform hover:scale-125"
                  aria-label={reaction.label}
                  onClick={() => void handleSelectReaction(reaction.type)}
                >
                  {reaction.emoji}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
