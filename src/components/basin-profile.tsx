"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { 
  Waves, MapPin, Users, Calendar, 
  TreePine, Building2, Vote, Leaf,
  Fish, Mountain, ChevronRight
} from "lucide-react"
import Image from "next/image"
import { Basin, Chapter } from "@/lib/types"
import Link from "next/link"

/**
 * Basin detail profile panel used on watershed/basin detail pages.
 *
 * This component presents basin-level context, chapter rollups, optional bioregional
 * council information, and ecosystem/initiative tabs.
 *
 * Key props:
 * - `basin`: basin metadata displayed in the header and overview.
 * - `chapters`: chapter list used for basin-scoped community rollups.
 * - `bioregionalCouncil`: optional council details used in the council tab.
 */
interface BasinProfileProps {
  basin: Basin
  chapters: Chapter[]
  bioregionalCouncil?: {
    id: string
    name: string
    description: string
    members: { id: string; name: string; role: string; avatar: string }[]
    nextMeeting?: string
    initiatives: { id: string; title: string; status: string }[]
  }
}

/**
 * Renders a tabbed basin profile experience with chapter and council context.
 *
 * @param props - Component props.
 * @param props.basin - Basin metadata and imagery.
 * @param props.chapters - All chapters to be filtered to this basin.
 * @param props.bioregionalCouncil - Optional council object for governance content.
 */
export function BasinProfile({ basin, chapters, bioregionalCouncil }: BasinProfileProps) {
  // Controlled tab state for switching among profile sub-sections.
  const [activeTab, setActiveTab] = useState("overview")

  // Derived basin-specific aggregates from provided chapter data (no remote fetch).
  const basinChapters = chapters.filter(chapter => chapter.basinId === basin.id)
  const totalMembers = basinChapters.reduce((sum, chapter) => sum + (chapter.memberCount || 0), 0)

  // Static ecosystem metrics shown across overview and ecosystem tabs.
  const ecosystemStats = {
    watershedAcres: "2.4M",
    protectedLand: "45%",
    nativeSpecies: 127,
    restorationProjects: 23,
    carbonSequestered: "12.5K tons"
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative">
        {/* Conditional rendering: only show the hero image container when an image is available. */}
        {basin.image && (
          <div 
            className="h-48 bg-cover bg-center rounded-lg"
            style={{ backgroundImage: `url(${basin.image})` }}
          >
            <div className="absolute inset-0 bg-black/30 rounded-lg" />
          </div>
        )}
        <div className="absolute inset-0 flex items-end p-6">
          <div className="text-white">
            <h1 className="text-3xl font-bold mb-2">{basin.name}</h1>
            <p className="text-lg opacity-90">{basin.description}</p>
            <div className="flex items-center gap-2 mt-2">
              <Badge variant="secondary" className="bg-blue-500/20 text-white border-blue-300">
                HUC-6: {basin.huc6Code}
              </Badge>
              <Badge variant="secondary" className="bg-green-500/20 text-white border-green-300">
                {basinChapters.length} Communities
              </Badge>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <Users className="h-8 w-8 mx-auto mb-2 text-blue-500" />
            <div className="text-2xl font-bold">{totalMembers.toLocaleString()}</div>
            <div className="text-sm text-gray-600">Total Members</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Building2 className="h-8 w-8 mx-auto mb-2 text-green-500" />
            <div className="text-2xl font-bold">{basinChapters.length}</div>
            <div className="text-sm text-gray-600">Communities</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <TreePine className="h-8 w-8 mx-auto mb-2 text-green-600" />
            <div className="text-2xl font-bold">{ecosystemStats.protectedLand}</div>
            <div className="text-sm text-gray-600">Protected Land</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Leaf className="h-8 w-8 mx-auto mb-2 text-emerald-500" />
            <div className="text-2xl font-bold">{ecosystemStats.carbonSequestered}</div>
            <div className="text-sm text-gray-600">Carbon Sequestered</div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        {/* Controlled tabs: active panel is driven by local `activeTab` state. */}
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="communities">Communities</TabsTrigger>
          <TabsTrigger value="council">Bioregional Council</TabsTrigger>
          <TabsTrigger value="ecosystem">Ecosystem</TabsTrigger>
          <TabsTrigger value="initiatives">Initiatives</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Waves className="h-5 w-5 text-blue-500" />
                  Watershed Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600">HUC-6 Code:</span>
                  <span className="font-medium">{basin.huc6Code}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Watershed Area:</span>
                  <span className="font-medium">{ecosystemStats.watershedAcres} acres</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Native Species:</span>
                  <span className="font-medium">{ecosystemStats.nativeSpecies}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Restoration Projects:</span>
                  <span className="font-medium">{ecosystemStats.restorationProjects}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-green-500" />
                  Community Network
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600">Total Communities:</span>
                  <span className="font-medium">{basinChapters.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Total Members:</span>
                  <span className="font-medium">{totalMembers.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Commons:</span>
                  <span className="font-medium">{basinChapters.filter(c => c.isCommons).length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Chapters:</span>
                  <span className="font-medium">{basinChapters.filter(c => !c.isCommons).length}</span>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Recent Basin Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 bg-green-50 rounded-lg">
                  <TreePine className="h-5 w-5 text-green-600" />
                  <div className="flex-1">
                    <p className="font-medium">New restoration project launched</p>
                    <p className="text-sm text-gray-600">South Platte Riparian Restoration - 2 days ago</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg">
                  <Users className="h-5 w-5 text-blue-600" />
                  <div className="flex-1">
                    <p className="font-medium">Boulder Commons reached 350 members</p>
                    <p className="text-sm text-gray-600">Community milestone achieved - 1 week ago</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-3 bg-purple-50 rounded-lg">
                  <Vote className="h-5 w-5 text-purple-600" />
                  <div className="flex-1">
                    <p className="font-medium">Bioregional Council meeting scheduled</p>
                    <p className="text-sm text-gray-600">Quarterly watershed planning - Next Tuesday</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="communities" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Communities in {basin.name}</CardTitle>
              <p className="text-gray-600">Local chapters and commons within this watershed</p>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4">
                {basinChapters.map((chapter) => (
                  <Link key={chapter.id} href={`/locales/${chapter.id}`}>
                    <div className="flex items-center gap-4 p-4 border rounded-lg hover:bg-gray-50 transition-colors">
                      {chapter.image && (
                        <Image
                          src={chapter.image}
                          alt={chapter.name}
                          width={48}
                          height={48}
                          className="w-12 h-12 rounded-lg object-cover"
                          unoptimized
                        />
                      )}
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium">{chapter.name}</h3>
                          {/* Conditional rendering: commons badge appears only for commons chapters. */}
                          {chapter.isCommons && (
                            <Badge variant="outline" className="text-green-600 border-green-300">
                              Commons
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-gray-600">{chapter.description}</p>
                        <div className="flex items-center gap-4 mt-1 text-sm text-gray-500">
                          <span className="flex items-center gap-1">
                            <Users className="h-3 w-3" />
                            {chapter.memberCount} members
                          </span>
                          <span className="flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {chapter.location}
                          </span>
                        </div>
                      </div>
                      <ChevronRight className="h-5 w-5 text-gray-400" />
                    </div>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="council" className="space-y-4">
          {/* Conditional rendering: show council content when present, otherwise empty-state CTA. */}
          {bioregionalCouncil ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>{bioregionalCouncil.name}</CardTitle>
                  <p className="text-gray-600">{bioregionalCouncil.description}</p>
                </CardHeader>
                <CardContent>
                  {/* Conditional rendering: next-meeting panel is shown only when provided. */}
                  {bioregionalCouncil.nextMeeting && (
                    <div className="mb-6 p-4 bg-blue-50 rounded-lg">
                      <div className="flex items-center gap-2 mb-2">
                        <Calendar className="h-5 w-5 text-blue-600" />
                        <span className="font-medium">Next Council Meeting</span>
                      </div>
                      <p className="text-blue-800">{bioregionalCouncil.nextMeeting}</p>
                    </div>
                  )}

                  <div className="grid gap-4">
                    <h4 className="font-medium">Council Members</h4>
                    {bioregionalCouncil.members.map((member) => (
                      <div key={member.id} className="flex items-center gap-3 p-3 border rounded-lg">
                        <Avatar className="h-10 w-10">
                          <AvatarImage src={member.avatar} alt={member.name} />
                          <AvatarFallback>{member.name.substring(0, 2).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">{member.name}</p>
                          <p className="text-sm text-gray-600">{member.role}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Current Initiatives</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {bioregionalCouncil.initiatives.map((initiative) => (
                      <div key={initiative.id} className="flex items-center justify-between p-3 border rounded-lg">
                        <span className="font-medium">{initiative.title}</span>
                        {/* Conditional rendering: initiative status maps to badge variant styles. */}
                        <Badge variant={
                          initiative.status === "active" ? "default" :
                          initiative.status === "planning" ? "secondary" :
                          "outline"
                        }>
                          {initiative.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            <Card>
              <CardContent className="text-center py-12">
                <Vote className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                <h3 className="text-lg font-medium mb-2">No Bioregional Council Yet</h3>
                <p className="text-gray-600 mb-4">
                  This watershed basin doesn&apos;t have an established bioregional council.
                </p>
                <Button>
                  <Users className="h-4 w-4 mr-2" />
                  Form a Council
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="ecosystem" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Fish className="h-5 w-5 text-blue-500" />
                  Aquatic Ecosystem
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600">Fish Species:</span>
                  <span className="font-medium">23</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Water Quality:</span>
                  <Badge variant="default" className="bg-green-500">Good</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Stream Miles:</span>
                  <span className="font-medium">1,247</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Wetland Acres:</span>
                  <span className="font-medium">15,432</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mountain className="h-5 w-5 text-green-600" />
                  Terrestrial Ecosystem
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600">Bird Species:</span>
                  <span className="font-medium">156</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Mammal Species:</span>
                  <span className="font-medium">34</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Forest Cover:</span>
                  <span className="font-medium">62%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Grassland:</span>
                  <span className="font-medium">28%</span>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Conservation Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-600">{ecosystemStats.protectedLand}</div>
                  <div className="text-sm text-gray-600">Protected Land</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-600">87%</div>
                  <div className="text-sm text-gray-600">Habitat Connectivity</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-orange-600">12</div>
                  <div className="text-sm text-gray-600">Threatened Species</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-purple-600">8</div>
                  <div className="text-sm text-gray-600">Wildlife Corridors</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="initiatives" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Watershed Restoration Initiatives</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="p-4 border rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-medium">Riparian Restoration Project</h4>
                    <Badge variant="default">Active</Badge>
                  </div>
                  <p className="text-sm text-gray-600 mb-3">
                    Restoring native vegetation along 15 miles of streambank to improve water quality and wildlife habitat.
                  </p>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="flex items-center gap-1">
                      <TreePine className="h-3 w-3" />
                      2,500 trees planted
                    </span>
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      45 volunteers
                    </span>
                  </div>
                </div>

                <div className="p-4 border rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-medium">Water Quality Monitoring</h4>
                    <Badge variant="default">Ongoing</Badge>
                  </div>
                  <p className="text-sm text-gray-600 mb-3">
                    Community-based monitoring program tracking water quality across 20 monitoring sites.
                  </p>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="flex items-center gap-1">
                      <Waves className="h-3 w-3" />
                      20 monitoring sites
                    </span>
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      12 trained volunteers
                    </span>
                  </div>
                </div>

                <div className="p-4 border rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-medium">Native Species Recovery</h4>
                    <Badge variant="secondary">Planning</Badge>
                  </div>
                  <p className="text-sm text-gray-600 mb-3">
                    Collaborative effort to restore populations of native fish and bird species through habitat improvement.
                  </p>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="flex items-center gap-1">
                      <Fish className="h-3 w-3" />
                      5 target species
                    </span>
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      Starts Q2 2025
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
