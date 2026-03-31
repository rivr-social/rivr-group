"use client";

/**
 * Public user profile page.
 *
 * Route: `/profile/[username]`
 * Purpose: Displays a read-only profile experience for a user identified by username, including posts, events, groups,
 * photos, offerings, and recent activity. Mirrors the personal profile layout without edit controls, wallet, calendar,
 * or saved tabs.
 * Data requirements: Requires a username route param plus targeted profile data from `fetchAgentByUsername`,
 * `fetchProfileData`, `fetchUserPosts`, `fetchUserEvents`, and `fetchUserGroups`.
 *
 * Rendering: Client Component (`"use client"`), with data fetching in effects/hooks after hydration.
 * Metadata: This file does not export `metadata` or `generateMetadata`; metadata is inherited from parent layouts.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Award, Calendar as CalendarIcon, Clock, Drama, Gift, Globe, Heart, MapPin, MessageSquare, Users } from "lucide-react";
import { getSocialIcon, getSocialHref, getSocialDisplayLabel } from "@/lib/social-platform-icon";
import { useToast } from "@/components/ui/use-toast";
import { fetchAgentByUsername, fetchProfileData, fetchPublicAgentById, fetchUserPosts, fetchUserEvents, fetchUserGroups } from "@/app/actions/graph";
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers";
import {
  agentToEvent,
  agentToGroup,
  resourceToPost,
} from "@/lib/graph-adapters";
import { searchLocalAgents, upsertAgents, type LocalAgent } from "@/lib/local-db";
import { useLocalesAndBasins } from "@/lib/hooks/use-graph-data";
import { PostFeed } from "@/components/post-feed";
import { EventFeed } from "@/components/event-feed";
import { ProfileGroupFeed } from "@/components/profile-group-feed";
import { ThankModule } from "@/components/thank-module";
import { AgentGraph } from "@/components/agent-graph";
import type { Group, User, Post } from "@/lib/types";

const STABLE_FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";
type GraphEvent = ReturnType<typeof agentToEvent>;

function getStableTimestamp(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return STABLE_FALLBACK_TIMESTAMP;
}

/** Safely narrows unknown values to strings. */
const asString = (value: unknown) => (typeof value === "string" ? value : "");
/** Safely narrows unknown values to arrays of strings. */
const asStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** Safely narrows unknown values to plain object records. */
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getEventStart(event: Record<string, unknown>): string {
  const timeframe = asRecord(event.timeframe);
  const start = asString(timeframe.start);
  if (start) return start;
  return asString(event.startDate) || STABLE_FALLBACK_TIMESTAMP;
}

/**
 * Renders the profile page for the dynamic `username` route.
 *
 * @returns The profile UI for the requested username.
 */
export function PublicProfilePageClient() {
  const params = useParams<{ username: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const { data: session } = useSession();

  const [activeTab, setActiveTab] = useState("about");
  const [agent, setAgent] = useState<SerializedAgent | null>(null);
  const [profileResources, setProfileResources] = useState<SerializedResource[]>([]);
  const [profileActivity, setProfileActivity] = useState<
    Array<{ id: string; verb: string; timestamp: string }>
  >([]);
  const [loaded, setLoaded] = useState(false);
  const [userPosts, setUserPosts] = useState<Post[]>([]);
  const [userEvents, setUserEvents] = useState<GraphEvent[]>([]);
  const [userGroups, setUserGroups] = useState<Group[]>([]);

  const resolveProfileAgent = async (usernameOrId: string) => {
    const trimmed = usernameOrId.trim();
    if (!trimmed) return null;
    if (UUID_RE.test(trimmed)) {
      const agent = await fetchPublicAgentById(trimmed);
      return agent?.type === "person" ? agent : null;
    }
    return fetchAgentByUsername(trimmed);
  };

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const username = params?.username;
      if (!username) return;

      // Phase 1: Instant IndexedDB search by username for immediate display.
      try {
        const localResults = await searchLocalAgents(username, 5);
        const localMatch = localResults.find(
          (a: LocalAgent) =>
            (a.metadata as Record<string, unknown>)?.username === username ||
            a.name.toLowerCase() === username.toLowerCase()
        );
        if (!cancelled && localMatch) {
          setAgent({
            id: localMatch.id,
            name: localMatch.name,
            type: localMatch.type,
            description: localMatch.description ?? null,
            email: localMatch.email ?? null,
            image: localMatch.image ?? null,
            metadata: localMatch.metadata as Record<string, unknown>,
            createdAt: localMatch.createdAt,
            updatedAt: localMatch.updatedAt,
          } as SerializedAgent);
          setLoaded(true);
        }
      } catch {
        // IndexedDB unavailable -- continue to server fetch.
      }

      // Phase 2: Authoritative server fetch + profile data.
      try {
        const record = await resolveProfileAgent(username);
        if (cancelled) return;
        setAgent(record);

        if (record) {
          // Fetch targeted profile data in parallel — only this user's posts/events/groups
          const [profile, postsResult, eventAgents, groupAgents] = await Promise.all([
            fetchProfileData(record.id).catch(() => null),
            fetchUserPosts(record.id, 30).catch(() => ({ posts: [] as SerializedResource[], owner: null })),
            fetchUserEvents(record.id, 30).catch(() => [] as SerializedAgent[]),
            fetchUserGroups(record.id, 30).catch(() => [] as SerializedAgent[]),
          ]);

          if (!cancelled) {
            // Build owner agent for post conversion
            const ownerAgent = postsResult.owner ?? {
              id: record.id,
              name: record.name,
              type: record.type,
              description: record.description,
              email: record.email,
              image: record.image,
              metadata: record.metadata,
              parentId: null,
              pathIds: [],
              depth: 0,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
            } as SerializedAgent;

            setUserPosts(
              postsResult.posts.map((resource) => resourceToPost(resource, ownerAgent)) as Post[]
            );
            setUserEvents(eventAgents.map((event) => agentToEvent(event)));
            setUserGroups(groupAgents.map(agentToGroup));
            setProfileResources((profile?.resources as SerializedResource[]) ?? []);
            setProfileActivity(
              ((profile?.recentActivity as Array<{ id: string; verb: string; timestamp: string }>) ?? [])
                .map((entry) => ({ id: entry.id, verb: entry.verb, timestamp: entry.timestamp }))
            );
          }
        }
        if (!record) {
          setLoaded(true);
        }

        // Persist server result to IndexedDB for future instant loads.
        if (record) {
          upsertAgents([{
            id: record.id,
            name: record.name,
            type: record.type,
            description: record.description ?? null,
            email: record.email ?? null,
            image: record.image ?? null,
            metadata: record.metadata ?? {},
            parentId: null,
            pathIds: [],
            depth: 0,
            createdAt: getStableTimestamp(record.createdAt),
            updatedAt: getStableTimestamp(record.updatedAt, record.createdAt),
          }]).catch(() => {});
        }
      } catch {
        // Server fetch failed -- still show page with whatever IndexedDB data we have.
        if (!cancelled) {
          toast({
            title: "Connection error",
            description: "Could not load full profile data. Showing cached version.",
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [params?.username, router, toast]);

  const metadata = (agent?.metadata ?? {}) as Record<string, unknown>;
  const socialLinks = asRecord(metadata.socialLinks ?? metadata.social_links);
  const userId = agent?.id || "";

  const profileUser: User = useMemo(
    () => ({
      id: userId,
      name: agent?.name || "Unknown User",
      username: asString(metadata.username) || params?.username || "unknown",
      email: agent?.email || "",
      bio: agent?.description || asString(metadata.bio) || "",
      avatar: agent?.image || "/placeholder-user.jpg",
      location: asString(metadata.location),
      skills: asStringArray(metadata.skills),
      resources: asStringArray(metadata.resources),
      chapterTags: asStringArray(metadata.chapterTags),
      groupTags: asStringArray(metadata.groupTags),
      points: typeof metadata.points === "number" ? metadata.points : 0,
      followers: 0,
      following: 0,
      geneKeys: asString(metadata.geneKeys),
      humanDesign: asString(metadata.humanDesign),
      westernAstrology: asString(metadata.westernAstrology),
      vedicAstrology: asString(metadata.vedicAstrology),
      ocean: asString(metadata.ocean),
      myersBriggs: asString(metadata.myersBriggs),
      enneagram: asString(metadata.enneagram),
    }),
    [agent?.description, agent?.email, agent?.id, agent?.image, agent?.name, metadata, params?.username, userId]
  );
  const canGiveToProfileUser = Boolean(session?.user?.id && session.user.id !== profileUser.id);

  // Build lookup Maps from the profile user + targeted group data for getUser/getGroup helpers
  const usersById = useMemo(() => {
    const map = new Map<string, User>();
    map.set(profileUser.id, profileUser);
    return map;
  }, [profileUser]);
  const groupsById = useMemo(() => new Map(userGroups.map((g) => [g.id, g])), [userGroups]);

  const { data: localesData } = useLocalesAndBasins();
  const homeLocaleName = useMemo(() => {
    const localeId = asString(metadata.homeLocale);
    if (!localeId) return "";
    const locale = localesData.locales.find((l) => l.id === localeId);
    return locale?.name ?? "";
  }, [metadata.homeLocale, localesData.locales]);

  const offeringResources = useMemo(
    () =>
      profileResources.filter((resource) => {
        const meta = (resource.metadata ?? {}) as Record<string, unknown>;
        const kind = String(meta.resourceKind ?? "").toLowerCase();
        return (
          resource.type === "resource" ||
          resource.type === "skill" ||
          resource.type === "venue" ||
          resource.type === "voucher" ||
          String(meta.listingKind ?? "").toLowerCase() === "marketplace-listing" ||
          typeof meta.listingType === "string" ||
          kind === "offering"
        );
      }),
    [profileResources]
  );

  const profilePhotos = useMemo(() => {
    const seen = new Set<string>();
    const photos: Array<{ src: string; label: string; id: string; createdAt: string }> = [];
    const metadataProfilePhotos = Array.isArray(metadata.profilePhotos)
      ? metadata.profilePhotos.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];

    for (const [index, image] of metadataProfilePhotos.entries()) {
      if (seen.has(image)) continue;
      seen.add(image);
      photos.push({
        src: image,
        label: "Profile photo",
        id: `profile-photo-${index}`,
        createdAt: getStableTimestamp(profileUser.joinedAt, profileUser.joinDate),
      });
    }

    for (const post of userPosts) {
      const imageList = Array.isArray(post.images) ? post.images : [];
      for (const image of imageList) {
        if (!image || seen.has(image)) continue;
        seen.add(image);
        photos.push({
          src: image,
          label: post.content?.slice(0, 48) || "Post image",
          id: post.id,
          createdAt: getStableTimestamp(post.createdAt, post.timestamp),
        });
      }
    }

    for (const resource of profileResources) {
      const meta = asRecord(resource.metadata);
      const imageCandidates = [
        ...(Array.isArray(meta.images) ? (meta.images as string[]) : []),
        typeof meta.imageUrl === "string" ? meta.imageUrl : "",
        typeof resource.url === "string" ? resource.url : "",
      ].filter((value): value is string => typeof value === "string" && value.length > 0);

      for (const image of imageCandidates) {
        if (seen.has(image)) continue;
        seen.add(image);
        photos.push({
          src: image,
          label: resource.name || "Resource image",
          id: resource.id,
          createdAt: resource.createdAt,
        });
      }
    }

    return photos
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 60);
  }, [metadata.profilePhotos, profileResources, profileUser.joinedAt, userPosts]);

  /** Resolves a user object by ID with a defensive fallback for missing graph entities. */
  const getUser = useMemo(() => (id: string): User =>
    usersById.get(id) || {
      id,
      name: "Unknown User",
      username: "unknown",
      avatar: "/placeholder-user.jpg",
      followers: 0,
      following: 0,
    }, [usersById]);

  /** Resolves a group object by ID with a defensive fallback for missing graph entities. */
  const getGroup = useMemo(() => (id: string): Group =>
    (groupsById.get(id) as Group | undefined) || {
      id,
      name: "Unknown Group",
      description: "",
      image: "/placeholder.svg",
      memberCount: 0,
      createdAt: STABLE_FALLBACK_TIMESTAMP,
    }, [groupsById]);

  // Computed stats mirroring personal profile Quick Stats card.
  const likesReceived = useMemo(() => userPosts.reduce((sum, post) => sum + (post.likes || 0), 0), [userPosts]);
  const commentsReceived = useMemo(() => userPosts.reduce((sum, post) => sum + (post.comments || 0), 0), [userPosts]);
  const thanksReceived = useMemo(
    () => profileActivity.filter((entry) => entry.verb === "react" || entry.verb === "thank").length,
    [profileActivity]
  );
  const hoursContributed = useMemo(() => {
    const parsePrice = (value: unknown): number | undefined => {
      if (typeof value === "number") return value;
      if (typeof value === "string") {
        const cleaned = value.replace(/[^0-9.-]/g, "");
        const n = Number(cleaned);
        if (Number.isFinite(n)) return n;
      }
      return undefined;
    };
    const taskHours = profileResources
      .filter((resource) => resource.type === "task")
      .map((resource) => {
        const meta = asRecord(resource.metadata);
        return parsePrice(meta.estimatedHours ?? meta.estimatedTime ?? meta.hours) ?? 0;
      })
      .reduce((sum, value) => sum + value, 0);
    if (taskHours > 0) return Math.round(taskHours);
    return profileActivity.filter((entry) => entry.verb === "complete" || entry.verb === "contribute").length * 2;
  }, [profileActivity, profileResources]);

  const upcomingEventCount = useMemo(
    () =>
      userEvents.filter((event) => {
        const start = getEventStart(event as unknown as Record<string, unknown>);
        return new Date(start).getTime() >= Date.now();
      }).length,
    [userEvents]
  );

  const coverImage = asString(metadata.coverImage) || "/vibrant-garden-tending.png";
  const memberSince = agent?.createdAt ? new Date(agent.createdAt).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "Unknown";

  const personaItems = [
    { label: "Gene Keys", value: profileUser.geneKeys },
    { label: "Human Design", value: profileUser.humanDesign },
    { label: "Western Astrology", value: profileUser.westernAstrology },
    { label: "Vedic Astrology", value: profileUser.vedicAstrology },
    { label: "OCEAN", value: profileUser.ocean },
    { label: "Myers-Briggs", value: profileUser.myersBriggs },
    { label: "Enneagram", value: profileUser.enneagram },
  ].filter((item) => item.value && item.value.length > 0);

  // Conditional render: show loading shell until async username/profile fetch completes.
  if (!loaded) {
    return <div className="container max-w-5xl py-6 text-sm text-muted-foreground">Loading profile...</div>;
  }

  // Show a not-found state instead of redirecting when no agent matches.
  if (loaded && !agent) {
    return (
      <div className="container max-w-5xl py-12 text-center">
        <h2 className="text-2xl font-bold mb-2">User not found</h2>
        <p className="text-muted-foreground mb-4">No profile found for @{params?.username}</p>
        <Link href="/"><Button variant="outline">Back to Home</Button></Link>
      </div>
    );
  }

  return (
    <div className="pb-20">
      <div className="container max-w-6xl mx-auto py-4 space-y-6">
        {/* Hero Section -- mirrors personal profile layout (read-only) */}
        <div className="rounded-xl border overflow-hidden bg-card">
          <div
            className="relative h-40 md:h-52 bg-cover bg-center w-full"
            style={{ backgroundImage: `url(${coverImage})` }}
          />
          <div className="px-4 md:px-6 pb-4">
            <div className="flex items-start justify-between gap-4 -mt-12 md:-mt-14">
              <div className="relative h-24 w-24 md:h-28 md:w-28 rounded-full border-4 border-background bg-muted overflow-hidden">
                <Image
                  src={profileUser.avatar}
                  alt={profileUser.name}
                  width={112}
                  height={112}
                  className="h-full w-full object-cover"
                  unoptimized
                />
              </div>
              <div className="flex items-center gap-2">
                {canGiveToProfileUser ? (
                  <ThankModule
                    recipientId={profileUser.id}
                    recipientName={profileUser.name}
                    recipientAvatar={profileUser.avatar}
                    triggerButton={
                      <Button size="sm" variant="outline" type="button">
                        <Gift className="h-4 w-4 mr-2" />
                        Give
                      </Button>
                    }
                  />
                ) : null}
                <Button size="sm" variant="outline" onClick={() => router.push(`/messages?user=${profileUser.id}`)}>
                  Message
                </Button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2 space-y-2">
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-bold leading-tight">{profileUser.name}</h1>
                  {metadata.isPersona === true && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground" title="This is a persona (alternate identity)">
                      <Drama className="h-3 w-3" />
                      Persona
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">@{profileUser.username}</p>
                {Object.entries(socialLinks).length > 0 && (
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    {Object.entries(socialLinks).map(([key, value]) => (
                      <a key={key} href={getSocialHref(key, String(value))} target={key === "phone" || key === "email" ? undefined : "_blank"} rel={key === "phone" || key === "email" ? undefined : "noopener noreferrer"} className="inline-flex items-center gap-1 text-primary hover:underline">
                        {getSocialIcon(key)}{getSocialDisplayLabel(key)}
                      </a>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{profileUser.location || "Location not set"}</span>
                  <span className="inline-flex items-center gap-1"><Award className="h-3.5 w-3.5" />{profileUser.points || 0} points</span>
                  <span className="inline-flex items-center gap-1"><CalendarIcon className="h-3.5 w-3.5" />{upcomingEventCount} upcoming events</span>
                  <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />{userGroups.length} groups</span>
                </div>
                <p className="text-sm text-muted-foreground">{profileUser.bio || "No bio yet."}</p>
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Quick Stats</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex items-center justify-between text-sm"><span className="inline-flex items-center gap-2 text-muted-foreground"><Heart className="h-4 w-4" />Likes received</span><span className="font-medium">{likesReceived}</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="inline-flex items-center gap-2 text-muted-foreground"><MessageSquare className="h-4 w-4" />Comments</span><span className="font-medium">{commentsReceived}</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="inline-flex items-center gap-2 text-muted-foreground"><Clock className="h-4 w-4" />Hours contributed</span><span className="font-medium">{hoursContributed}</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="inline-flex items-center gap-2 text-muted-foreground"><Award className="h-4 w-4" />Thanks received</span><span className="font-medium">{thanksReceived}</span></div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>

        {/* Tabs -- no wallet, calendar, or saved tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid grid-cols-4 md:grid-cols-7 w-full">
            <TabsTrigger value="about">About</TabsTrigger>
            <TabsTrigger value="posts">Posts</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
            <TabsTrigger value="groups">Groups</TabsTrigger>
            <TabsTrigger value="photos">Photos</TabsTrigger>
            <TabsTrigger value="offerings">Offerings</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="about" className="mt-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 space-y-4">
                <Card>
                  <CardHeader><CardTitle className="text-lg">Bio</CardTitle></CardHeader>
                  <CardContent><p className="text-sm text-muted-foreground">{profileUser.bio || "No bio yet."}</p></CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle className="text-lg">Skills & Expertise</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {profileUser.skills && profileUser.skills.length > 0 ? (
                      profileUser.skills.map((skill) => (
                        <div key={skill} className="text-sm font-medium">{skill}</div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">No skills listed.</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle className="text-lg">Languages</CardTitle></CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    {asStringArray(metadata.languages).length > 0 ? (
                      asStringArray(metadata.languages).map((language) => (
                        <Badge key={language} variant="outline">{language}</Badge>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">None listed.</p>
                    )}
                  </CardContent>
                </Card>
              </div>

              <div className="space-y-4">
                <Card>
                  <CardHeader><CardTitle className="text-lg">Personal Information</CardTitle></CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div><p className="text-xs text-muted-foreground">Location</p><p>{profileUser.location || "Not set"}</p></div>
                    <div><p className="text-xs text-muted-foreground">Member Since</p><p>{memberSince}</p></div>
                    <div><p className="text-xs text-muted-foreground">Languages</p><p>{asStringArray(metadata.languages).join(", ") || "Not set"}</p></div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle className="text-lg">Interests</CardTitle></CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    {asStringArray(metadata.interests).length > 0 ? (
                      asStringArray(metadata.interests).map((interest) => <Badge key={interest} variant="outline">{interest}</Badge>)
                    ) : (
                      <p className="text-sm text-muted-foreground">No interests listed.</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle className="text-lg">Links</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p className="text-muted-foreground">Home locale: {homeLocaleName || "Not set"}</p>
                    {Object.entries(socialLinks).length > 0 ? (
                      Object.entries(socialLinks).map(([key, value]) => (
                        <a key={key} href={getSocialHref(key, String(value))} target={key === "phone" || key === "email" ? undefined : "_blank"} rel={key === "phone" || key === "email" ? undefined : "noopener noreferrer"} className="flex items-center gap-2 text-muted-foreground hover:text-primary">
                          {getSocialIcon(key, "md")}{getSocialDisplayLabel(key)}: {String(value)}
                        </a>
                      ))
                    ) : (
                      <p className="text-muted-foreground">No links listed.</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle className="text-lg">Persona</CardTitle></CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {personaItems.length > 0 ? (
                      personaItems.map((item) => (
                        <div key={item.label}>
                          <p className="text-xs text-muted-foreground">{item.label}</p>
                          <p>{item.value}</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-muted-foreground">No persona data yet.</p>
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card className="lg:col-span-3">
                <CardHeader><CardTitle className="text-lg">Relationships</CardTitle></CardHeader>
                <CardContent>
                  <AgentGraph agentId={userId} agentName={profileUser.name} agentType="person" />
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="posts" className="mt-4">
            <PostFeed
              posts={userPosts}
              getUser={getUser}
              getGroup={getGroup}
              includeAllTypes={false}
            />
          </TabsContent>

          <TabsContent value="events" className="mt-4">
            <EventFeed
              events={userEvents}
              getGroupName={(id) => getGroup(id).name}
              getGroupId={(id) => id}
              getCreatorName={(id) => getUser(id).name}
              getCreatorUsername={(id) => getUser(id).username}
            />
          </TabsContent>

          <TabsContent value="groups" className="mt-4">
            <ProfileGroupFeed
              groups={userGroups}
              currentUserId={userId}
              getMembers={(memberIds) => memberIds.map((id) => getUser(id))}
            />
          </TabsContent>

          <TabsContent value="photos" className="mt-4">
            {profilePhotos.length === 0 ? (
              <p className="text-sm text-muted-foreground">No photos yet.</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {profilePhotos.map((photo) => (
                  <Card key={`${photo.id}-${photo.src}`} className="overflow-hidden">
                    <Image
                      src={photo.src}
                      alt={photo.label}
                      width={420}
                      height={260}
                      className="h-40 w-full object-cover"
                      unoptimized
                    />
                    <CardContent className="py-2">
                      <p className="text-xs text-muted-foreground truncate">{photo.label}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="offerings" className="mt-4 space-y-3">
            {offeringResources.length === 0 ? <p className="text-sm text-muted-foreground">No offerings yet.</p> : null}
            {offeringResources.map((resource) => {
              const meta = (resource.metadata ?? {}) as Record<string, unknown>;
              const price = meta.price ?? meta.basePrice;
              return (
                <Card key={resource.id}>
                  <CardContent className="py-3">
                    <p className="font-medium">{resource.name}</p>
                    <p className="text-sm text-muted-foreground">{resource.description || "No description"}</p>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline">{String(resource.type)}</Badge>
                      {price !== undefined && price !== null ? <span>{String(price)}</span> : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </TabsContent>

          <TabsContent value="activity" className="mt-4 space-y-3">
            {profileActivity.length === 0 ? <p className="text-sm text-muted-foreground">No activity yet.</p> : null}
            {profileActivity.map((entry) => (
              <Card key={entry.id}>
                <CardContent className="py-3 flex items-center justify-between gap-3">
                  <p className="font-medium">{entry.verb}</p>
                  <p className="text-xs text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</p>
                </CardContent>
              </Card>
            ))}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
