/**
 * @fileoverview FollowButton - A toggle button with a notification-preferences popover.
 *
 * Used across posts, events, groups, and person profiles to let users follow/unfollow
 * content and configure email/push notification preferences. For groups, the user must
 * first be a joined member before following is allowed.
 *
 * Key props: objectId, objectType, isJoined, onFollowChange, initialFollowed, initialPreferences
 */
"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Bell } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { toggleFollowAgent } from "@/app/actions/interactions/social"

interface FollowButtonProps {
  objectId: string
  objectType: "post" | "event" | "group" | "person"
  isJoined?: boolean // Only relevant for groups
  onFollowChange?: (followed: boolean, preferences: FollowPreferences) => void
  initialFollowed?: boolean
  initialPreferences?: FollowPreferences
  size?: "default" | "sm" | "lg" | "icon"
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
}

export interface FollowPreferences {
  email: boolean
  push: boolean
}

/**
 * Renders a follow/unfollow button with a popover for configuring notification preferences.
 *
 * @param {FollowButtonProps} props
 * @param {string} props.objectId - Unique identifier for the object being followed
 * @param {"post" | "event" | "group" | "person"} props.objectType - Type of object being followed
 * @param {boolean} [props.isJoined=true] - Whether the user is a member (only relevant for groups)
 * @param {(followed: boolean, preferences: FollowPreferences) => void} [props.onFollowChange] - Callback on follow state change
 * @param {boolean} [props.initialFollowed=false] - Initial follow state
 * @param {FollowPreferences} [props.initialPreferences] - Initial notification preferences
 * @param {string} [props.size="default"] - Button size variant
 * @param {string} [props.variant="outline"] - Button style variant
 */
export function FollowButton({
  objectId,
  objectType,
  isJoined = true, // Default to true for non-group objects
  onFollowChange,
  initialFollowed = false,
  initialPreferences = { email: true, push: true },
  size = "default",
  variant = "outline",
}: FollowButtonProps) {
  /** Tracks whether the user is currently following this object */
  const [isFollowed, setIsFollowed] = useState(initialFollowed)
  /** Stores user notification preferences (email & push toggles) */
  const [preferences, setPreferences] = useState<FollowPreferences>(initialPreferences)
  /** Controls visibility of the notification preferences popover */
  const [isOpen, setIsOpen] = useState(false)
  const { toast } = useToast()

  // For groups, we need to check if the user has joined
  const canFollow = objectType !== "group" || isJoined

  /** Handles the primary button click: opens preferences popover to follow, or unfollows if already following. */
  const handleFollowClick = async () => {
    if (!canFollow) {
      toast({
        title: "Join group first",
        description: "You need to join this group before you can follow it.",
        duration: 3000,
      })
      return
    }

    if (!isFollowed) {
      // If not currently following, open the popover to select preferences
      setIsOpen(true)
    } else {
      // If already following, unfollow directly
      const result = await toggleFollowAgent(objectId)
      if (!result.success) {
        toast({ title: "Could not unfollow", description: result.message, variant: "destructive", duration: 3000 })
        return
      }
      setIsFollowed(false)
      if (onFollowChange) {
        onFollowChange(false, preferences)
      }
      toast({
        title: "Unfollowed",
        description: `You will no longer receive notifications for this ${objectType}.`,
        duration: 3000,
      })
    }
  }

  /** Confirms the follow action with selected notification preferences, then closes the popover. */
  const handleSavePreferences = async () => {
    const result = await toggleFollowAgent(objectId)
    if (!result.success) {
      toast({ title: "Could not follow", description: result.message, variant: "destructive", duration: 3000 })
      return
    }
    setIsFollowed(true)
    setIsOpen(false)
    if (onFollowChange) {
      onFollowChange(true, preferences)
    }
    toast({
      title: "Following",
      description: `You will now receive notifications for this ${objectType}.`,
      duration: 3000,
    })
  }

  /** Updates a single notification preference (email or push) in local state. */
  const handlePreferenceChange = (type: keyof FollowPreferences, value: boolean) => {
    setPreferences((prev) => ({ ...prev, [type]: value }))
  }

  return (
    <Popover open={isOpen && canFollow} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={isFollowed ? "default" : variant}
          size={size}
          onClick={() => void handleFollowClick()}
          className={isFollowed ? "bg-primary hover:bg-primary/90" : ""}
        >
          <Bell className="h-4 w-4 mr-2" />
          {isFollowed ? "Following" : "Follow"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="space-y-4">
          <h4 className="font-medium text-sm">Notification Preferences</h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="email-notifications" className="flex-1">
                Email Notifications
              </Label>
              <Switch
                id="email-notifications"
                checked={preferences.email}
                onCheckedChange={(checked) => handlePreferenceChange("email", checked)}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="push-notifications" className="flex-1">
                Mobile Notifications
              </Label>
              <Switch
                id="push-notifications"
                checked={preferences.push}
                onCheckedChange={(checked) => handlePreferenceChange("push", checked)}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => void handleSavePreferences()}>Save Preferences</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
