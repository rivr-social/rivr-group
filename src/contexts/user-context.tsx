"use client"

import { createContext, useContext, useState, type ReactNode } from "react"
import { useSession } from "next-auth/react"
import type { User } from "@/lib/types"

interface UserContextType {
  currentUser: User | null
  setCurrentUser: (user: User | null) => void
  isCreator: (creatorId: string | undefined) => boolean
  isAdmin: (adminIds: string[] | undefined) => boolean
  isSuperAdmin: () => boolean
}

const UserContext = createContext<UserContextType>({
  currentUser: null,
  setCurrentUser: () => {},
  isCreator: () => false,
  isAdmin: () => false,
  isSuperAdmin: () => false,
})

export function UserProvider({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession()
  const [overrideUser, setOverrideUser] = useState<User | null>(null)

  const sessionUser: User | null =
    status === "authenticated" && session?.user?.id
      ? {
          id: session.user.id,
          name: session.user.name || "User",
          username: (session.user.email?.split("@")[0] || session.user.id).toLowerCase(),
          email: session.user.email || undefined,
          avatar: session.user.image || "/placeholder-user.jpg",
          followers: 0,
          following: 0,
          role: "member",
        }
      : null

  const currentUser = overrideUser ?? sessionUser

  const isCreator = (creatorId: string | undefined) => {
    if (!currentUser || !creatorId) return false
    return currentUser.id === creatorId
  }

  const isAdmin = (adminIds: string[] | undefined) => {
    if (!currentUser || !adminIds) return false
    return adminIds.includes(currentUser.id)
  }

  const isSuperAdmin = () => {
    if (!currentUser) return false
    return currentUser.role === "superadmin"
  }

  return (
    <UserContext.Provider value={{ currentUser, setCurrentUser: setOverrideUser, isCreator, isAdmin, isSuperAdmin }}>
      {children}
    </UserContext.Provider>
  )
}

export const useUser = () => useContext(UserContext)
