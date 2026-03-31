"use client"

/**
 * Notifications page for the main app shell.
 *
 * Route: `/notifications`
 *
 * Purpose:
 * - Display the signed-in user's notifications grouped by tab filters.
 * - Allow marking individual notifications (or all visible notifications) as read/unread.
 * - Navigate to a context-specific destination for each notification.
 *
 * Data requirements:
 * - Notification rows from `fetchNotifications()`.
 * - Persisted read-state map from `fetchNotificationReadState(notificationIds)`.
 *
 * Rendering notes:
 * - Client component (`"use client"`), rendered and hydrated in the browser.
 * - No `metadata` export is defined in this file; metadata is managed elsewhere in the app tree.
 */
import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ResponsiveTabsList } from "@/components/responsive-tabs-list"
import { ChevronLeft, Bell } from "lucide-react"
import {
  fetchNotifications,
  fetchNotificationReadState,
  markAllNotificationsAsRead,
  setNotificationReadState,
  type SerializedNotification,
} from "@/app/actions/inbox"

/**
 * Builds a compact avatar fallback from a display name.
 */
function initials(name?: string) {
  if (!name) return "UN"
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

/**
 * Resolves the navigation target for a notification based on its type and target entity.
 */
function resolveNotificationLink(notification: SerializedNotification): string {
  const targetId = notification.targetId;
  const type = notification.type;

  if (type === "react" || type === "comment" || type === "share") {
    if (targetId) return `/posts/${targetId}`;
    return "/notifications";
  }

  if (type === "follow") {
    if (notification.actorUsername) return `/profile/${notification.actorUsername}`;
    return "/notifications";
  }

  if (type === "join") {
    if (targetId) return `/groups/${targetId}`;
    return "/notifications";
  }

  if (type === "attend") {
    if (targetId) return `/events/${targetId}`;
    return "/notifications";
  }

  return targetId ? `/posts/${targetId}` : "/notifications";
}

/**
 * Renders the notifications experience with tab filtering and read-state management.
 */
export default function NotificationsPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState("all")
  const [pendingAllRead, setPendingAllRead] = useState(false)
  const [notifications, setNotifications] = useState<SerializedNotification[]>([])
  const [readState, setReadState] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    const CACHE_KEY = "rivr.notifications.cache"
    const CACHE_TTL_MS = 1000 * 60 * 2

    // Phase 1: Instant read from sessionStorage cache.
    try {
      const cached = sessionStorage.getItem(CACHE_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as { ts: number; data: SerializedNotification[] }
        if (Date.now() - parsed.ts < CACHE_TTL_MS && parsed.data.length > 0) {
          setNotifications(parsed.data)
        }
      }
    } catch {
      // sessionStorage unavailable or corrupt — continue to server fetch.
    }

    // Phase 2: Server fetch for authoritative data.
    fetchNotifications()
      .then(async (rows) => {
        if (cancelled) return
        setNotifications(rows)

        // Persist to sessionStorage for instant reload.
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: rows }))
        } catch {
          // Storage full or unavailable.
        }

        const persisted = await fetchNotificationReadState(rows.map((row) => row.id))
        if (cancelled) return

        setReadState((prev) => ({
          ...prev,
          ...Object.fromEntries(rows.map((row) => [row.id, false])),
          ...persisted,
        }))
      })
      .catch(() => {
        if (cancelled) return
        setNotifications([])
      })

    return () => {
      cancelled = true
    }
  }, [])

  const filteredNotifications = useMemo(() => {
    // Filter notifications by the selected tab.
    return notifications.filter((notification) => {
      if (activeTab === "all") return true
      if (activeTab === "unread") return !readState[notification.id]
      if (activeTab === "following") return notification.type === "follow"
      return notification.type === activeTab
    })
  }, [activeTab, notifications, readState])

  /**
   * Updates local read state optimistically, then persists the change.
   */
  const setRead = async (notificationId: string, isRead: boolean) => {
    setReadState((prev) => ({ ...prev, [notificationId]: isRead }))
    await setNotificationReadState({ notificationId, isRead })
  }

  /**
   * Toggles read status for a single notification.
   */
  const toggleRead = async (notificationId: string) => {
    await setRead(notificationId, !readState[notificationId])
  }

  /**
   * Marks all notifications in the current filtered view as read.
   */
  const markAllRead = async () => {
    setPendingAllRead(true)
    const ids = filteredNotifications.map((notification) => notification.id)

    // Apply optimistic local state for immediate UI feedback.
    setReadState((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = true
      return next
    })

    try {
      await markAllNotificationsAsRead(ids)
    } finally {
      setPendingAllRead(false)
    }
  }

  /**
   * Formats a timestamp into a compact relative time label.
   */
  const formatNotificationTime = (timestamp: string) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / (1000 * 60))
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" className="p-0" onClick={() => router.back()} aria-label="Go back">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-2xl font-bold">Notifications</h1>
      </div>

      <Tabs defaultValue="all" value={activeTab} onValueChange={setActiveTab}>
        <ResponsiveTabsList className="mb-4">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="unread">Unread</TabsTrigger>
          <TabsTrigger value="following">Following</TabsTrigger>
          <TabsTrigger value="react">Reactions</TabsTrigger>
          <TabsTrigger value="comment">Comments</TabsTrigger>
        </ResponsiveTabsList>

        <TabsContent value={activeTab} className="space-y-4">
          {/* Conditional rendering: empty-state view when no notifications match the active tab. */}
          {filteredNotifications.length === 0 ? (
            <div className="text-center py-8">
              <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
                <Bell className="h-8 w-8 text-muted-foreground" />
              </div>
              <h2 className="text-xl font-bold mb-2">No notifications</h2>
              <p className="text-muted-foreground">You don&apos;t have any notifications in this view.</p>
            </div>
          ) : (
            filteredNotifications.map((notification) => {
              const isRead = Boolean(readState[notification.id])
              const link = resolveNotificationLink(notification)

              return (
                <Card
                  key={notification.id}
                  className={`p-4 flex items-center gap-3 ${!isRead ? "border-l-4 border-l-primary" : ""}`}
                >
                  <Link
                    href={link}
                    className="flex items-center gap-3 flex-1 min-w-0"
                    onClick={() => {
                      // Mark as read on navigation if still unread.
                      if (!isRead) {
                        void setRead(notification.id, true)
                      }
                    }}
                  >
                    <Avatar>
                      <AvatarImage src={notification.actorImage || "/placeholder.svg"} alt={notification.actorName} />
                      <AvatarFallback>{initials(notification.actorName)}</AvatarFallback>
                    </Avatar>

                    <div className="flex-1 min-w-0">
                      <p className={`${!isRead ? "font-medium" : ""} truncate`}>
                        <span className="font-medium">{notification.actorName}</span> {notification.message}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatNotificationTime(notification.timestamp)}
                      </p>
                    </div>
                  </Link>

                  <Button variant="outline" size="sm" onClick={() => void toggleRead(notification.id)}>
                    {isRead ? "Mark unread" : "Mark read"}
                  </Button>

                  {!isRead && <div className="w-2 h-2 bg-primary rounded-full" />}
                </Card>
              )
            })
          )}
        </TabsContent>
      </Tabs>

      {/* Conditional rendering: "mark all" action is only shown when there is at least one visible notification. */}
      {filteredNotifications.length > 0 && (
        <div className="mt-6 text-center">
          <Button variant="outline" onClick={() => void markAllRead()} disabled={pendingAllRead}>
            Mark all as read
          </Button>
        </div>
      )}
    </div>
  )
}
