/**
 * @fileoverview UserMenu - Slide-out sheet with user account actions and navigation.
 *
 * Triggered from the global header avatar. Displays the user's profile info,
 * wallet balance, settings links, and sign-out action in a side sheet.
 */
"use client"

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Settings,
  LogOut,
  User,
  Users,
  MessageSquare,
  Pencil,
  Calendar,
  Drama,
  UserCheck,
  UserX,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { signOut, useSession } from "next-auth/react"
import { clearLocalData } from "@/lib/local-db"
import { useCallback, useEffect, useState } from "react"
import { listMyPersonas, switchActivePersona } from "@/app/actions/personas"
import type { SerializedAgent } from "@/lib/graph-serializers"

interface UserMenuProps {
  open: boolean
  onClose: () => void
}

export function UserMenu({ open, onClose }: UserMenuProps) {
  const router = useRouter()
  const { data: session } = useSession()
  const [personas, setPersonas] = useState<SerializedAgent[]>([])
  const [activePersonaId, setActivePersonaId] = useState<string | null>(null)

  const loadPersonas = useCallback(async () => {
    try {
      const result = await listMyPersonas()
      if (result.success && result.personas) {
        setPersonas(result.personas)
        setActivePersonaId(result.activePersonaId ?? null)
      }
    } catch {
      // Silently fail
    }
  }, [])

  useEffect(() => {
    if (open) loadPersonas()
  }, [open, loadPersonas])

  const handleSwitchPersona = async (personaId: string | null) => {
    const result = await switchActivePersona(personaId)
    if (result.success) {
      setActivePersonaId(personaId)
      onClose()
      router.refresh()
    }
  }

  const handleLogout = async () => {
    onClose()
    await clearLocalData()
    await signOut({ callbackUrl: "/auth/login", redirect: true })
  }

  const handleNavigation = (path: string) => {
    router.push(path)
    onClose()
  }

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="right" className="w-[85vw] max-w-[400px] flex flex-col">
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto py-4">
          <div className="flex items-center gap-4 mb-4">
            <Avatar
              className="h-16 w-16 cursor-pointer hover:ring-2 hover:ring-primary transition-all"
              onClick={() => handleNavigation("/profile")}
            >
              <AvatarImage src={session?.user?.image || "/placeholder.svg?height=64&width=64"} alt={session?.user?.name || "User"} />
              <AvatarFallback>{session?.user?.name?.substring(0, 2).toUpperCase() || "U"}</AvatarFallback>
            </Avatar>
            <div>
              <h3 className="font-medium text-lg">{session?.user?.name || "User"}</h3>
              <p className="text-sm text-muted-foreground">{session?.user?.email || ""}</p>
            </div>
          </div>
          <Separator className="my-4" />
          <nav className="flex flex-col gap-2">
            <Link
              href="/profile"
              onClick={() => handleNavigation("/profile")}
              className="flex items-center gap-3 p-2 hover:bg-muted rounded-md transition-colors"
            >
              <User className="h-5 w-5" />
              <span>My Profile</span>
            </Link>
            <Link
              href="/settings"
              onClick={() => handleNavigation("/settings")}
              className="flex items-center gap-3 p-2 hover:bg-muted rounded-md transition-colors"
            >
              <Pencil className="h-5 w-5" />
              <span>Edit Profile</span>
            </Link>
            <Link
              href="/settings"
              onClick={() => handleNavigation("/settings")}
              className="flex items-center gap-3 p-2 hover:bg-muted rounded-md transition-colors"
            >
              <Settings className="h-5 w-5" />
              <span>Profile Settings</span>
            </Link>
            <Link
              href="/groups"
              onClick={() => handleNavigation("/groups")}
              className="flex items-center gap-3 p-2 hover:bg-muted rounded-md transition-colors"
            >
              <Users className="h-5 w-5" />
              <span>My Groups</span>
            </Link>
            <Link
              href="/messages"
              onClick={() => handleNavigation("/messages")}
              className="flex items-center gap-3 p-2 hover:bg-muted rounded-md transition-colors"
            >
              <MessageSquare className="h-5 w-5" />
              <span>Messages</span>
            </Link>
            <Link
              href="/calendar"
              onClick={() => handleNavigation("/calendar")}
              className="flex items-center gap-3 p-2 hover:bg-muted rounded-md transition-colors"
            >
              <Calendar className="h-5 w-5" />
              <span>My Calendar</span>
            </Link>
            {/* Persona switcher section */}
            {personas.length > 0 && (
              <>
                <Separator className="my-2" />
                <div className="px-2 py-1">
                  <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1">
                    <Drama className="h-3.5 w-3.5" />
                    Personas
                  </p>
                </div>
                {activePersonaId && (
                  <button
                    onClick={() => handleSwitchPersona(null)}
                    className="flex items-center gap-3 p-2 hover:bg-muted rounded-md transition-colors w-full text-left"
                  >
                    <UserX className="h-5 w-5" />
                    <span className="text-sm">Switch to main account</span>
                  </button>
                )}
                {personas
                  .filter((p) => p.id !== activePersonaId)
                  .map((persona) => (
                    <button
                      key={persona.id}
                      onClick={() => handleSwitchPersona(persona.id)}
                      className="flex items-center gap-3 p-2 hover:bg-muted rounded-md transition-colors w-full text-left"
                    >
                      <Avatar className="h-5 w-5">
                        <AvatarImage src={persona.image ?? undefined} alt={persona.name} />
                        <AvatarFallback className="text-[10px]">
                          {persona.name.substring(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm">{persona.name}</span>
                    </button>
                  ))}
              </>
            )}
            <Separator className="my-2" />
            <Link
              href="/settings"
              onClick={() => handleNavigation("/settings")}
              className="flex items-center gap-3 p-2 hover:bg-muted rounded-md transition-colors"
            >
              <Settings className="h-5 w-5" />
              <span>Settings</span>
            </Link>
            <Button variant="outline" className="mt-2 w-full justify-start gap-3" onClick={handleLogout}>
              <LogOut className="h-5 w-5" />
              <span>Log Out</span>
            </Button>
          </nav>
        </div>
      </SheetContent>
    </Sheet>
  )
}
