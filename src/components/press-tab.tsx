"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Image from "next/image"
import Link from "next/link"
import { AlertCircle, Calendar, ExternalLink, FileText, Instagram, Loader2, Plus, Video } from "lucide-react"
import { fetchGroupPressFeedAction, type GroupPressSources, updateGroupPressSourcesAction } from "@/app/actions/press"
import type { SerializedResource } from "@/lib/graph-serializers"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useToast } from "@/components/ui/use-toast"

type PressTabProps = {
  groupId: string
  isGroupAdmin: boolean
  pressResources: SerializedResource[]
}

export function PressTab({ groupId, isGroupAdmin, pressResources }: PressTabProps) {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState("featured")
  const [isPending, startTransition] = useTransition()
  const [sources, setSources] = useState<GroupPressSources>({})
  const [articles, setArticles] = useState<Array<{
    id: string
    title: string
    excerpt?: string
    url: string
    publishedAt?: string
  }>>([])
  const [media, setMedia] = useState<Array<{
    id: string
    title: string
    excerpt?: string
    url: string
    publishedAt?: string
    imageUrl?: string
    source: string
  }>>([])
  const [sourceErrors, setSourceErrors] = useState<Partial<Record<"substack" | "youtube" | "instagram", string>>>({})

  useEffect(() => {
    let cancelled = false
    startTransition(async () => {
      const result = await fetchGroupPressFeedAction(groupId)
      if (cancelled) return
      setSources(result.sources)
      setArticles(result.articles)
      setMedia(result.media)
      setSourceErrors(result.sourceErrors)
    })
    return () => {
      cancelled = true
    }
  }, [groupId])

  const featuredResources = useMemo(
    () =>
      pressResources.slice(0, 6).map((resource) => {
        const metadata = (resource.metadata ?? {}) as Record<string, unknown>
        const images = Array.isArray(metadata.images) ? metadata.images : []
        return {
          id: resource.id,
          title: resource.name,
          description: resource.description ?? "",
          href:
            resource.type === "post" || resource.type === "note"
              ? `/posts/${resource.id}`
              : resource.type === "listing"
                ? `/marketplace/${resource.id}`
                : "#",
          image:
            typeof metadata.image === "string"
              ? metadata.image
              : typeof images[0] === "string"
                ? images[0]
                : "/placeholder-event.jpg",
        }
      }),
    [pressResources],
  )

  const handleSaveSources = () => {
    startTransition(async () => {
      const result = await updateGroupPressSourcesAction(groupId, sources)
      if (!result.success) {
        toast({
          title: "Failed to save press sources",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        })
        return
      }

      const refreshed = await fetchGroupPressFeedAction(groupId)
      setSources(refreshed.sources)
      setArticles(refreshed.articles)
      setMedia(refreshed.media)
      setSourceErrors(refreshed.sourceErrors)
      toast({
        title: "Press sources updated",
        description: "Substack, YouTube, and Instagram sources were refreshed.",
      })
    })
  }

  return (
    <div className="space-y-6">
      {isGroupAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>Press Sources</CardTitle>
            <CardDescription>
              Connect external publishing sources. Substack and YouTube import their latest public items. Instagram is linked as a live profile source.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="press-substack">Substack URL</Label>
              <Input
                id="press-substack"
                value={sources.substackUrl ?? ""}
                onChange={(event) => setSources((current) => ({ ...current, substackUrl: event.target.value }))}
                placeholder="https://example.substack.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="press-youtube">YouTube channel or profile URL</Label>
              <Input
                id="press-youtube"
                value={sources.youtubeUrl ?? ""}
                onChange={(event) => setSources((current) => ({ ...current, youtubeUrl: event.target.value }))}
                placeholder="https://www.youtube.com/@yourchannel"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="press-instagram">Instagram handle</Label>
              <Input
                id="press-instagram"
                value={sources.instagramHandle ?? ""}
                onChange={(event) => setSources((current) => ({ ...current, instagramHandle: event.target.value }))}
                placeholder="@yourhandle"
              />
            </div>
            <div className="md:col-span-3 flex justify-end">
              <Button onClick={handleSaveSources} disabled={isPending}>
                {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Save Sources
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {Object.keys(sourceErrors).length > 0 ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Some external sources could not fully refresh</AlertTitle>
          <AlertDescription>
            <ul className="space-y-1">
              {Object.entries(sourceErrors).map(([source, error]) => (
                <li key={source}>
                  <span className="font-medium capitalize">{source}:</span> {error}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="featured">Featured</TabsTrigger>
          <TabsTrigger value="articles">Articles</TabsTrigger>
          <TabsTrigger value="media">Media</TabsTrigger>
        </TabsList>

        <TabsContent value="featured" className="space-y-4">
          {featuredResources.length === 0 ? (
            <p className="text-sm text-muted-foreground">No internal press or gallery content yet.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {featuredResources.map((item) => (
                <Card key={item.id} className="overflow-hidden">
                  <div className="relative aspect-video bg-muted">
                    <Image src={item.image} alt={item.title} fill className="object-cover" unoptimized />
                  </div>
                  <CardContent className="space-y-3 p-4">
                    <div>
                      <p className="font-medium">{item.title}</p>
                      <p className="text-sm text-muted-foreground">{item.description || "No description yet."}</p>
                    </div>
                    <Button variant="outline" asChild>
                      <Link href={item.href}>Open <ExternalLink className="ml-2 h-4 w-4" /></Link>
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="articles" className="space-y-4">
          {articles.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Substack articles found yet. Add a Substack URL above to import public posts.</p>
          ) : (
            articles.map((item) => (
              <Card key={item.id}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <FileText className="h-3.5 w-3.5" />
                        <span>Substack</span>
                        {item.publishedAt ? (
                          <>
                            <span>•</span>
                            <span>{new Date(item.publishedAt).toLocaleDateString()}</span>
                          </>
                        ) : null}
                      </div>
                      <p className="font-medium">{item.title}</p>
                      {item.excerpt ? <p className="text-sm text-muted-foreground">{item.excerpt}</p> : null}
                    </div>
                    <Button variant="outline" asChild>
                      <a href={item.url} target="_blank" rel="noreferrer">
                        Read <ExternalLink className="ml-2 h-4 w-4" />
                      </a>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="media" className="space-y-4">
          {media.length === 0 ? (
            <p className="text-sm text-muted-foreground">No media sources found yet. Add a YouTube URL or Instagram handle above.</p>
          ) : (
            media.map((item) => (
              <Card key={item.id}>
                <CardContent className="flex flex-col gap-4 p-4 md:flex-row">
                  {item.imageUrl ? (
                    <div className="relative h-32 w-full overflow-hidden rounded-md border md:w-56">
                      <Image src={item.imageUrl} alt={item.title} fill className="object-cover" unoptimized />
                    </div>
                  ) : null}
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {item.source === "youtube" ? <Video className="h-3.5 w-3.5" /> : <Instagram className="h-3.5 w-3.5" />}
                      <span className="capitalize">{item.source}</span>
                      {item.publishedAt ? (
                        <>
                          <span>•</span>
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {new Date(item.publishedAt).toLocaleDateString()}
                          </span>
                        </>
                      ) : null}
                    </div>
                    <p className="font-medium">{item.title}</p>
                    {item.excerpt ? <p className="text-sm text-muted-foreground">{item.excerpt}</p> : null}
                    <Button variant="outline" asChild>
                      <a href={item.url} target="_blank" rel="noreferrer">
                        Open <ExternalLink className="ml-2 h-4 w-4" />
                      </a>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
