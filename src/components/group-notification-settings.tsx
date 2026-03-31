/**
 * @fileoverview GroupNotificationSettings - Per-group notification preferences for a user.
 *
 * Displayed in the group settings panel. Lets users toggle notification channels
 * (in-app, email, SMS) for each notification category (posts, events, marketplace,
 * governance, member updates). Provides both a read-only summary and an edit mode.
 *
 * Key props: groupId, userId, settings, onSave
 */
"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Bell, Mail, MessageSquare, Calendar, ShoppingBag, Vote, Users, Smartphone } from "lucide-react"
import { type GroupNotificationSettings, NotificationType } from "@/lib/types"

interface NotificationSettingsProps {
  groupId: string
  userId: string
  settings: GroupNotificationSettings
  onSave: (settings: GroupNotificationSettings) => void
}

/**
 * Renders a card with grouped notification toggles per category and notification type.
 *
 * @param {NotificationSettingsProps} props
 * @param {string} props.groupId - The group whose notifications are being configured
 * @param {string} props.userId - The current user's ID
 * @param {GroupNotificationSettings} props.settings - Current notification preferences
 * @param {(settings: GroupNotificationSettings) => void} props.onSave - Callback with updated preferences
 */
export function GroupNotificationSettings({ groupId: _groupId, userId: _userId, settings, onSave }: NotificationSettingsProps) {
  const [notificationSettings, setNotificationSettings] = useState<GroupNotificationSettings>(settings)
  const [isEditing, setIsEditing] = useState(false)

  const toggleNotificationType = (category: keyof GroupNotificationSettings, type: NotificationType) => {
    const currentTypes = notificationSettings[category]
    let updatedTypes: NotificationType[]

    if (currentTypes.includes(type)) {
      updatedTypes = currentTypes.filter((t) => t !== type)
    } else {
      updatedTypes = [...currentTypes, type]
    }

    setNotificationSettings({
      ...notificationSettings,
      [category]: updatedTypes,
    })
  }

  const handleSave = () => {
    onSave(notificationSettings)
    setIsEditing(false)
  }

  const getNotificationIcon = (type: NotificationType) => {
    switch (type) {
      case NotificationType.Native:
        return <Bell className="h-4 w-4" />
      case NotificationType.Email:
        return <Mail className="h-4 w-4" />
      case NotificationType.Text:
        return <Smartphone className="h-4 w-4" />
    }
  }

  const getCategoryIcon = (category: keyof GroupNotificationSettings) => {
    switch (category) {
      case "posts":
        return <MessageSquare className="h-5 w-5" />
      case "events":
        return <Calendar className="h-5 w-5" />
      case "marketplace":
        return <ShoppingBag className="h-5 w-5" />
      case "governance":
        return <Vote className="h-5 w-5" />
      case "memberUpdates":
        return <Users className="h-5 w-5" />
    }
  }

  const getCategoryLabel = (category: keyof GroupNotificationSettings) => {
    switch (category) {
      case "posts":
        return "Posts"
      case "events":
        return "Events"
      case "marketplace":
        return "Mart"
      case "governance":
        return "Governance"
      case "memberUpdates":
        return "Member Updates"
    }
  }

  const getNotificationTypeLabel = (type: NotificationType) => {
    switch (type) {
      case NotificationType.Native:
        return "In-app"
      case NotificationType.Email:
        return "Email"
      case NotificationType.Text:
        return "Text/SMS"
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <div>
            <CardTitle>Notification Settings</CardTitle>
            <CardDescription>Control how you receive notifications from this group</CardDescription>
          </div>
          {!isEditing ? (
            <Button onClick={() => setIsEditing(true)}>Edit Settings</Button>
          ) : (
            <Button variant="outline" onClick={() => setIsEditing(false)}>
              Cancel
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!isEditing ? (
          <div className="space-y-4">
            {(Object.keys(notificationSettings) as Array<keyof GroupNotificationSettings>).map((category) => (
              <div key={category} className="flex items-start gap-3 p-3 border rounded-md">
                <div className="mt-1">{getCategoryIcon(category)}</div>
                <div className="flex-1">
                  <p className="font-medium">{getCategoryLabel(category)}</p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {notificationSettings[category].length > 0 ? (
                      notificationSettings[category].map((type) => (
                        <div key={type} className="flex items-center gap-1 text-sm bg-muted px-2 py-1 rounded-md">
                          {getNotificationIcon(type)}
                          <span>{getNotificationTypeLabel(type)}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">No notifications enabled</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-6">
            {(Object.keys(notificationSettings) as Array<keyof GroupNotificationSettings>).map((category) => (
              <div key={category} className="space-y-4">
                <div className="flex items-center gap-2">
                  {getCategoryIcon(category)}
                  <h3 className="text-lg font-medium">{getCategoryLabel(category)}</h3>
                </div>

                <div className="grid gap-4 pl-7">
                  <div className="flex items-center space-x-2">
                    <Switch
                      id={`${category}-native`}
                      checked={notificationSettings[category].includes(NotificationType.Native)}
                      onCheckedChange={() => toggleNotificationType(category, NotificationType.Native)}
                    />
                    <Label htmlFor={`${category}-native`} className="flex items-center gap-2">
                      <Bell className="h-4 w-4" />
                      In-app Notifications
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Switch
                      id={`${category}-email`}
                      checked={notificationSettings[category].includes(NotificationType.Email)}
                      onCheckedChange={() => toggleNotificationType(category, NotificationType.Email)}
                    />
                    <Label htmlFor={`${category}-email`} className="flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      Email Notifications
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Switch
                      id={`${category}-text`}
                      checked={notificationSettings[category].includes(NotificationType.Text)}
                      onCheckedChange={() => toggleNotificationType(category, NotificationType.Text)}
                    />
                    <Label htmlFor={`${category}-text`} className="flex items-center gap-2">
                      <Smartphone className="h-4 w-4" />
                      Text/SMS Notifications
                    </Label>
                  </div>
                </div>

                {category !== "memberUpdates" && <Separator />}
              </div>
            ))}

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave}>Save Changes</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
