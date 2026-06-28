"use client"

/**
 * NewsletterTab — Group admin surface for composing and sending newsletters.
 *
 * Attaches under the "Press" tab on the group detail page as a sub-tab
 * visible only to group admins. Provides:
 * - A draft editor (subject + HTML body textarea) with a "Pull from Press" picker.
 * - A history view listing all sent newsletters and drafts.
 *
 * All mutations call server actions from `@/app/actions/newsletter`; recipient
 * emails are resolved server-side only and never touch this component.
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import { Calendar, CheckCircle, Clock, Loader2, Mail, Plus, Send, X } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/use-toast"
import {
  createNewsletterDraftAction,
  updateNewsletterDraftAction,
  composeNewsletterFromPressAction,
  sendNewsletterAction,
  listGroupNewslettersAction,
  type NewsletterSummary,
} from "@/app/actions/newsletter"
import type { PressFeedItem } from "@/app/actions/press"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NewsletterTabProps = {
  groupId: string
  isGroupAdmin: boolean
  /** Press feed items surfaced from the parent PressTab to avoid a second fetch. */
  pressItems?: PressFeedItem[]
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Status badge for a newsletter (draft / sent).
 */
function StatusBadge({ status }: { status: "draft" | "sent" }) {
  if (status === "sent") {
    return (
      <Badge variant="default" className="gap-1">
        <CheckCircle className="h-3 w-3" />
        Sent
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Clock className="h-3 w-3" />
      Draft
    </Badge>
  )
}

/**
 * A single newsletter card in the history list.
 */
function NewsletterHistoryCard({
  newsletter,
  onEditDraft,
}: {
  newsletter: NewsletterSummary
  onEditDraft: (nl: NewsletterSummary) => void
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={newsletter.status} />
            <span className="font-medium truncate">{newsletter.subject}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {newsletter.status === "sent" && newsletter.sentAt ? (
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Sent {new Date(newsletter.sentAt).toLocaleDateString()}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Created {new Date(newsletter.createdAt).toLocaleDateString()}
              </span>
            )}
            {newsletter.recipientCount !== null && (
              <span className="inline-flex items-center gap-1">
                <Mail className="h-3 w-3" />
                {newsletter.recipientCount} recipient{newsletter.recipientCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
        {newsletter.status === "draft" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEditDraft(newsletter)}
            className="shrink-0"
          >
            Edit
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Press item picker — checkboxes to select which press items to pull into the draft.
 */
function PressItemPicker({
  items,
  selected,
  onToggle,
}: {
  items: PressFeedItem[]
  selected: Set<string>
  onToggle: (id: string) => void
}) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No press items available. Add Substack, YouTube, or Instagram sources in the Press tab to pull in content.
      </p>
    )
  }

  return (
    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
      {items.map((item) => (
        <label
          key={item.id}
          className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:bg-muted/50 transition-colors"
        >
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0"
            checked={selected.has(item.id)}
            onChange={() => onToggle(item.id)}
          />
          <div className="min-w-0">
            <p className="text-sm font-medium leading-snug">{item.title}</p>
            {item.excerpt && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{item.excerpt}</p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5 capitalize">{item.source}</p>
          </div>
        </label>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Full newsletter management surface for group admins.
 *
 * Non-admins receive a fallback prompt explaining that newsletters are an
 * admin feature — this matches the pattern used elsewhere in group-tabs-client.
 */
export function NewsletterTab({
  groupId,
  isGroupAdmin,
  pressItems = [],
}: NewsletterTabProps) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  // Editor state
  const [activeView, setActiveView] = useState<"compose" | "history">("history")
  const [editingNewsletterId, setEditingNewsletterId] = useState<string | null>(null)
  const [subject, setSubject] = useState("")
  const [bodyHtml, setBodyHtml] = useState("")
  const [selectedPressIds, setSelectedPressIds] = useState<Set<string>>(new Set())
  const [showPressPicker, setShowPressPicker] = useState(false)

  // History state
  const [newsletters, setNewsletters] = useState<NewsletterSummary[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  // Load history on mount.
  const loadHistory = useCallback(() => {
    startTransition(async () => {
      const result = await listGroupNewslettersAction(groupId)
      if (result.success) {
        setNewsletters(result.newsletters)
        setHistoryLoaded(true)
        setHistoryError(null)
      } else {
        setHistoryError(result.error ?? "Failed to load newsletters.")
        setHistoryLoaded(true)
      }
    })
  }, [groupId])

  useEffect(() => {
    if (isGroupAdmin) loadHistory()
  }, [isGroupAdmin, loadHistory])

  // Toggle a press item in the picker.
  const togglePressItem = useCallback((id: string) => {
    setSelectedPressIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Pull selected press items into the body.
  const handlePullFromPress = () => {
    startTransition(async () => {
      const result = await composeNewsletterFromPressAction({
        groupId,
        pressItemIds: Array.from(selectedPressIds),
      })
      if (!result.success) {
        toast({
          title: "Could not compose from press",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        })
        return
      }
      if (!subject) setSubject(result.subject)
      setBodyHtml(result.bodyHtml)
      setShowPressPicker(false)
      toast({ title: "Press content pulled into draft." })
    })
  }

  // Start a new blank draft.
  const handleStartNewDraft = () => {
    setEditingNewsletterId(null)
    setSubject("")
    setBodyHtml("")
    setSelectedPressIds(new Set())
    setShowPressPicker(false)
    setActiveView("compose")
  }

  // Load a draft into the editor.
  const handleEditDraft = (nl: NewsletterSummary) => {
    setEditingNewsletterId(nl.id)
    setSubject(nl.subject)
    setBodyHtml(nl.bodyHtml)
    setSelectedPressIds(new Set(nl.sourcePressItemIds))
    setShowPressPicker(false)
    setActiveView("compose")
  }

  // Save / update draft.
  const handleSaveDraft = () => {
    if (!subject.trim() || !bodyHtml.trim()) {
      toast({
        title: "Subject and body are required.",
        variant: "destructive",
      })
      return
    }

    startTransition(async () => {
      let result: { success: boolean; message: string; newsletterId?: string; error?: string }

      if (editingNewsletterId) {
        result = await updateNewsletterDraftAction({
          newsletterId: editingNewsletterId,
          subject,
          bodyHtml,
        })
      } else {
        result = await createNewsletterDraftAction({
          groupId,
          subject,
          bodyHtml,
          sourcePressItemIds: Array.from(selectedPressIds),
        })
        if (result.success && result.newsletterId) {
          setEditingNewsletterId(result.newsletterId)
        }
      }

      if (!result.success) {
        toast({
          title: "Failed to save draft",
          description: result.error ?? result.message,
          variant: "destructive",
        })
        return
      }

      toast({ title: "Draft saved." })
      loadHistory()
    })
  }

  // Send newsletter.
  const handleSend = () => {
    if (!editingNewsletterId) {
      toast({
        title: "Save the draft first before sending.",
        variant: "destructive",
      })
      return
    }

    const confirmed = window.confirm(
      "Send this newsletter to all group members with an email address? This cannot be undone.",
    )
    if (!confirmed) return

    startTransition(async () => {
      const result = await sendNewsletterAction({ newsletterId: editingNewsletterId! })
      if (!result.success) {
        toast({
          title: "Send failed",
          description: result.error ?? result.message,
          variant: "destructive",
        })
        return
      }

      toast({
        title: "Newsletter sent!",
        description: result.message,
      })

      // Reset editor, go back to history.
      setEditingNewsletterId(null)
      setSubject("")
      setBodyHtml("")
      setSelectedPressIds(new Set())
      setActiveView("history")
      loadHistory()
    })
  }

  if (!isGroupAdmin) {
    return (
      <p className="text-sm text-muted-foreground">
        Newsletters are managed by group admins.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <Tabs value={activeView} onValueChange={(v) => setActiveView(v as "compose" | "history")}>
        <div className="flex items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="compose">
              {editingNewsletterId ? "Edit Draft" : "New Newsletter"}
            </TabsTrigger>
          </TabsList>
          <Button size="sm" variant="outline" onClick={handleStartNewDraft} disabled={isPending}>
            <Plus className="mr-1.5 h-4 w-4" />
            New
          </Button>
        </div>

        {/* ---- History view ---- */}
        <TabsContent value="history" className="mt-4 space-y-3">
          {!historyLoaded && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading newsletter history…
            </div>
          )}
          {historyLoaded && historyError && (
            <Alert variant="destructive">
              <AlertDescription>{historyError}</AlertDescription>
            </Alert>
          )}
          {historyLoaded && !historyError && newsletters.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No newsletters yet. Click <strong>New</strong> to compose your first one.
            </p>
          )}
          {newsletters.map((nl) => (
            <NewsletterHistoryCard
              key={nl.id}
              newsletter={nl}
              onEditDraft={handleEditDraft}
            />
          ))}
        </TabsContent>

        {/* ---- Compose / Edit view ---- */}
        <TabsContent value="compose" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5" />
                {editingNewsletterId ? "Edit Draft" : "New Newsletter"}
              </CardTitle>
              <CardDescription>
                Compose a newsletter to send to all group members with an email address.
                Recipient emails are never exposed to the browser.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Subject */}
              <div className="space-y-2">
                <Label htmlFor="newsletter-subject">Subject</Label>
                <Input
                  id="newsletter-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Your newsletter subject line"
                  disabled={isPending}
                />
              </div>

              {/* Pull from press */}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPressPicker((v) => !v)}
                  disabled={isPending}
                >
                  {showPressPicker ? (
                    <X className="mr-1.5 h-4 w-4" />
                  ) : (
                    <Plus className="mr-1.5 h-4 w-4" />
                  )}
                  {showPressPicker ? "Close press picker" : "Pull from Press"}
                </Button>

                {showPressPicker && (
                  <div className="mt-3 space-y-3 rounded-md border p-3">
                    <p className="text-sm font-medium">Select press items to include</p>
                    <PressItemPicker
                      items={pressItems}
                      selected={selectedPressIds}
                      onToggle={togglePressItem}
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={handlePullFromPress}
                      disabled={isPending}
                    >
                      {isPending ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="mr-1.5 h-4 w-4" />
                      )}
                      Generate from selected
                    </Button>
                  </div>
                )}
              </div>

              {/* Body */}
              <div className="space-y-2">
                <Label htmlFor="newsletter-body">
                  Body <span className="text-xs text-muted-foreground">(HTML)</span>
                </Label>
                <Textarea
                  id="newsletter-body"
                  value={bodyHtml}
                  onChange={(e) => setBodyHtml(e.target.value)}
                  placeholder="<p>Write your newsletter content here, or use the Press picker above to pull in items.</p>"
                  className="min-h-64 font-mono text-sm"
                  disabled={isPending}
                />
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 justify-end flex-wrap">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSaveDraft}
                  disabled={isPending || !subject.trim() || !bodyHtml.trim()}
                >
                  {isPending ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Clock className="mr-1.5 h-4 w-4" />
                  )}
                  Save Draft
                </Button>
                <Button
                  type="button"
                  onClick={handleSend}
                  disabled={isPending || !editingNewsletterId || !subject.trim() || !bodyHtml.trim()}
                >
                  {isPending ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="mr-1.5 h-4 w-4" />
                  )}
                  Send to Members
                </Button>
              </div>

              {!editingNewsletterId && (
                <p className="text-xs text-muted-foreground">
                  Save the draft first — this enables the Send button and ensures your work is
                  preserved.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
