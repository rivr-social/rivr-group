"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Textarea } from "@/components/ui/textarea"
import {
  ArrowLeft,
  Clock,
  Users,
  PlayCircle,
  BookOpen,
  HelpCircle,
  Award,
  MapPin,
  CheckCircle,
  Star,
  ExternalLink,
  Calendar,
  ChevronRight,
  ChevronDown,
  AlertCircle
} from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import Link from "next/link"
import type { UserBadge, TrainingModule, JobShift } from "@/types/domain"

interface BadgeDetailClientProps {
  badgeId: string
  allBadges: UserBadge[]
  isEarned: boolean
  jobShifts: JobShift[]
}

export function BadgeDetailClient({ badgeId, allBadges, isEarned, jobShifts }: BadgeDetailClientProps) {
  const router = useRouter()
  const { toast } = useToast()

  // Derive badge from badgeId (pure lookup)
  const badge = useMemo(() => allBadges.find(b => b.id === badgeId) || null, [badgeId, allBadges])
  const [activeTab, setActiveTab] = useState("overview")
  const [currentModuleIndex, setCurrentModuleIndex] = useState(0)
  const [moduleProgress, setModuleProgress] = useState<Record<string, boolean>>(() => {
    if (typeof window !== "undefined") {
      const savedProgress = localStorage.getItem(`badge-progress-${badgeId}`)
      if (savedProgress) {
        try {
          return JSON.parse(savedProgress)
        } catch {
          return {}
        }
      }
    }
    return {}
  })
  const [expandedModule, setExpandedModule] = useState<string | null>(null)
  const [quizAnswers, setQuizAnswers] = useState<Record<string, string>>({})

  if (!badge) {
    return (
      <div className="container max-w-4xl mx-auto p-4">
        <Button variant="ghost" onClick={() => router.back()} className="mb-4">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <div className="text-center py-12">
          <h2 className="text-2xl font-bold mb-2">Badge Not Found</h2>
          <p className="text-gray-600">The badge you&apos;re looking for doesn&apos;t exist.</p>
        </div>
      </div>
    )
  }

  const totalModules = badge.trainingModules?.length || 0
  const completedModules = Object.values(moduleProgress).filter(Boolean).length
  const progressPercentage = totalModules > 0 ? Math.round((completedModules / totalModules) * 100) : 0

  // Jobs that require this badge
  const relevantJobs = jobShifts.filter(job =>
    job.requiredBadges.includes(badgeId)
  )

  const getLevelColor = (level: string) => {
    switch (level) {
      case "beginner": return "bg-green-100 text-green-800"
      case "intermediate": return "bg-blue-100 text-blue-800"
      case "advanced": return "bg-purple-100 text-purple-800"
      case "expert": return "bg-yellow-100 text-yellow-800"
      default: return "bg-muted text-foreground"
    }
  }

  const getModuleIcon = (type: string) => {
    switch (type) {
      case "video": return <PlayCircle className="h-5 w-5" />
      case "reading": return <BookOpen className="h-5 w-5" />
      case "quiz": return <HelpCircle className="h-5 w-5" />
      case "assignment": return <Award className="h-5 w-5" />
      default: return <BookOpen className="h-5 w-5" />
    }
  }

  const completeModule = (moduleId: string) => {
    const newProgress = { ...moduleProgress, [moduleId]: true }
    setModuleProgress(newProgress)
    localStorage.setItem(`badge-progress-${badgeId}`, JSON.stringify(newProgress))

    toast({
      title: "Module completed!",
      description: "Great job! You've completed this training module.",
    })

    const totalCompleted = Object.values(newProgress).filter(Boolean).length
    if (totalCompleted === totalModules) {
      toast({
        title: "Training completed!",
        description: "You've finished all online training modules. Ready for the practical assessment!",
      })
    }
  }

  const startLiveClass = () => {
    router.push(`/create?tab=event&type=live-class&badge=${badgeId}&title=${encodeURIComponent(badge?.liveClass?.title || '')}&description=${encodeURIComponent(badge?.liveClass?.description || '')}&location=${encodeURIComponent(badge?.liveClass?.location || '')}&duration=${encodeURIComponent(badge?.liveClass?.duration || '')}`)
  }

  const renderModuleContent = (module: TrainingModule) => {
    switch (module.type) {
      case "video":
        return (
          <div className="space-y-4">
            <div className="aspect-video bg-muted rounded-lg flex items-center justify-center">
              <div className="text-center">
                <PlayCircle className="h-16 w-16 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600 mb-4">Video content placeholder</p>
                <Button asChild>
                  <a href={module.content} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Watch Video
                  </a>
                </Button>
              </div>
            </div>
            <div className="flex justify-center">
              <Button onClick={() => completeModule(module.id)} disabled={moduleProgress[module.id]}>
                {moduleProgress[module.id] ? (
                  <>
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Completed
                  </>
                ) : (
                  "Mark as Complete"
                )}
              </Button>
            </div>
          </div>
        )

      case "reading":
        return (
          <div className="space-y-4">
            <div className="prose max-w-none p-6 bg-muted rounded-lg">
              <p>{module.content}</p>
            </div>
            <div className="flex justify-center">
              <Button onClick={() => completeModule(module.id)} disabled={moduleProgress[module.id]}>
                {moduleProgress[module.id] ? (
                  <>
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Completed
                  </>
                ) : (
                  "Mark as Read"
                )}
              </Button>
            </div>
          </div>
        )

      case "quiz":
        return (
          <div className="space-y-6">
            <div className="p-6 bg-blue-50 rounded-lg">
              <h4 className="font-medium mb-4">Quiz: {module.title}</h4>
              <p className="text-sm text-gray-600 mb-4">{module.content}</p>

              <div className="space-y-4">
                <div>
                  <p className="font-medium mb-2">1. What is the most important factor in plant care?</p>
                  <div className="space-y-2">
                    {["Proper watering", "Good soil", "Adequate sunlight", "All of the above"].map((option) => (
                      <label key={option} className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="q1"
                          value={option}
                          onChange={(e) => setQuizAnswers({...quizAnswers, q1: e.target.value})}
                        />
                        <span className="text-sm">{option}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="flex justify-center">
              <Button
                onClick={() => completeModule(module.id)}
                disabled={moduleProgress[module.id] || !quizAnswers.q1}
              >
                {moduleProgress[module.id] ? (
                  <>
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Completed
                  </>
                ) : (
                  "Submit Quiz"
                )}
              </Button>
            </div>
          </div>
        )

      case "assignment":
        return (
          <div className="space-y-4">
            <div className="p-6 bg-yellow-50 rounded-lg">
              <h4 className="font-medium mb-4">Assignment: {module.title}</h4>
              <p className="text-sm text-gray-600 mb-4">{module.content}</p>
              <Textarea
                placeholder="Write your response here..."
                className="min-h-[100px]"
              />
            </div>
            <div className="flex justify-center">
              <Button onClick={() => completeModule(module.id)} disabled={moduleProgress[module.id]}>
                {moduleProgress[module.id] ? (
                  <>
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Submitted
                  </>
                ) : (
                  "Submit Assignment"
                )}
              </Button>
            </div>
          </div>
        )

      default:
        return <div>Unknown module type</div>
    }
  }

  return (
    <div className="container max-w-6xl mx-auto p-4 pb-20">
      <Button variant="ghost" onClick={() => router.back()} className="mb-4">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Badges
      </Button>

      {/* Badge Header */}
      <div className={`mb-6 p-6 rounded-lg ${isEarned ? 'bg-gradient-to-r from-blue-50 to-green-50' : 'bg-muted'}`}>
        <div className="flex items-center gap-6">
          <div className={`text-6xl p-4 rounded-full ${isEarned ? 'bg-gradient-to-r from-blue-100 to-green-100' : 'bg-muted'}`}>
            {badge.icon}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-3xl font-bold">{badge.name}</h1>
              {isEarned && <CheckCircle className="h-8 w-8 text-green-500" />}
            </div>
            <p className="text-gray-600 text-lg mb-4">{badge.description}</p>
            <div className="flex gap-3">
              <Badge className={getLevelColor(badge.level)}>
                {badge.level}
              </Badge>
              {badge.category && (
                <Badge variant="outline">
                  {badge.category}
                </Badge>
              )}
              {!isEarned && totalModules > 0 && (
                <Badge variant="outline">
                  <Clock className="h-4 w-4 mr-1" />
                  {badge.trainingModules?.reduce((total: number, module: TrainingModule) => total + module.duration, 0)}min training
                </Badge>
              )}
            </div>
          </div>
          <div className="text-right">
            {!isEarned && (
              <div className="mb-4">
                <p className="text-sm text-gray-600 mb-2">Progress</p>
                <div className="w-32">
                  <Progress value={progressPercentage} className="h-2" />
                  <p className="text-sm text-gray-500 mt-1">{completedModules}/{totalModules} modules</p>
                </div>
              </div>
            )}
            {isEarned ? (
              <Badge className="bg-green-100 text-green-800">
                <Award className="h-4 w-4 mr-2" />
                Earned
              </Badge>
            ) : progressPercentage === 100 ? (
              <Button onClick={startLiveClass}>
                <Calendar className="h-4 w-4 mr-2" />
                Schedule Live Class
              </Button>
            ) : (
              <Button onClick={() => setActiveTab("training")}>
                Start Training
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="training">Training ({totalModules})</TabsTrigger>
          <TabsTrigger value="workshop">Live Class</TabsTrigger>
          <TabsTrigger value="community">Community</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <div className="grid gap-6">
            {badge.requirements && badge.requirements.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Requirements</CardTitle>
                  <CardDescription>What you need to earn this badge</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-3">
                    {badge.requirements.map((requirement: string, index: number) => (
                      <li key={index} className="flex items-start gap-3">
                        <CheckCircle className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                        <span>{requirement}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            <div className="grid md:grid-cols-2 gap-6">
              {badge.jobsUnlocked && badge.jobsUnlocked.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Jobs Unlocked</CardTitle>
                    <CardDescription>Job types you can apply for with this badge</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {badge.jobsUnlocked.map((job: string, index: number) => (
                        <li key={index} className="flex items-center gap-2">
                          <Star className="h-4 w-4 text-yellow-500" />
                          <span className="capitalize">{job.replace("-", " ")}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader>
                  <CardTitle>Training Overview</CardTitle>
                  <CardDescription>What&apos;s included in this badge program</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {totalModules > 0 && (
                      <div className="flex items-center gap-3">
                        <BookOpen className="h-5 w-5 text-blue-500" />
                        <div>
                          <p className="font-medium">{totalModules} Online Modules</p>
                          <p className="text-sm text-gray-600">
                            {badge.trainingModules?.reduce((total: number, module: TrainingModule) => total + module.duration, 0)} minutes total
                          </p>
                        </div>
                      </div>
                    )}
                    {badge.liveClass && (
                      <div className="flex items-center gap-3">
                        <Users className="h-5 w-5 text-green-500" />
                        <div>
                          <p className="font-medium">Live Class</p>
                          <p className="text-sm text-gray-600">{badge.liveClass.duration} practical training</p>
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {relevantJobs.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Available Jobs</CardTitle>
                  <CardDescription>Current job opportunities that require this badge</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {relevantJobs.map((job) => {
                      return (
                        <Link key={job.id} href={`/groups/${job.groupId}?tab=jobs&job=${job.id}`}>
                          <Card className="p-4 hover:shadow-md transition-shadow cursor-pointer border border-gray-200">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                  <h4 className="font-medium">{job.title}</h4>
                                  <span className={`text-xs px-2 py-1 rounded-full ${
                                    job.priority === 'high' ? 'bg-red-100 text-red-800' :
                                    job.priority === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                                    'bg-green-100 text-green-800'
                                  }`}>
                                    {job.priority}
                                  </span>
                                  <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                                    {job.totalPoints} pts
                                  </span>
                                </div>
                                <p className="text-sm text-gray-600 mb-2 line-clamp-2">{job.description}</p>
                                <div className="flex items-center gap-4 text-xs text-gray-500">
                                  <span className="flex items-center gap-1">
                                    <MapPin className="h-3 w-3" />
                                    {job.location}
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <Clock className="h-3 w-3" />
                                    {job.duration}
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <Award className="h-3 w-3" />
                                    {job.tasks.length} tasks
                                  </span>
                                </div>
                              </div>
                              <ChevronRight className="h-4 w-4 text-gray-400 mt-2" />
                            </div>
                          </Card>
                        </Link>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="training" className="mt-6">
          {badge.trainingModules && badge.trainingModules.length > 0 ? (
            <div className="grid gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Training Modules</CardTitle>
                  <CardDescription>Complete all modules to unlock the live class</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {badge.trainingModules.map((module: TrainingModule, index: number) => {
                      const isCompleted = moduleProgress[module.id]
                      const isCurrent = currentModuleIndex === index
                      const isAccessible = index === 0 || moduleProgress[badge.trainingModules![index - 1].id]

                      return (
                        <div
                          key={module.id}
                          className={`border rounded-lg p-4 transition-all ${
                            isCurrent ? 'border-blue-500 bg-blue-50' :
                            isCompleted ? 'border-green-500 bg-green-50' :
                            isAccessible ? 'border-border hover:border-border' :
                            'border-border bg-muted'
                          }`}
                        >
                          <div
                            className="flex items-center justify-between cursor-pointer"
                            onClick={() => {
                              if (isAccessible) {
                                setCurrentModuleIndex(index)
                                setExpandedModule(expandedModule === module.id ? null : module.id)
                              }
                            }}
                          >
                            <div className="flex items-center gap-4">
                              <div className={`p-2 rounded-full ${
                                isCompleted ? 'bg-green-100 text-green-600' :
                                isAccessible ? 'bg-blue-100 text-blue-600' :
                                'bg-muted text-muted-foreground'
                              }`}>
                                {isCompleted ? <CheckCircle className="h-5 w-5" /> : getModuleIcon(module.type)}
                              </div>
                              <div>
                                <h4 className="font-medium">
                                  {index + 1}. {module.title}
                                </h4>
                                <p className="text-sm text-gray-600">{module.description}</p>
                                <div className="flex items-center gap-4 mt-1">
                                  <span className="text-xs text-gray-500">
                                    <Clock className="h-3 w-3 inline mr-1" />
                                    {module.duration}min
                                  </span>
                                  <span className="text-xs text-gray-500 capitalize">
                                    {module.type}
                                  </span>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {isCompleted && <CheckCircle className="h-5 w-5 text-green-500" />}
                              {!isAccessible && <AlertCircle className="h-5 w-5 text-gray-400" />}
                              {isAccessible && (
                                expandedModule === module.id ?
                                  <ChevronDown className="h-5 w-5" /> :
                                  <ChevronRight className="h-5 w-5" />
                              )}
                            </div>
                          </div>

                          {expandedModule === module.id && isAccessible && (
                            <div className="mt-6 pt-6 border-t">
                              {renderModuleContent(module)}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : (
            <Card>
              <CardContent className="p-8 text-center">
                <p className="text-gray-500">No online training modules available for this badge.</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="workshop" className="mt-6">
          {badge.liveClass ? (
            <Card>
              <CardHeader>
                <CardTitle>{badge.liveClass.title}</CardTitle>
                <CardDescription>{badge.liveClass.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  <div className="grid md:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <MapPin className="h-5 w-5 text-gray-500" />
                        <div>
                          <p className="font-medium">Location</p>
                          <p className="text-sm text-gray-600">{badge.liveClass.location}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Clock className="h-5 w-5 text-gray-500" />
                        <div>
                          <p className="font-medium">Duration</p>
                          <p className="text-sm text-gray-600">{badge.liveClass.duration}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Users className="h-5 w-5 text-gray-500" />
                        <div>
                          <p className="font-medium">Group Size</p>
                          <p className="text-sm text-gray-600">Max {badge.liveClass.maxParticipants} participants</p>
                        </div>
                      </div>
                    </div>
                    <div className="space-y-4">
                      <div>
                        <p className="font-medium mb-2">Prerequisites</p>
                        <div className="text-sm text-gray-600">
                          {progressPercentage === 100 ? (
                            <div className="flex items-center gap-2 text-green-600">
                              <CheckCircle className="h-4 w-4" />
                              <span>All online modules completed</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 text-orange-600">
                              <AlertCircle className="h-4 w-4" />
                              <span>Complete {totalModules - completedModules} more online modules</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div>
                        <Button
                          className="w-full"
                          disabled={progressPercentage !== 100}
                          onClick={startLiveClass}
                        >
                          <Calendar className="h-4 w-4 mr-2" />
                          {progressPercentage === 100 ? "Schedule Live Class" : "Complete Training First"}
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h4 className="font-medium mb-4">Practical Tasks</h4>
                    <div className="grid gap-3">
                      {badge.liveClass.tasks.map((task: { id: string; name: string; description: string; points: number; completed?: boolean }, index: number) => (
                        <div key={task.id} className="flex items-start gap-4 p-4 border rounded-lg">
                          <div className="p-2 bg-blue-100 text-blue-600 rounded-full">
                            <span className="text-sm font-medium">{index + 1}</span>
                          </div>
                          <div className="flex-1">
                            <h5 className="font-medium">{task.name}</h5>
                            <p className="text-sm text-gray-600 mt-1">{task.description}</p>
                          </div>
                          <Badge variant="outline">
                            <Star className="h-3 w-3 mr-1" />
                            {task.points} pts
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-8 text-center">
                <p className="text-gray-500">No live class required for this badge.</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="community" className="mt-6">
          <div className="grid gap-6">
            {badge.holders && badge.holders.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Badge Holders ({badge.holders.length})</CardTitle>
                  <CardDescription>Community members who have earned this badge</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {badge.holders.map((userId: string) => (
                      <div key={userId} className="flex items-center gap-3 p-3 border rounded-lg">
                        <Avatar>
                          <AvatarImage src={`/placeholder-user.jpg`} />
                          <AvatarFallback>{userId.slice(0, 2).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">User {userId}</p>
                          <p className="text-sm text-gray-500">Community Member</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
