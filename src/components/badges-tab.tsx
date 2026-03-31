"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Plus, Award, Users, CheckCircle, Star, Leaf, Wrench, Target } from "lucide-react"
import type { MemberInfo, UserBadge } from "@/types/domain"
import { fetchGroupBadges, fetchUserBadges } from "@/app/actions/graph"
import { createBadgeResourceAction } from "@/app/actions/create-resources"
import { useToast } from "@/components/ui/use-toast"

/**
 * Badge discovery and progress tab for group/community pages.
 *
 * This component is used in the group experience to show:
 * - available badges,
 * - the current member's earned badges,
 * - overall badge stats for the group,
 * - admin-only badge creation UI.
 *
 * Key props:
 * - `groupId`: group identifier (reserved for data scoping).
 * - `currentUserId`: active user id for earned-badge lookups.
 * - `isAdmin`: enables the create-badge dialog controls.
 */
interface BadgesTabProps {
  groupId: string
  currentUserId: string
  isAdmin: boolean
  members?: MemberInfo[]
}

/**
 * Renders the badges tab with stats, filtering tabs, and admin creation modal.
 *
 * @param props - Component props.
 * @param props.groupId - Group id associated with this badge view.
 * @param props.currentUserId - Current user id for earned-badge derivation.
 * @param props.isAdmin - Whether admin-only controls should be shown.
 */
export function BadgesTab({ groupId, currentUserId, isAdmin, members = [] }: BadgesTabProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState("available")
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [groupBadges, setGroupBadges] = useState<UserBadge[]>([])
  const [userBadges, setUserBadges] = useState<UserBadge[]>([])
  const [badgeName, setBadgeName] = useState("")
  const [badgeCategory, setBadgeCategory] = useState("community")
  const [badgeDescription, setBadgeDescription] = useState("")
  const [badgeRequirements, setBadgeRequirements] = useState([""])

  useEffect(() => {
    const toBadge = (b: { id: string; name: string; description: string | null; metadata: Record<string, unknown> | null }): UserBadge => {
      const meta = (b.metadata ?? {}) as Record<string, unknown>
      return {
        id: b.id,
        name: b.name,
        description: b.description ?? "",
        icon: (meta.icon as string) ?? "🏅",
        category: meta.category as string,
        level: (meta.level as UserBadge["level"]) ?? "beginner",
        requirements: (meta.requirements as string[]) ?? [],
        holders: (meta.holders as string[]) ?? [],
        jobsUnlocked: (meta.jobsUnlocked as string[]) ?? [],
        trainingModules: (meta.trainingModules as UserBadge["trainingModules"]) ?? [],
        liveClass: meta.liveClass as UserBadge["liveClass"],
      }
    }
    fetchGroupBadges(groupId).then((badges) => setGroupBadges(badges.map(toBadge)))
    fetchUserBadges(currentUserId).then((badges) => setUserBadges(badges.map(toBadge)))
  }, [groupId, currentUserId])

  // Derive badges not yet earned by comparing ids.
  const availableBadges = groupBadges.filter((badge) => !userBadges.some(ub => ub.id === badge.id))

  const handleCreateBadge = async () => {
    const requirements = badgeRequirements.map((item) => item.trim()).filter(Boolean)
    const result = await createBadgeResourceAction({
      groupId,
      name: badgeName,
      description: badgeDescription,
      category: badgeCategory,
      requirements,
    })

    if (!result.success) {
      toast({ title: "Badge creation failed", description: result.message, variant: "destructive" })
      return
    }

    setGroupBadges((current) => [
      {
        id: result.resourceId ?? `badge-${Date.now()}`,
        name: badgeName.trim(),
        description: badgeDescription.trim(),
        icon: "🏅",
        category: badgeCategory,
        level: "beginner",
        requirements,
        holders: [],
        jobsUnlocked: [],
        trainingModules: [],
        liveClass: undefined,
      },
      ...current,
    ])
    setBadgeName("")
    setBadgeDescription("")
    setBadgeCategory("community")
    setBadgeRequirements([""])
    setIsCreateModalOpen(false)
    toast({ title: "Badge created", description: "The badge is now available in this group." })
    router.refresh()
  }

  // Presentation helper: choose icon by badge category.
  const getCategoryIcon = (category?: string) => {
    switch (category) {
      case "environmental":
        return <Leaf className="h-4 w-4" />
      case "leadership":
        return <Users className="h-4 w-4" />
      case "technical":
        return <Wrench className="h-4 w-4" />
      default:
        return <Award className="h-4 w-4" />
    }
  }

  // Presentation helper: choose icon background color by category.
  const getCategoryColor = (category?: string) => {
    switch (category) {
      case "environmental": return "#22c55e"
      case "technical": return "#3b82f6"
      case "leadership": return "#8b5cf6"
      case "creative": return "#ec4899"
      case "community": return "#f59e0b"
      case "business": return "#6366f1"
      default: return "#6b7280"
    }
  }

  /**
   * Reusable badge card renderer for all tab views.
   *
   * @param props - Badge card props.
   * @param props.badge - Badge metadata and progress information.
   * @param props.isEarned - Whether current user has earned the badge.
   */
  const BadgeCard = ({ badge, isEarned = false }: { badge: UserBadge; isEarned?: boolean }) => (
    <Link href={`/badges/${badge.id}`}>
      <Card className={`transition-all hover:shadow-md cursor-pointer ${isEarned ? "border-green-200 bg-green-50" : ""}`}>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center space-x-3">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center text-2xl"
                style={{ backgroundColor: getCategoryColor(badge.category) + "20" }}
              >
                {badge.icon}
              </div>
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  {badge.name}
                  {/* Conditional rendering: show completion icon only for earned badges. */}
                  {isEarned && <CheckCircle className="h-5 w-5 text-green-600" />}
                </CardTitle>
                <div className="flex items-center gap-2 mt-1">
                  {getCategoryIcon(badge.category)}
                  <span className="text-sm text-muted-foreground capitalize">{badge.category}</span>
                </div>
              </div>
            </div>
            <Badge variant={isEarned ? "default" : "secondary"} className="text-xs">
              {badge.holders?.length || 0} holders
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{badge.description}</p>

          {/* Requirements */}
          {badge.requirements && badge.requirements.length > 0 && (
            <div>
              <h4 className="font-medium text-sm mb-2">Requirements:</h4>
              <ul className="space-y-1">
                {badge.requirements.map((req: string, index: number) => (
                  <li key={index} className="flex items-start gap-2 text-sm">
                    <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground mt-2 flex-shrink-0" />
                    {req}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Jobs Unlocked */}
          {badge.jobsUnlocked && badge.jobsUnlocked.length > 0 && (
            <div>
              <h4 className="font-medium text-sm mb-2">Jobs Unlocked:</h4>
              <div className="flex flex-wrap gap-1">
                {badge.jobsUnlocked.map((job: string) => (
                  <Badge key={job} variant="outline" className="text-xs">
                    {job}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Badge Holders */}
          {badge.holders && badge.holders.length > 0 && (
            <div>
              <h4 className="font-medium text-sm mb-2">Badge Holders:</h4>
              <div className="flex -space-x-2">
                {badge.holders.slice(0, 5).map((holderId: string) => {
                  const holder = members.find((u) => u.id === holderId)
                  return (
                    <Avatar key={holderId} className="h-8 w-8 border-2 border-background">
                      <AvatarImage src={holder?.avatar || "/placeholder.svg"} alt={holder?.name} />
                      <AvatarFallback className="text-xs">{holder?.name?.substring(0, 2).toUpperCase() || "?"}</AvatarFallback>
                    </Avatar>
                  )
                })}
                {badge.holders.length > 5 && (
                  <div className="h-8 w-8 rounded-full bg-muted border-2 border-background flex items-center justify-center">
                    <span className="text-xs font-medium">+{badge.holders.length - 5}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Training Info */}
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            {badge.trainingModules && badge.trainingModules.length > 0 && (
              <span>{badge.trainingModules.length} modules</span>
            )}
            {badge.liveClass && (
              <span>Live class available</span>
            )}
            <span className="capitalize">{badge.level} level</span>
          </div>

          {/* Action Button */}
          <div className="pt-2">
            {/* Conditional rendering: button content depends on earned status. */}
            {isEarned ? (
              <Button variant="outline" size="sm" className="w-full" asChild>
                <span>
                  <CheckCircle className="mr-2 h-4 w-4" />
                  View Badge Details
                </span>
              </Button>
            ) : (
              <Button variant="default" size="sm" className="w-full" asChild>
                <span>
                  <Target className="mr-2 h-4 w-4" />
                  Start Training
                </span>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Group Badges</h2>
          <p className="text-muted-foreground">Earn badges to unlock job opportunities and show your skills</p>
        </div>
        {isAdmin && (
          // Conditional rendering: only admins can open and use badge creation controls.
          <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Create Badge
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Create New Badge</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="badge-name">Badge Name</Label>
                    <Input id="badge-name" placeholder="e.g., Plant Steward" value={badgeName} onChange={(event) => setBadgeName(event.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="badge-category">Category</Label>
                    <Select value={badgeCategory} onValueChange={setBadgeCategory}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="environmental">Environmental</SelectItem>
                        <SelectItem value="leadership">Leadership</SelectItem>
                        <SelectItem value="technical">Technical</SelectItem>
                        <SelectItem value="community">Community</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label htmlFor="badge-description">Description</Label>
                  <Textarea id="badge-description" placeholder="Describe what this badge represents..." value={badgeDescription} onChange={(event) => setBadgeDescription(event.target.value)} />
                </div>
                <div>
                  <Label>Requirements</Label>
                  <div className="space-y-2 mt-2">
                    {badgeRequirements.map((requirement, index) => (
                      <Input
                        key={`requirement-${index}`}
                        placeholder={`Requirement ${index + 1}`}
                        value={requirement}
                        onChange={(event) => setBadgeRequirements((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
                      />
                    ))}
                    <Button variant="outline" size="sm" onClick={() => setBadgeRequirements((current) => [...current, ""])}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add Requirement
                    </Button>
                  </div>
                </div>
                <div className="flex justify-end space-x-2">
                  <Button variant="outline" onClick={() => setIsCreateModalOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={() => void handleCreateBadge()} disabled={!badgeName.trim() || !badgeDescription.trim()}>Create Badge</Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center space-x-2">
              <Award className="h-5 w-5 text-blue-600" />
              <div>
                <p className="text-sm font-medium">Total Badges</p>
                <p className="text-2xl font-bold">{groupBadges.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center space-x-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
              <div>
                <p className="text-sm font-medium">Your Badges</p>
                <p className="text-2xl font-bold">{userBadges.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center space-x-2">
              <Target className="h-5 w-5 text-orange-600" />
              <div>
                <p className="text-sm font-medium">Available</p>
                <p className="text-2xl font-bold">{availableBadges.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center space-x-2">
              <Star className="h-5 w-5 text-yellow-600" />
              <div>
                <p className="text-sm font-medium">Progress</p>
                <p className="text-2xl font-bold">{Math.round((userBadges.length / groupBadges.length) * 100)}%</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      {/* Controlled tab state determines which badge collection/empty state is rendered. */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="available">Available Badges</TabsTrigger>
          <TabsTrigger value="earned">My Badges ({userBadges.length})</TabsTrigger>
          <TabsTrigger value="all">All Badges</TabsTrigger>
        </TabsList>

        <TabsContent value="available" className="space-y-4">
          {/* Conditional rendering: show grid when options exist, otherwise completion empty state. */}
          {availableBadges.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {availableBadges.map((badge) => (
                <BadgeCard key={badge.id} badge={badge} />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="p-8 text-center">
                <CheckCircle className="h-12 w-12 text-green-600 mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">All Badges Earned!</h3>
                <p className="text-muted-foreground">
                  Congratulations! You&apos;ve earned all available badges in this group.
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="earned" className="space-y-4">
          {/* Conditional rendering: show earned cards or a CTA that switches to available tab. */}
          {userBadges.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {userBadges.map((badge) => (
                <BadgeCard key={badge.id} badge={badge} isEarned={true} />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="p-8 text-center">
                <Award className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No Badges Yet</h3>
                <p className="text-muted-foreground mb-4">
                  Start working towards your first badge to unlock job opportunities!
                </p>
                <Button onClick={() => setActiveTab("available")}>
                  <Target className="mr-2 h-4 w-4" />
                  Browse Available Badges
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="all" className="space-y-4">
          {/* Render every group badge while marking earned state per badge. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {groupBadges.map((badge) => (
              <BadgeCard key={badge.id} badge={badge} isEarned={userBadges.some(ub => ub.id === badge.id)} />
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
