"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Clock,
  Users,
  PlayCircle,
  BookOpen,
  HelpCircle,
  Award,
  MapPin,
  CheckCircle,
  Star,
  Search
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import Link from "next/link"
import type { UserBadge, JobShift } from "@/types/domain"

interface BadgesPageClientProps {
  allBadges: UserBadge[]
  userBadges: UserBadge[]
  jobShifts: JobShift[]
}

export function BadgesPageClient({ allBadges, userBadges, jobShifts }: BadgesPageClientProps) {
  const [activeTab, setActiveTab] = useState("all")
  const [searchTerm, setSearchTerm] = useState("")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [levelFilter, setLevelFilter] = useState("all")

  const userBadgeIds = userBadges.map(b => b.id)

  // Filter badges based search and filters
  const filteredBadges = allBadges.filter(badge => {
    const matchesSearch = badge.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         badge.description.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesCategory = categoryFilter === "all" || badge.category === categoryFilter
    const matchesLevel = levelFilter === "all" || badge.level === levelFilter

    if (activeTab === "earned") {
      return userBadgeIds.includes(badge.id) && matchesSearch && matchesCategory && matchesLevel
    } else if (activeTab === "available") {
      return !userBadgeIds.includes(badge.id) && matchesSearch && matchesCategory && matchesLevel
    }
    return matchesSearch && matchesCategory && matchesLevel
  })

  const getLevelColor = (level: string) => {
    switch (level) {
      case "beginner": return "bg-green-100 text-green-800"
      case "intermediate": return "bg-blue-100 text-blue-800"
      case "advanced": return "bg-purple-100 text-purple-800"
      case "expert": return "bg-yellow-100 text-yellow-800"
      default: return "bg-muted text-foreground"
    }
  }

  const getCategoryColor = (category?: string) => {
    switch (category) {
      case "environmental": return "bg-green-50 text-green-700"
      case "technical": return "bg-blue-50 text-blue-700"
      case "leadership": return "bg-purple-50 text-purple-700"
      case "creative": return "bg-pink-50 text-pink-700"
      case "community": return "bg-orange-50 text-orange-700"
      case "business": return "bg-indigo-50 text-indigo-700"
      default: return "bg-muted text-foreground"
    }
  }

  const getModuleIcon = (type: string) => {
    switch (type) {
      case "video": return <PlayCircle className="h-4 w-4" />
      case "reading": return <BookOpen className="h-4 w-4" />
      case "quiz": return <HelpCircle className="h-4 w-4" />
      case "assignment": return <Award className="h-4 w-4" />
      default: return <BookOpen className="h-4 w-4" />
    }
  }

  const categories = [...new Set(allBadges.map(b => b.category).filter(Boolean))]

  return (
    <div className="container max-w-6xl mx-auto p-4 pb-20">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Community Badges</h1>
        <p className="text-gray-600">Earn badges by completing training and demonstrating skills</p>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="p-4 text-center">
            <Award className="h-8 w-8 mx-auto mb-2 text-blue-500" />
            <p className="text-2xl font-bold">{userBadges.length}</p>
            <p className="text-sm text-gray-600">Badges Earned</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Star className="h-8 w-8 mx-auto mb-2 text-yellow-500" />
            <p className="text-2xl font-bold">{allBadges.length - userBadges.length}</p>
            <p className="text-sm text-gray-600">Available Badges</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Users className="h-8 w-8 mx-auto mb-2 text-green-500" />
            <p className="text-2xl font-bold">
              {allBadges.length > 0 ? Math.round((userBadges.length / allBadges.length) * 100) : 0}%
            </p>
            <p className="text-sm text-gray-600">Completion Rate</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Clock className="h-8 w-8 mx-auto mb-2 text-purple-500" />
            <p className="text-2xl font-bold">
              {userBadges.filter(b => b.level === "advanced" || b.level === "expert").length}
            </p>
            <p className="text-sm text-gray-600">Advanced Badges</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <div className="flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
            <Input
              placeholder="Search badges..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-full md:w-[180px]">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categories.map((category) => (
              <SelectItem key={category} value={category!}>
                {category!.charAt(0).toUpperCase() + category!.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={levelFilter} onValueChange={setLevelFilter}>
          <SelectTrigger className="w-full md:w-[180px]">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            <SelectItem value="beginner">Beginner</SelectItem>
            <SelectItem value="intermediate">Intermediate</SelectItem>
            <SelectItem value="advanced">Advanced</SelectItem>
            <SelectItem value="expert">Expert</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Badge Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="all">All Badges ({allBadges.length})</TabsTrigger>
          <TabsTrigger value="earned">Earned ({userBadges.length})</TabsTrigger>
          <TabsTrigger value="available">Available ({allBadges.length - userBadges.length})</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="mt-6">
          <div className="grid gap-6">
            {filteredBadges.length === 0 ? (
              <Card>
                <CardContent className="p-8 text-center">
                  <p className="text-gray-500">No badges found matching your criteria.</p>
                </CardContent>
              </Card>
            ) : (
              filteredBadges.map((badge) => {
                const isEarned = userBadgeIds.includes(badge.id)
                const totalDuration = badge.trainingModules?.reduce((total, module) => total + module.duration, 0) || 0

                // Jobs that require this badge
                const relevantJobs = jobShifts.filter(job =>
                  job.requiredBadges.includes(badge.id)
                )

                return (
                  <Card key={badge.id} className={`${isEarned ? 'bg-gradient-to-r from-blue-50 to-green-50' : ''}`}>
                    <CardHeader>
                      <div className="flex justify-between items-start">
                        <div className="flex items-center gap-4">
                          <div className={`text-4xl p-3 rounded-full ${ isEarned ? 'bg-gradient-to-r from-blue-100 to-green-100' : 'bg-muted'}`}>
                            {badge.icon}
                          </div>
                          <div>
                            <div className="flex items-center gap-2 mb-2">
                              <CardTitle className="text-xl">{badge.name}</CardTitle>
                              {isEarned && <CheckCircle className="h-5 w-5 text-green-500" />}
                            </div>
                            <CardDescription className="mb-3">{badge.description}</CardDescription>
                            <div className="flex gap-2">
                              <Badge className={getLevelColor(badge.level)}>
                                {badge.level}
                              </Badge>
                              {badge.category && (
                                <Badge variant="outline" className={getCategoryColor(badge.category)}>
                                  {badge.category}
                                </Badge>
                              )}
                              {totalDuration > 0 && (
                                <Badge variant="outline">
                                  <Clock className="h-3 w-3 mr-1" />
                                  {totalDuration}min
                                </Badge>
                              )}
                              {relevantJobs.length > 0 && (
                                <Badge variant="outline">
                                  <Star className="h-3 w-3 mr-1" />
                                  {relevantJobs.length} jobs
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          {isEarned ? (
                            <Button variant="outline" asChild>
                              <Link href={`/badges/${badge.id}`}>
                                View Details
                              </Link>
                            </Button>
                          ) : (
                            <Button asChild>
                              <Link href={`/badges/${badge.id}`}>
                                Start Training
                              </Link>
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardHeader>

                    {(badge.trainingModules?.length || badge.liveClass) && (
                      <CardContent>
                        <div className="space-y-4">
                          {/* Training Modules Preview */}
                          {badge.trainingModules && badge.trainingModules.length > 0 && (
                            <div>
                              <h4 className="font-medium mb-3">Online Training ({badge.trainingModules.length} modules)</h4>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {badge.trainingModules.slice(0, 4).map((module, index) => (
                                  <div key={module.id} className="flex items-center gap-3 p-3 border rounded-lg bg-card">
                                    <div className="flex items-center gap-2 text-sm text-gray-600">
                                      {getModuleIcon(module.type)}
                                      <span>#{index + 1}</span>
                                    </div>
                                    <div className="flex-1">
                                      <p className="font-medium text-sm">{module.title}</p>
                                      <p className="text-xs text-gray-500">{module.duration}min &bull; {module.type}</p>
                                    </div>
                                  </div>
                                ))}
                                {badge.trainingModules.length > 4 && (
                                  <div className="flex items-center justify-center p-3 border border-dashed rounded-lg text-gray-500">
                                    <span className="text-sm">+{badge.trainingModules.length - 4} more modules</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Live Class Preview */}
                          {badge.liveClass && (
                            <div>
                              <h4 className="font-medium mb-3">Live Class</h4>
                              <div className="p-4 border rounded-lg bg-gradient-to-r from-orange-50 to-yellow-50">
                                <div className="flex justify-between items-start mb-3">
                                  <div>
                                    <h5 className="font-medium">{badge.liveClass.title}</h5>
                                    <p className="text-sm text-gray-600 mb-2">{badge.liveClass.description}</p>
                                  </div>
                                  <Badge variant="outline">
                                    <Users className="h-3 w-3 mr-1" />
                                    Max {badge.liveClass.maxParticipants}
                                  </Badge>
                                </div>
                                <div className="flex gap-4 text-sm text-gray-600">
                                  <div className="flex items-center gap-1">
                                    <MapPin className="h-4 w-4" />
                                    <span>{badge.liveClass.location}</span>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <Clock className="h-4 w-4" />
                                    <span>{badge.liveClass.duration}</span>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <Award className="h-4 w-4" />
                                    <span>{badge.liveClass.tasks.length} practical tasks</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Requirements */}
                          {badge.requirements && badge.requirements.length > 0 && (
                            <div>
                              <h4 className="font-medium mb-3">Requirements</h4>
                              <ul className="space-y-1">
                                {badge.requirements.map((requirement, index) => (
                                  <li key={index} className="flex items-start gap-2 text-sm">
                                    <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                                    <span>{requirement}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* Badge Holders */}
                          {badge.holders && badge.holders.length > 0 && (
                            <div>
                              <h4 className="font-medium mb-3">Badge Holders ({badge.holders.length})</h4>
                              <div className="flex items-center gap-2">
                                {badge.holders.slice(0, 5).map((userId) => (
                                  <Avatar key={userId} className="h-8 w-8">
                                    <AvatarImage src={`/placeholder-user.jpg`} />
                                    <AvatarFallback className="text-xs">{userId.slice(0, 2).toUpperCase()}</AvatarFallback>
                                  </Avatar>
                                ))}
                                {badge.holders.length > 5 && (
                                  <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                                    <span className="text-xs text-muted-foreground">+{badge.holders.length - 5}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    )}
                  </Card>
                )
              })
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
