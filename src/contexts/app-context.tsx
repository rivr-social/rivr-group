"use client"

import { createContext, useContext, useState, useEffect, type ReactNode } from "react"
import type { AppState, AppContextType, Group, Event, Post } from "@/lib/types"

const APP_STATE_STORAGE_KEY = "appState"
const APP_STATE_STORAGE_VERSION = 1

const defaultState: AppState = {
  user: null,
  groups: [],
  events: [],
  posts: [],
  notifications: [],
  settings: {},
  selectedChapter: "all", // This will now represent localeId
  likedPosts: [],
  rsvpStatuses: {},
  joinedGroups: [],
  followedUsers: [],
}

// Create context
const AppContext = createContext<AppContextType | undefined>(undefined)

// Provider component
export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(() => {
    if (typeof window !== "undefined") {
      const savedState = localStorage.getItem(APP_STATE_STORAGE_KEY)
      if (savedState) {
        try {
          const parsed = JSON.parse(savedState) as
            | AppState
            | { version?: number; state?: AppState }

          // Backward compatibility for older unversioned payloads.
          if (parsed && typeof parsed === "object") {
            if ("groups" in parsed) {
              return parsed as AppState
            }
            if (
              parsed.version === APP_STATE_STORAGE_VERSION &&
              parsed.state
            ) {
              return parsed.state
            }
          }
        } catch (e) {
          console.error("Failed to parse saved state:", e)
        }
      }
    }
    return defaultState
  })

  // Save state to localStorage when it changes (debounced to avoid blocking main thread)
  useEffect(() => {
    if (typeof window === "undefined") return
    const handle = window.setTimeout(() => {
      localStorage.setItem(
        APP_STATE_STORAGE_KEY,
        JSON.stringify({ version: APP_STATE_STORAGE_VERSION, state })
      )
    }, 500)
    return () => window.clearTimeout(handle)
  }, [state])

  // State update functions
  const setSelectedChapter = (chapterId: string) => {
    setState((prev) => ({ ...prev, selectedChapter: chapterId }))
  }

  const toggleLikePost = (postId: string) => {
    setState((prev) => {
      const likedPosts = prev.likedPosts.includes(postId)
        ? prev.likedPosts.filter((id) => id !== postId)
        : [...prev.likedPosts, postId]
      return { ...prev, likedPosts }
    })
  }

  const setRsvpStatus = (eventId: string, status: "going" | "interested" | "none") => {
    setState((prev) => ({
      ...prev,
      rsvpStatuses: {
        ...prev.rsvpStatuses,
        [eventId]: status,
      },
    }))
  }

  const toggleJoinGroup = (groupId: string) => {
    setState((prev) => {
      const joinedGroups = prev.joinedGroups.includes(groupId)
        ? prev.joinedGroups.filter((id) => id !== groupId)
        : [...prev.joinedGroups, groupId]
      return { ...prev, joinedGroups }
    })
  }

  const toggleFollowUser = (userId: string) => {
    setState((prev) => {
      const followedUsers = prev.followedUsers.includes(userId)
        ? prev.followedUsers.filter((id) => id !== userId)
        : [...prev.followedUsers, userId]
      return { ...prev, followedUsers }
    })
  }

  // Additional methods to match AppContextType
  const dispatch = (action: Record<string, unknown>) => {
    const type = typeof action.type === "string" ? action.type : ""
    const payload = action.payload

    switch (type) {
      case "setSelectedChapter":
        if (typeof payload === "string") {
          setSelectedChapter(payload)
        }
        break
      case "toggleLikePost":
        if (typeof payload === "string") {
          toggleLikePost(payload)
        }
        break
      case "setRsvpStatus":
        if (
          payload &&
          typeof payload === "object" &&
          typeof (payload as Record<string, unknown>).eventId === "string" &&
          (payload as Record<string, unknown>).status &&
          ["going", "interested", "none"].includes(
            String((payload as Record<string, unknown>).status)
          )
        ) {
          const eventId = String((payload as Record<string, unknown>).eventId)
          const status = String((payload as Record<string, unknown>).status) as "going" | "interested" | "none"
          setRsvpStatus(eventId, status)
        }
        break
      case "toggleJoinGroup":
        if (typeof payload === "string") {
          toggleJoinGroup(payload)
        }
        break
      case "toggleFollowUser":
        if (typeof payload === "string") {
          toggleFollowUser(payload)
        }
        break
      default:
        console.warn("Unsupported app context action:", action)
        break
    }
  }

  const addGroup = (group: Group) => {
    setState((prev) => ({ ...prev, groups: [...prev.groups, group] }))
  }

  const removeGroup = (id: string) => {
    setState((prev) => ({ ...prev, groups: prev.groups.filter(g => g.id !== id) }))
  }

  const addEvent = (event: Event) => {
    setState((prev) => ({ ...prev, events: [...prev.events, event] }))
  }

  const removeEvent = (id: string) => {
    setState((prev) => ({ ...prev, events: prev.events.filter(e => e.id !== id) }))
  }

  const addPost = (post: Post) => {
    setState((prev) => ({ ...prev, posts: [...prev.posts, post] }))
  }

  const removePost = (id: string) => {
    setState((prev) => ({ ...prev, posts: prev.posts.filter(p => p.id !== id) }))
  }

  // Context value
  const value: AppContextType = {
    state,
    setSelectedChapter,
    dispatch,
    addGroup,
    removeGroup,
    addEvent,
    removeEvent,
    addPost,
    removePost,
    toggleLikePost,
    setRsvpStatus,
    toggleJoinGroup,
    toggleFollowUser,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

// Custom hook for using the context
export function useAppContext() {
  const context = useContext(AppContext)
  if (context === undefined) {
    throw new Error("useAppContext must be used within an AppProvider")
  }
  return context
}
