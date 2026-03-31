"use client";

import { useState, useEffect, useCallback, useMemo, useRef, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Globe, MapPin, Moon, Plus, Shield, Sun, User, Store, CheckCircle2, AlertCircle, ExternalLink, Loader2, X, Sparkles, Brain, Eye, Wallet, Activity, UserCheck, Fingerprint, Upload, Trash2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateProfileAction, updateProfileImageAction } from "@/app/actions/settings";
import {
  linkAtprotoIdentityAction,
  linkPeermeshIdentityAction,
  unlinkAtprotoIdentityAction,
  unlinkPeermeshIdentityAction,
} from "@/app/actions/federation-identities";
import { setupConnectAccountAction, getConnectBalanceAction, getConnectStatusAction } from "@/app/actions/wallet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { useTheme } from "next-themes";
import { invalidateGraphCache, useLocalesAndBasins } from "@/lib/hooks/use-graph-data";
import { SearchableSelect } from "@/components/searchable-select";
import { HomeLocaleSelector } from "@/components/home-locale-selector";
import { Textarea } from "@/components/ui/textarea";
import { ImageUpload } from "@/components/image-upload";
import type { FederationIdentityStatus } from "@/lib/federation-identities";
import type { AppReleaseStatus } from "@/lib/app-release";

export type SettingsInitialData = {
  name: string;
  username: string;
  email: string;
  bio: string;
  tagline: string;
  phone: string;
  image: string;
  skills: string[];
  geneKeys: string;
  humanDesign: string;
  westernAstrology: string;
  vedicAstrology: string;
  ocean: string;
  myersBriggs: string;
  enneagram: string;
  homeLocale: string;
  murmurationsPublishing: boolean;
  socialLinks: Record<string, string>;
  profilePhotos: string[];
  privacySettings: Partial<PrivacySettings>;
  notificationSettings: Omit<NotificationSettings, "murmurationsPublishing">;
};

/** Visibility scope for individual privacy controls. */
type VisibilityScope = "public" | "locale" | "connections" | "self";

/** Comprehensive granular privacy settings grouped by domain. */
type PrivacySettings = {
  /** Legacy compat fields — kept for backward compatibility with existing data. */
  profileVisibility: "public" | "friends" | "private";
  friendRequests: "everyone" | "friends-of-friends" | "nobody";
  locationSharing: "always" | "events" | "never";

  /** Transaction Visibility */
  transactionPurchases: VisibilityScope;
  transactionSales: VisibilityScope;
  transactionGiftsReceived: VisibilityScope;
  transactionTransfers: VisibilityScope;
  transactionWalletBalance: "self" | "connections";

  /** Activity Visibility */
  activityGroupMemberships: VisibilityScope;
  activityEventAttendance: VisibilityScope;
  activityPosts: VisibilityScope;
  activityOfferings: VisibilityScope;
  activityJobApplications: "self";

  /** Profile Attribute Visibility */
  attributeFullName: VisibilityScope;
  attributeEmail: "connections" | "self";
  attributeLocation: VisibilityScope;
  attributeSkills: VisibilityScope;
  attributeBio: VisibilityScope;
  attributeSocialLinks: VisibilityScope;
  attributeAvatar: VisibilityScope;

  /** ZK Identity Settings */
  zkEnabled: boolean;
  zkExposedAttributes: string[];
  zkConditionalRules: ZkConditionalRule[];

  /** Universal Manifest */
  manifestLastSynced: string | null;
};

type ZkConditionalRule = {
  id: string;
  attribute: string;
  operator: "equals" | "greater_than" | "less_than" | "between" | "contains";
  value: string;
};

const ZK_ATTRIBUTE_OPTIONS = [
  { value: "age_range", label: "Age range" },
  { value: "height_range", label: "Height range" },
  { value: "income_range", label: "Income range" },
  { value: "location_city", label: "Location (city-level)" },
] as const;

const ZK_RULE_ATTRIBUTE_OPTIONS = [
  { value: "age", label: "Age" },
  { value: "height", label: "Height" },
  { value: "income", label: "Income" },
  { value: "location", label: "Location" },
  { value: "skills_count", label: "Number of skills" },
  { value: "membership_tier", label: "Membership tier" },
] as const;

const ZK_OPERATOR_OPTIONS = [
  { value: "equals", label: "equals" },
  { value: "greater_than", label: "greater than" },
  { value: "less_than", label: "less than" },
  { value: "between", label: "between" },
  { value: "contains", label: "contains" },
] as const;

/** Default privacy settings for new users or missing fields. */
const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  profileVisibility: "public",
  friendRequests: "everyone",
  locationSharing: "events",
  transactionPurchases: "self",
  transactionSales: "connections",
  transactionGiftsReceived: "connections",
  transactionTransfers: "self",
  transactionWalletBalance: "self",
  activityGroupMemberships: "public",
  activityEventAttendance: "public",
  activityPosts: "public",
  activityOfferings: "public",
  activityJobApplications: "self",
  attributeFullName: "public",
  attributeEmail: "self",
  attributeLocation: "locale",
  attributeSkills: "public",
  attributeBio: "public",
  attributeSocialLinks: "connections",
  attributeAvatar: "public",
  zkEnabled: false,
  zkExposedAttributes: [],
  zkConditionalRules: [],
  manifestLastSynced: null,
};

/** Merges partial/legacy privacy data with full defaults. */
function mergePrivacySettings(partial: Partial<PrivacySettings> | undefined): PrivacySettings {
  if (!partial) return { ...DEFAULT_PRIVACY_SETTINGS };
  return { ...DEFAULT_PRIVACY_SETTINGS, ...partial };
}

type NotificationSettings = {
  pushNotifications: boolean;
  emailNotifications: boolean;
  eventReminders: boolean;
  newMessages: boolean;
  murmurationsPublishing: boolean;
};

type AppearanceSettings = {
  darkMode: boolean;
  textSize: number;
  colorTheme: "primary" | "blue" | "green" | "purple" | "pink";
};

type FederationSettingsState =
  | { status: "idle" | "loading" | "error"; error?: string }
  | ({ status: "ready" } & FederationIdentityStatus);

const SOCIAL_PLATFORM_OPTIONS = [
  { value: "website", label: "Website" },
  { value: "x", label: "X (Twitter)" },
  { value: "instagram", label: "Instagram" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "telegram", label: "Telegram" },
  { value: "signal", label: "Signal" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
] as const;

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  return `${parts[0][0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

function normalizeLocaleToken(value: string): string {
  return value.trim().toLowerCase();
}

/** Reusable row for custom option sets (e.g. general privacy, wallet balance). */
function VisibilityRow({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-[160px] shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Standard 4-option visibility scope row (Public / Locale / Connections / Only Me). */
function VisibilityScopeRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: VisibilityScope;
  onChange: (value: VisibilityScope) => void;
}) {
  return (
    <VisibilityRow
      label={label}
      description={description}
      value={value}
      options={[
        { value: "public", label: "Public" },
        { value: "locale", label: "Locale" },
        { value: "connections", label: "Connections" },
        { value: "self", label: "Only Me" },
      ]}
      onChange={(v) => onChange(v as VisibilityScope)}
    />
  );
}

export function SettingsForm({
  initialData,
  initialFederationStatus,
  initialAppReleaseStatus,
}: {
  initialData: SettingsInitialData;
  initialFederationStatus: FederationIdentityStatus | null;
  initialAppReleaseStatus: AppReleaseStatus | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { theme, setTheme } = useTheme();

  const [isSaving, setIsSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState<SettingsInitialData>(initialData);
  const [skillInput, setSkillInput] = useState("");
  const { data: localesData } = useLocalesAndBasins();
  const [privacySettings, setPrivacySettings] = useState<PrivacySettings>(
    mergePrivacySettings(initialData.privacySettings as Partial<PrivacySettings>)
  );
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>({
    ...initialData.notificationSettings,
    murmurationsPublishing: initialData.murmurationsPublishing,
  });
  const [appearanceSettings, setAppearanceSettings] = useState<AppearanceSettings>({
    darkMode: theme === "dark",
    textSize: 3,
    colorTheme: "primary",
  });
  const [federationSettings, setFederationSettings] = useState<FederationSettingsState>(
    initialFederationStatus
      ? { status: "ready", ...initialFederationStatus }
      : { status: "error", error: "Unable to load federation settings." }
  );
  const [peermeshInput, setPeermeshInput] = useState("");
  const [blueskyHandle, setBlueskyHandle] = useState("");
  const [blueskyAppPassword, setBlueskyAppPassword] = useState("");
  const [federationSaving, setFederationSaving] = useState<"peermesh" | "atproto" | null>(null);
  const localeOptions = useMemo(
    () =>
      localesData.locales.map((locale) => ({
        value: locale.id,
        label: locale.name,
        keywords: [locale.slug, locale.name, locale.id].filter(
          (entry): entry is string => typeof entry === "string" && entry.length > 0
        ),
      })),
    [localesData.locales]
  );

  useEffect(() => {
    if (!profile.homeLocale || localesData.locales.length === 0) return;

    const normalizedCurrent = normalizeLocaleToken(profile.homeLocale);
    const matchedLocale = localesData.locales.find((locale) => {
      return (
        normalizeLocaleToken(locale.id) === normalizedCurrent ||
        normalizeLocaleToken(locale.slug) === normalizedCurrent ||
        normalizeLocaleToken(locale.name) === normalizedCurrent
      );
    });

    if (matchedLocale && matchedLocale.id !== profile.homeLocale) {
      setProfile((prev) => ({ ...prev, homeLocale: matchedLocale.id }));
    }
  }, [localesData.locales, profile.homeLocale]);

  const handleAvatarUpload = useCallback(async (file: File) => {
    setUploadingAvatar(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("bucket", "avatars");
      const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
      const uploadJson = await uploadRes.json();
      if (!uploadRes.ok || !uploadJson.results?.[0]?.url) {
        toast({ title: "Upload failed", description: uploadJson.error || "Could not upload image.", variant: "destructive" });
        return;
      }
      const result = await updateProfileImageAction("avatar", uploadJson.results[0].url);
      if (result.success) {
        toast({ title: "Avatar updated" });
        setProfile((prev) => ({ ...prev, image: uploadJson.results[0].url }));
        router.refresh();
      } else {
        toast({ title: "Update failed", description: result.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "Upload failed", description: "Something went wrong.", variant: "destructive" });
    } finally {
      setUploadingAvatar(false);
    }
  }, [toast, router]);

  const applyFederationStatus = useCallback(
    (next: FederationIdentityStatus) => {
      setFederationSettings({
        status: "ready",
        ...next,
      });
    },
    []
  );

  async function handleLinkPeermesh() {
    setFederationSaving("peermesh");
    try {
      const result = await linkPeermeshIdentityAction({ manifestInput: peermeshInput });
      if (!result.success || !result.data) {
        toast({
          title: "Unable to link PeerMesh",
          description: result.error ?? "Please check the export and try again.",
          variant: "destructive",
        });
        return;
      }
      applyFederationStatus(result.data);
      setPeermeshInput("");
      toast({
        title: "PeerMesh linked",
        description: "Your Spatial / Universal Manifest identity is now linked to this profile.",
      });
    } finally {
      setFederationSaving(null);
    }
  }

  async function handleUnlinkPeermesh() {
    setFederationSaving("peermesh");
    try {
      const result = await unlinkPeermeshIdentityAction();
      if (!result.success || !result.data) {
        toast({
          title: "Unable to unlink PeerMesh",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        });
        return;
      }
      applyFederationStatus(result.data);
      toast({
        title: "PeerMesh unlinked",
      });
    } finally {
      setFederationSaving(null);
    }
  }

  async function handleLinkAtproto() {
    setFederationSaving("atproto");
    try {
      const result = await linkAtprotoIdentityAction({
        handle: blueskyHandle,
        appPassword: blueskyAppPassword,
      });
      if (!result.success || !result.data) {
        toast({
          title: "Unable to link Bluesky",
          description: result.error ?? "Please check the handle and app password.",
          variant: "destructive",
        });
        return;
      }
      applyFederationStatus(result.data);
      setBlueskyAppPassword("");
      toast({
        title: "Bluesky linked",
        description: "Your AT Protocol identity is now linked to this profile.",
      });
    } finally {
      setFederationSaving(null);
    }
  }

  async function handleUnlinkAtproto() {
    setFederationSaving("atproto");
    try {
      const result = await unlinkAtprotoIdentityAction();
      if (!result.success || !result.data) {
        toast({
          title: "Unable to unlink Bluesky",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        });
        return;
      }
      applyFederationStatus(result.data);
      toast({
        title: "Bluesky unlinked",
      });
    } finally {
      setFederationSaving(null);
    }
  }

  async function onSaveChanges() {
    setIsSaving(true);
    try {
      const result = await updateProfileAction({
        name: profile.name,
        username: profile.username,
        email: profile.email,
        bio: profile.bio,
        tagline: profile.tagline,
        phone: profile.phone,
        skills: profile.skills,
        geneKeys: profile.geneKeys,
        humanDesign: profile.humanDesign,
        westernAstrology: profile.westernAstrology,
        vedicAstrology: profile.vedicAstrology,
        ocean: profile.ocean,
        myersBriggs: profile.myersBriggs,
        enneagram: profile.enneagram,
        homeLocale: profile.homeLocale,
        murmurationsPublishing: notificationSettings.murmurationsPublishing,
        socialLinks: profile.socialLinks,
        profilePhotos: profile.profilePhotos,
        privacySettings,
        notificationSettings: {
          pushNotifications: notificationSettings.pushNotifications,
          emailNotifications: notificationSettings.emailNotifications,
          eventReminders: notificationSettings.eventReminders,
          newMessages: notificationSettings.newMessages,
        },
      });

      if (!result.success) {
        toast({
          title: "Unable to save settings",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Settings saved",
        description: "Your profile changes were saved successfully.",
      });
      invalidateGraphCache("graph.");
      router.refresh();
    } catch (error) {
      toast({
        title: "Unable to save settings",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" className="p-0" onClick={() => router.back()} aria-label="Go back">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            App Version
          </CardTitle>
          <CardDescription>
            This deployment advertises its current build and, when available, the latest upstream release so sovereign instances can stay in sync.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {initialAppReleaseStatus ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={initialAppReleaseStatus.updateAvailable ? "destructive" : "secondary"}>
                  {initialAppReleaseStatus.updateAvailable ? "Update Available" : "Up To Date"}
                </Badge>
                <span className="text-muted-foreground">
                  Current <span className="font-medium text-foreground">{initialAppReleaseStatus.currentVersion}</span>
                </span>
                {initialAppReleaseStatus.latestVersion ? (
                  <span className="text-muted-foreground">
                    Latest <span className="font-medium text-foreground">{initialAppReleaseStatus.latestVersion}</span>
                  </span>
                ) : null}
                <span className="text-muted-foreground">
                  Channel <span className="font-medium text-foreground">{initialAppReleaseStatus.releaseChannel}</span>
                </span>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border p-3 text-sm">
                  <p className="font-medium">Upstream Repo</p>
                  <p className="mt-1 break-all text-muted-foreground">{initialAppReleaseStatus.upstreamRepo}</p>
                </div>
                <div className="rounded-lg border p-3 text-sm">
                  <p className="font-medium">Deployment URL</p>
                  <p className="mt-1 break-all text-muted-foreground">{initialAppReleaseStatus.deploymentUrl ?? "Not declared"}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                {initialAppReleaseStatus.latestUrl ? (
                  <a
                    href={initialAppReleaseStatus.latestUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex"
                  >
                    <Button variant={initialAppReleaseStatus.updateAvailable ? "default" : "outline"}>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      {initialAppReleaseStatus.updateAvailable ? "Update This Instance" : "View Releases"}
                    </Button>
                  </a>
                ) : null}
                {initialAppReleaseStatus.changelogUrl ? (
                  <a
                    href={initialAppReleaseStatus.changelogUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex"
                  >
                    <Button variant="ghost">
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Changelog
                    </Button>
                  </a>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Release metadata is unavailable for this deployment.</p>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="account" className="space-y-4">
        <TabsList className="grid grid-cols-6">
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="privacy">Privacy</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="seller">Seller</TabsTrigger>
          <TabsTrigger value="federation">Federation</TabsTrigger>
        </TabsList>

        <TabsContent value="account" className="space-y-4">
          <div className="flex items-center gap-4 mb-6">
            <Avatar className="h-20 w-20">
              <AvatarImage src={profile.image || "/placeholder.svg?height=80&width=80"} alt={profile.username} />
              <AvatarFallback>{getInitials(profile.name)}</AvatarFallback>
            </Avatar>
            <div>
              <h2 className="text-xl font-bold">{profile.name}</h2>
              <p className="text-muted-foreground">@{profile.username}</p>
              <Button size="sm" variant="outline" className="mt-2" disabled={uploadingAvatar} onClick={() => avatarInputRef.current?.click()}>
                {uploadingAvatar ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Uploading...</> : "Change Photo"}
              </Button>
              <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAvatarUpload(f); e.target.value = ""; }} />
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid gap-2">
              <label className="text-sm font-medium">Name</label>
              <input
                type="text"
                className="p-2 border rounded-md bg-background text-foreground"
                value={profile.name}
                onChange={(e) => setProfile((prev) => ({ ...prev, name: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">Username</label>
              <input
                type="text"
                className="p-2 border rounded-md bg-background text-foreground"
                value={profile.username}
                onChange={(e) => setProfile((prev) => ({ ...prev, username: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">Email</label>
              <input
                type="email"
                className="p-2 border rounded-md bg-background text-foreground"
                value={profile.email}
                onChange={(e) => setProfile((prev) => ({ ...prev, email: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">Phone</label>
              <input
                type="tel"
                className="p-2 border rounded-md bg-background text-foreground"
                value={profile.phone}
                onChange={(e) => setProfile((prev) => ({ ...prev, phone: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">Tagline</label>
              <input
                type="text"
                className="p-2 border rounded-md bg-background text-foreground"
                placeholder="A short tagline shown under your name"
                value={profile.tagline}
                onChange={(e) => setProfile((prev) => ({ ...prev, tagline: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">Bio</label>
              <textarea
                className="p-2 border rounded-md bg-background text-foreground"
                rows={3}
                value={profile.bio}
                onChange={(e) => setProfile((prev) => ({ ...prev, bio: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  Home Locale
                </span>
              </label>
              <SearchableSelect
                value={profile.homeLocale}
                onChange={(value) => setProfile((prev) => ({ ...prev, homeLocale: value }))}
                options={localeOptions}
                placeholder="Select a locale..."
                searchPlaceholder="Search locales..."
                emptyLabel="No locales found."
              />
              <p className="text-xs text-muted-foreground">Your primary locale community</p>
              <HomeLocaleSelector
                chapters={localesData.locales}
                basins={localesData.basins}
                selectedLocaleId={profile.homeLocale}
                onSelectLocale={(localeId) =>
                  setProfile((prev) => ({ ...prev, homeLocale: localeId }))
                }
              />
            </div>

            <Separator className="my-6" />

            {/* Social Links Section */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <label className="text-sm font-medium">Social Links</label>
              </div>
              <div className="space-y-2">
                {Object.entries(profile.socialLinks).map(([platform, url]) => {
                  const usedPlatforms = Object.keys(profile.socialLinks).filter((k) => k !== platform);
                  const inputType = platform === "phone" ? "tel" : platform === "email" ? "email" : "url";
                  const inputPlaceholder = platform === "phone" ? "(555) 123-4567" : platform === "email" ? "you@example.com" : "https://...";
                  return (
                    <div key={platform} className="flex items-center gap-2">
                      <Select
                        value={platform}
                        onValueChange={(newPlatform) => {
                          setProfile((prev) => {
                            const entries = Object.entries(prev.socialLinks);
                            const updated = Object.fromEntries(
                              entries.map(([k, v]) => (k === platform ? [newPlatform, v] : [k, v]))
                            );
                            return { ...prev, socialLinks: updated };
                          });
                        }}
                      >
                        <SelectTrigger className="w-1/3">
                          <SelectValue placeholder="Platform" />
                        </SelectTrigger>
                        <SelectContent>
                          {SOCIAL_PLATFORM_OPTIONS.filter((opt) => !usedPlatforms.includes(opt.value)).map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <input
                        type={inputType}
                        className="p-2 border rounded-md flex-1 bg-background text-foreground"
                        placeholder={inputPlaceholder}
                        value={url}
                        onChange={(e) =>
                          setProfile((prev) => ({
                            ...prev,
                            socialLinks: { ...prev.socialLinks, [platform]: e.target.value },
                          }))
                        }
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${platform} link`}
                        className="p-2 hover:text-destructive"
                        onClick={() =>
                          setProfile((prev) => {
                            const { [platform]: _, ...rest } = prev.socialLinks;
                            return { ...prev, socialLinks: rest };
                          })
                        }
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={Object.keys(profile.socialLinks).length >= SOCIAL_PLATFORM_OPTIONS.length}
                onClick={() => {
                  const usedPlatforms = Object.keys(profile.socialLinks);
                  const nextPlatform = SOCIAL_PLATFORM_OPTIONS.find((opt) => !usedPlatforms.includes(opt.value));
                  if (nextPlatform) {
                    setProfile((prev) => ({
                      ...prev,
                      socialLinks: { ...prev.socialLinks, [nextPlatform.value]: "" },
                    }));
                  }
                }}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add Link
              </Button>
            </div>

            <Separator className="my-6" />

            {/* Skills Section */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                <label className="text-sm font-medium">Skills</label>
              </div>
              <div className="flex flex-wrap gap-2">
                {profile.skills.map((skill) => (
                  <Badge key={skill} variant="secondary" className="flex items-center gap-1 px-3 py-1">
                    {skill}
                    <button
                      type="button"
                      aria-label={`Remove ${skill}`}
                      className="ml-1 hover:text-destructive"
                      onClick={() =>
                        setProfile((prev) => ({
                          ...prev,
                          skills: prev.skills.filter((s) => s !== skill),
                        }))
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <input
                type="text"
                className="p-2 border rounded-md w-full bg-background text-foreground"
                placeholder="Type a skill and press Enter"
                value={skillInput}
                onChange={(e) => setSkillInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const trimmed = skillInput.trim();
                    if (trimmed && !profile.skills.includes(trimmed)) {
                      setProfile((prev) => ({
                        ...prev,
                        skills: [...prev.skills, trimmed],
                      }));
                    }
                    setSkillInput("");
                  }
                }}
              />
            </div>

            <Separator className="my-6" />

            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                <label className="text-sm font-medium">Profile Photos</label>
              </div>
              <p className="text-sm text-muted-foreground">
                Add photos that appear in your profile&apos;s Photos tab even when they are not attached to a post or offering.
              </p>
              <ImageUpload
                value={profile.profilePhotos}
                onChange={(urls) => setProfile((prev) => ({ ...prev, profilePhotos: urls }))}
                maxFiles={8}
                bucket="uploads"
              />
            </div>

            <Separator className="my-6" />

            {/* Persona Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Brain className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Persona / Personal Info</h3>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-sm font-medium">Gene Keys</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. 55-59-34"
                    value={profile.geneKeys}
                    onChange={(e) => setProfile((prev) => ({ ...prev, geneKeys: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">Human Design</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. Generator 2/4"
                    value={profile.humanDesign}
                    onChange={(e) => setProfile((prev) => ({ ...prev, humanDesign: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">Western Astrology</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. Leo Sun, Pisces Moon"
                    value={profile.westernAstrology}
                    onChange={(e) => setProfile((prev) => ({ ...prev, westernAstrology: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">Vedic Astrology</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. Ashlesha Nakshatra"
                    value={profile.vedicAstrology}
                    onChange={(e) => setProfile((prev) => ({ ...prev, vedicAstrology: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">OCEAN (Big Five)</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. O:85 C:70 E:60 A:75 N:30"
                    value={profile.ocean}
                    onChange={(e) => setProfile((prev) => ({ ...prev, ocean: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium">Myers-Briggs</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. INFP"
                    value={profile.myersBriggs}
                    onChange={(e) => setProfile((prev) => ({ ...prev, myersBriggs: e.target.value }))}
                  />
                </div>

                <div className="grid gap-2 sm:col-span-2">
                  <label className="text-sm font-medium">Enneagram</label>
                  <input
                    type="text"
                    className="p-2 border rounded-md bg-background text-foreground"
                    placeholder="e.g. 4w5"
                    value={profile.enneagram}
                    onChange={(e) => setProfile((prev) => ({ ...prev, enneagram: e.target.value }))}
                  />
                </div>
              </div>
            </div>

            <Button className="w-full" onClick={onSaveChanges} disabled={isSaving}>
              {isSaving ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="privacy" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Privacy & Visibility Settings
              </CardTitle>
              <CardDescription>
                Control who can see your profile information, transactions, and activity.
                Changes are saved when you click &quot;Save Privacy Settings&quot; at the bottom.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Accordion type="multiple" defaultValue={["general", "transactions", "activity", "attributes"]} className="w-full">

                {/* General Privacy */}
                <AccordionItem value="general">
                  <AccordionTrigger className="text-base font-semibold">
                    <div className="flex items-center gap-2">
                      <Eye className="h-4 w-4 text-teal-500" />
                      General Privacy
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <VisibilityRow
                      label="Profile Visibility"
                      description="Overall visibility of your profile to others"
                      value={privacySettings.profileVisibility}
                      options={[
                        { value: "public", label: "Public" },
                        { value: "friends", label: "Friends Only" },
                        { value: "private", label: "Private" },
                      ]}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, profileVisibility: v as PrivacySettings["profileVisibility"] }))}
                    />
                    <Separator />
                    <VisibilityRow
                      label="Friend Requests"
                      description="Who can send you connection requests"
                      value={privacySettings.friendRequests}
                      options={[
                        { value: "everyone", label: "Everyone" },
                        { value: "friends-of-friends", label: "Friends of Friends" },
                        { value: "nobody", label: "Nobody" },
                      ]}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, friendRequests: v as PrivacySettings["friendRequests"] }))}
                    />
                    <Separator />
                    <VisibilityRow
                      label="Location Sharing"
                      description="When your location is shared with others"
                      value={privacySettings.locationSharing}
                      options={[
                        { value: "always", label: "Always" },
                        { value: "events", label: "During Events Only" },
                        { value: "never", label: "Never" },
                      ]}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, locationSharing: v as PrivacySettings["locationSharing"] }))}
                    />
                  </AccordionContent>
                </AccordionItem>

                {/* Transaction Visibility */}
                <AccordionItem value="transactions">
                  <AccordionTrigger className="text-base font-semibold">
                    <div className="flex items-center gap-2">
                      <Wallet className="h-4 w-4 text-teal-500" />
                      Transaction Visibility
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <VisibilityScopeRow
                      label="Who can see my purchases?"
                      description="Visibility of items and services you have purchased"
                      value={privacySettings.transactionPurchases}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, transactionPurchases: v }))}
                    />
                    <Separator />
                    <VisibilityScopeRow
                      label="Who can see my sales?"
                      description="Visibility of items and services you have sold"
                      value={privacySettings.transactionSales}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, transactionSales: v }))}
                    />
                    <Separator />
                    <VisibilityScopeRow
                      label="Who can see gifts I receive?"
                      description="Visibility of gifts and thanks tokens you have received"
                      value={privacySettings.transactionGiftsReceived}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, transactionGiftsReceived: v }))}
                    />
                    <Separator />
                    <VisibilityScopeRow
                      label="Who can see my transfers?"
                      description="Visibility of wallet-to-wallet transfers"
                      value={privacySettings.transactionTransfers}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, transactionTransfers: v }))}
                    />
                    <Separator />
                    <VisibilityRow
                      label="Who can see my wallet balance?"
                      description="Your wallet balance is sensitive financial information"
                      value={privacySettings.transactionWalletBalance}
                      options={[
                        { value: "self", label: "Only Me" },
                        { value: "connections", label: "Connections" },
                      ]}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, transactionWalletBalance: v as "self" | "connections" }))}
                    />
                  </AccordionContent>
                </AccordionItem>

                {/* Activity Visibility */}
                <AccordionItem value="activity">
                  <AccordionTrigger className="text-base font-semibold">
                    <div className="flex items-center gap-2">
                      <Activity className="h-4 w-4 text-teal-500" />
                      Activity Visibility
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <VisibilityScopeRow
                      label="Who can see my group memberships?"
                      description="Visibility of groups, rings, and families you belong to"
                      value={privacySettings.activityGroupMemberships}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, activityGroupMemberships: v }))}
                    />
                    <Separator />
                    <VisibilityScopeRow
                      label="Who can see my event attendance?"
                      description="Visibility of events you are attending or have attended"
                      value={privacySettings.activityEventAttendance}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, activityEventAttendance: v }))}
                    />
                    <Separator />
                    <VisibilityScopeRow
                      label="Who can see my posts?"
                      description="Visibility of posts and content you create"
                      value={privacySettings.activityPosts}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, activityPosts: v }))}
                    />
                    <Separator />
                    <VisibilityScopeRow
                      label="Who can see my offerings?"
                      description="Visibility of marketplace offerings you have listed"
                      value={privacySettings.activityOfferings}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, activityOfferings: v }))}
                    />
                    <Separator />
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">Who can see my job applications?</p>
                        <p className="text-xs text-muted-foreground">Job applications are always private</p>
                      </div>
                      <Badge variant="secondary" className="text-xs">Only Me</Badge>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Profile Attribute Visibility */}
                <AccordionItem value="attributes">
                  <AccordionTrigger className="text-base font-semibold">
                    <div className="flex items-center gap-2">
                      <UserCheck className="h-4 w-4 text-teal-500" />
                      Profile Attribute Visibility
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <VisibilityScopeRow
                      label="Who can see my full name?"
                      description="Your display name on your profile"
                      value={privacySettings.attributeFullName}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, attributeFullName: v }))}
                    />
                    <Separator />
                    <VisibilityRow
                      label="Who can see my email?"
                      description="Your email address is restricted for safety"
                      value={privacySettings.attributeEmail}
                      options={[
                        { value: "connections", label: "Connections" },
                        { value: "self", label: "Only Me" },
                      ]}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, attributeEmail: v as "connections" | "self" }))}
                    />
                    <Separator />
                    <VisibilityScopeRow
                      label="Who can see my location?"
                      description="Your home locale and geographic information"
                      value={privacySettings.attributeLocation}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, attributeLocation: v }))}
                    />
                    <Separator />
                    <VisibilityScopeRow
                      label="Who can see my skills?"
                      description="Skills listed on your profile"
                      value={privacySettings.attributeSkills}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, attributeSkills: v }))}
                    />
                    <Separator />
                    <VisibilityScopeRow
                      label="Who can see my bio?"
                      description="Your profile bio and tagline"
                      value={privacySettings.attributeBio}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, attributeBio: v }))}
                    />
                    <Separator />
                    <VisibilityScopeRow
                      label="Who can see my social links?"
                      description="External social media and website links"
                      value={privacySettings.attributeSocialLinks}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, attributeSocialLinks: v }))}
                    />
                    <Separator />
                    <VisibilityScopeRow
                      label="Who can see my avatar?"
                      description="Your profile photo"
                      value={privacySettings.attributeAvatar}
                      onChange={(v) => setPrivacySettings((p) => ({ ...p, attributeAvatar: v }))}
                    />
                  </AccordionContent>
                </AccordionItem>

                {/* ZK Identity Settings */}
                <AccordionItem value="zk-identity">
                  <AccordionTrigger className="text-base font-semibold">
                    <div className="flex items-center gap-2">
                      <Fingerprint className="h-4 w-4 text-teal-500" />
                      ZK Identity Settings
                      <Badge variant="outline" className="text-xs ml-2">Preview</Badge>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-6 pt-2">
                    <div className="rounded-lg border border-dashed border-teal-500/30 bg-teal-500/5 p-4">
                      <p className="text-sm text-muted-foreground">
                        Zero-knowledge proofs allow you to verify attributes about yourself without revealing exact values.
                        This feature is in preview and the cryptographic implementation is coming soon.
                      </p>
                    </div>

                    {/* Enable ZK toggle */}
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">Enable ZK-verified profile</p>
                        <p className="text-xs text-muted-foreground">
                          Allow others to see verified attributes via zero-knowledge proofs
                        </p>
                      </div>
                      <Switch
                        checked={privacySettings.zkEnabled}
                        onCheckedChange={(checked) =>
                          setPrivacySettings((p) => ({ ...p, zkEnabled: checked }))
                        }
                      />
                    </div>

                    {privacySettings.zkEnabled && (
                      <>
                        <Separator />

                        {/* Attributes to expose */}
                        <div className="space-y-3">
                          <p className="text-sm font-medium">Attributes to expose via ZK proof</p>
                          <p className="text-xs text-muted-foreground">
                            Select which attributes can be verified without revealing exact values
                          </p>
                          <div className="grid grid-cols-2 gap-3">
                            {ZK_ATTRIBUTE_OPTIONS.map((attr) => (
                              <div key={attr.value} className="flex items-center space-x-2">
                                <Checkbox
                                  id={`zk-attr-${attr.value}`}
                                  checked={privacySettings.zkExposedAttributes.includes(attr.value)}
                                  onCheckedChange={(checked) => {
                                    setPrivacySettings((p) => ({
                                      ...p,
                                      zkExposedAttributes: checked
                                        ? [...p.zkExposedAttributes, attr.value]
                                        : p.zkExposedAttributes.filter((a) => a !== attr.value),
                                    }));
                                  }}
                                />
                                <Label htmlFor={`zk-attr-${attr.value}`} className="text-sm cursor-pointer">
                                  {attr.label}
                                </Label>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="rounded-lg bg-muted/50 p-3">
                          <p className="text-xs text-muted-foreground italic">
                            Anyone matching these criteria can see your ZK profile and message you.
                            ZK identities cannot post, comment, or list in scopes where identity is hidden.
                          </p>
                        </div>

                        <Separator />

                        {/* Conditional access rules */}
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-medium">Conditional Access Rules</p>
                              <p className="text-xs text-muted-foreground">
                                Define conditions that others must meet to access your ZK profile
                              </p>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                const newRule: ZkConditionalRule = {
                                  id: crypto.randomUUID(),
                                  attribute: "age",
                                  operator: "greater_than",
                                  value: "",
                                };
                                setPrivacySettings((p) => ({
                                  ...p,
                                  zkConditionalRules: [...p.zkConditionalRules, newRule],
                                }));
                              }}
                            >
                              <Plus className="h-3 w-3 mr-1" />
                              Add Condition
                            </Button>
                          </div>

                          {privacySettings.zkConditionalRules.length === 0 && (
                            <div className="rounded-lg border border-dashed p-4 text-center">
                              <p className="text-sm text-muted-foreground">
                                No conditional rules set. Anyone with matching ZK criteria can access your profile.
                              </p>
                            </div>
                          )}

                          {privacySettings.zkConditionalRules.map((rule) => (
                            <div key={rule.id} className="flex items-center gap-2 p-3 rounded-lg border bg-card">
                              <Select
                                value={rule.attribute}
                                onValueChange={(v) => {
                                  setPrivacySettings((p) => ({
                                    ...p,
                                    zkConditionalRules: p.zkConditionalRules.map((r) =>
                                      r.id === rule.id ? { ...r, attribute: v } : r
                                    ),
                                  }));
                                }}
                              >
                                <SelectTrigger className="w-[140px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {ZK_RULE_ATTRIBUTE_OPTIONS.map((opt) => (
                                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>

                              <Select
                                value={rule.operator}
                                onValueChange={(v) => {
                                  setPrivacySettings((p) => ({
                                    ...p,
                                    zkConditionalRules: p.zkConditionalRules.map((r) =>
                                      r.id === rule.id ? { ...r, operator: v as ZkConditionalRule["operator"] } : r
                                    ),
                                  }));
                                }}
                              >
                                <SelectTrigger className="w-[140px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {ZK_OPERATOR_OPTIONS.map((opt) => (
                                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>

                              <input
                                type="text"
                                className="flex-1 p-2 border rounded-md text-sm bg-background"
                                placeholder="Value..."
                                value={rule.value}
                                onChange={(e) => {
                                  setPrivacySettings((p) => ({
                                    ...p,
                                    zkConditionalRules: p.zkConditionalRules.map((r) =>
                                      r.id === rule.id ? { ...r, value: e.target.value } : r
                                    ),
                                  }));
                                }}
                              />

                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive/80"
                                onClick={() => {
                                  setPrivacySettings((p) => ({
                                    ...p,
                                    zkConditionalRules: p.zkConditionalRules.filter((r) => r.id !== rule.id),
                                  }));
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </AccordionContent>
                </AccordionItem>

                {/* Universal Manifest */}
                <AccordionItem value="manifest">
                  <AccordionTrigger className="text-base font-semibold">
                    <div className="flex items-center gap-2">
                      <Upload className="h-4 w-4 text-teal-500" />
                      Universal Manifest
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <div className="rounded-lg border border-dashed border-teal-500/30 bg-teal-500/5 p-4">
                      <p className="text-sm text-muted-foreground">
                        Push your privacy settings to the PeerMesh universal manifest so they are enforced across
                        federated nodes. This syncs your visibility preferences to your portable identity.
                      </p>
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">Last synced</p>
                        <p className="text-xs text-muted-foreground">
                          {privacySettings.manifestLastSynced
                            ? new Date(privacySettings.manifestLastSynced).toLocaleString()
                            : "Never synced"}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPrivacySettings((p) => ({
                            ...p,
                            manifestLastSynced: new Date().toISOString(),
                          }));
                          toast({
                            title: "Manifest sync queued",
                            description: "Your privacy settings will be pushed to PeerMesh on save.",
                          });
                        }}
                      >
                        <Upload className="h-3 w-3 mr-1" />
                        Push to PeerMesh
                      </Button>
                    </div>

                    <Separator />

                    {/* Manifest preview */}
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Manifest Export Preview</p>
                      <pre className="text-xs bg-muted/50 p-3 rounded-lg overflow-auto max-h-48 font-mono">
                        {JSON.stringify(
                          {
                            version: "1.0",
                            privacy: {
                              transactions: {
                                purchases: privacySettings.transactionPurchases,
                                sales: privacySettings.transactionSales,
                                gifts: privacySettings.transactionGiftsReceived,
                                transfers: privacySettings.transactionTransfers,
                                walletBalance: privacySettings.transactionWalletBalance,
                              },
                              activity: {
                                groupMemberships: privacySettings.activityGroupMemberships,
                                eventAttendance: privacySettings.activityEventAttendance,
                                posts: privacySettings.activityPosts,
                                offerings: privacySettings.activityOfferings,
                              },
                              attributes: {
                                fullName: privacySettings.attributeFullName,
                                email: privacySettings.attributeEmail,
                                location: privacySettings.attributeLocation,
                                skills: privacySettings.attributeSkills,
                                bio: privacySettings.attributeBio,
                                socialLinks: privacySettings.attributeSocialLinks,
                                avatar: privacySettings.attributeAvatar,
                              },
                              zk: {
                                enabled: privacySettings.zkEnabled,
                                exposedAttributes: privacySettings.zkExposedAttributes,
                                conditionalRules: privacySettings.zkConditionalRules.length,
                              },
                            },
                            lastSynced: privacySettings.manifestLastSynced,
                          },
                          null,
                          2
                        )}
                      </pre>
                    </div>
                  </AccordionContent>
                </AccordionItem>

              </Accordion>
            </CardContent>
          </Card>

          <Button className="w-full" onClick={onSaveChanges} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Privacy Settings"}
          </Button>
        </TabsContent>

        <TabsContent value="notifications" className="space-y-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Push Notifications</p>
                <p className="text-sm text-muted-foreground">Receive notifications on your device</p>
              </div>
              <Switch
                checked={notificationSettings.pushNotifications}
                onCheckedChange={(value) =>
                  setNotificationSettings((prev) => ({ ...prev, pushNotifications: value }))
                }
              />
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Email Notifications</p>
                <p className="text-sm text-muted-foreground">Receive notifications via email</p>
              </div>
              <Switch
                checked={notificationSettings.emailNotifications}
                onCheckedChange={(value) =>
                  setNotificationSettings((prev) => ({ ...prev, emailNotifications: value }))
                }
              />
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Event Reminders</p>
                <p className="text-sm text-muted-foreground">Get reminded about upcoming events</p>
              </div>
              <Switch
                checked={notificationSettings.eventReminders}
                onCheckedChange={(value) =>
                  setNotificationSettings((prev) => ({ ...prev, eventReminders: value }))
                }
              />
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">New Messages</p>
                <p className="text-sm text-muted-foreground">Get notified when you receive new messages</p>
              </div>
              <Switch
                checked={notificationSettings.newMessages}
                onCheckedChange={(value) =>
                  setNotificationSettings((prev) => ({ ...prev, newMessages: value }))
                }
              />
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Publish to Murmurations</p>
                <p className="text-sm text-muted-foreground">
                  Publish your eligible public profile, groups, projects, and marketplace offers to the Murmurations network.
                </p>
              </div>
              <Switch
                checked={notificationSettings.murmurationsPublishing}
                onCheckedChange={(value) =>
                  setNotificationSettings((prev) => ({ ...prev, murmurationsPublishing: value }))
                }
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="appearance" className="space-y-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {appearanceSettings.darkMode ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
                <div>
                  <p className="font-medium">Dark Mode</p>
                  <p className="text-sm text-muted-foreground">Toggle between light and dark mode</p>
                </div>
              </div>
              <Switch
                checked={appearanceSettings.darkMode}
                onCheckedChange={(value) => {
                  setAppearanceSettings((prev) => ({ ...prev, darkMode: value }));
                  setTheme(value ? "dark" : "light");
                }}
              />
            </div>

            <Separator />

            <div>
              <p className="font-medium mb-2">Text Size</p>
              <div className="flex items-center gap-4">
                <span className="text-sm">A</span>
                <input
                  type="range"
                  min="1"
                  max="5"
                  value={appearanceSettings.textSize}
                  onChange={(e) =>
                    setAppearanceSettings((prev) => ({
                      ...prev,
                      textSize: Number(e.target.value),
                    }))
                  }
                  className="flex-1"
                />
                <span className="text-lg">A</span>
              </div>
            </div>

            <Separator />

            <div>
              <p className="font-medium mb-2">Color Theme</p>
              <div className="grid grid-cols-5 gap-2">
                <button
                  type="button"
                  aria-label="Primary color theme"
                  className={`h-10 w-10 rounded-full bg-primary cursor-pointer ${
                    appearanceSettings.colorTheme === "primary" ? "ring-2 ring-offset-2 ring-primary" : ""
                  }`}
                  onClick={() =>
                    setAppearanceSettings((prev) => ({ ...prev, colorTheme: "primary" }))
                  }
                />
                <button
                  type="button"
                  aria-label="Blue color theme"
                  className={`h-10 w-10 rounded-full bg-blue-500 cursor-pointer ${
                    appearanceSettings.colorTheme === "blue" ? "ring-2 ring-offset-2 ring-blue-500" : ""
                  }`}
                  onClick={() => setAppearanceSettings((prev) => ({ ...prev, colorTheme: "blue" }))}
                />
                <button
                  type="button"
                  aria-label="Green color theme"
                  className={`h-10 w-10 rounded-full bg-green-500 cursor-pointer ${
                    appearanceSettings.colorTheme === "green" ? "ring-2 ring-offset-2 ring-green-500" : ""
                  }`}
                  onClick={() =>
                    setAppearanceSettings((prev) => ({ ...prev, colorTheme: "green" }))
                  }
                />
                <button
                  type="button"
                  aria-label="Purple color theme"
                  className={`h-10 w-10 rounded-full bg-purple-500 cursor-pointer ${
                    appearanceSettings.colorTheme === "purple" ? "ring-2 ring-offset-2 ring-purple-500" : ""
                  }`}
                  onClick={() =>
                    setAppearanceSettings((prev) => ({ ...prev, colorTheme: "purple" }))
                  }
                />
                <button
                  type="button"
                  aria-label="Pink color theme"
                  className={`h-10 w-10 rounded-full bg-pink-500 cursor-pointer ${
                    appearanceSettings.colorTheme === "pink" ? "ring-2 ring-offset-2 ring-pink-500" : ""
                  }`}
                  onClick={() => setAppearanceSettings((prev) => ({ ...prev, colorTheme: "pink" }))}
                />
              </div>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="seller" className="space-y-4">
          <SellerAccountSection />
        </TabsContent>

        <TabsContent value="federation" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe className="h-5 w-5" />
                Federation
              </CardTitle>
              <CardDescription>
                Manage whether this account can export content to trusted peer nodes from this deployment.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {federationSettings.status === "loading" ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking federation status…
                </div>
              ) : federationSettings.status === "ready" ? (
                <>
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant={federationSettings.node.enabled ? "secondary" : "outline"}>
                      {federationSettings.node.enabled ? "Node Active" : "Node Not Enabled"}
                    </Badge>
                    <span className="text-muted-foreground">
                      {federationSettings.node.enabled ? (
                        <>
                          Hosted node <span className="font-medium text-foreground">{federationSettings.node.slug}</span>
                        </>
                      ) : (
                        "This account does not currently own the hosted Rivr federation node."
                      )}
                    </span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-lg border p-3">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Trusted Peers</p>
                      <p className="text-2xl font-semibold">{federationSettings.node.trustedPeers ?? 0}</p>
                    </div>
                    <div className="rounded-lg border p-3">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Queued Events</p>
                      <p className="text-2xl font-semibold">{federationSettings.node.queuedEvents ?? 0}</p>
                    </div>
                    <div className="rounded-lg border p-3">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Exported Events</p>
                      <p className="text-2xl font-semibold">{federationSettings.node.exportedEvents ?? 0}</p>
                    </div>
                  </div>
                  {federationSettings.node.baseUrl ? (
                    <div className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">Base URL</p>
                      <p className="mt-1 break-all text-muted-foreground">{federationSettings.node.baseUrl}</p>
                    </div>
                  ) : null}

                  <div className="grid gap-4 lg:grid-cols-2">
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">PeerMesh Spatial</CardTitle>
                        <CardDescription>
                          Link your Spatial / Universal Manifest identity to this Rivr profile.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {federationSettings.peermesh.linked ? (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2 text-sm">
                              <Badge variant="secondary">Linked</Badge>
                              <span className="font-medium">{federationSettings.peermesh.handle ?? "PeerMesh identity"}</span>
                            </div>
                            {federationSettings.peermesh.did ? (
                              <p className="text-xs break-all text-muted-foreground">{federationSettings.peermesh.did}</p>
                            ) : null}
                            {federationSettings.peermesh.manifestUrl ? (
                              <a
                                href={federationSettings.peermesh.manifestUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                              >
                                View manifest
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                            <Button
                              variant="outline"
                              onClick={handleUnlinkPeermesh}
                              disabled={federationSaving !== null}
                            >
                              {federationSaving === "peermesh" ? "Unlinking..." : "Unlink PeerMesh"}
                            </Button>
                          </div>
                        ) : (
                          <>
                            <Textarea
                              value={peermeshInput}
                              onChange={(e) => setPeermeshInput(e.target.value)}
                              placeholder="Paste your PeerMesh export JSON or a https://spatial.peermesh.org manifest URL"
                              className="min-h-32"
                            />
                            <div className="flex items-center justify-between gap-3">
                              <a
                                href="https://spatial.peermesh.org/signin"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                              >
                                Open Spatial
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                              <Button
                                onClick={handleLinkPeermesh}
                                disabled={federationSaving !== null || peermeshInput.trim().length === 0}
                              >
                                {federationSaving === "peermesh" ? "Linking..." : "Link PeerMesh"}
                              </Button>
                            </div>
                          </>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">Bluesky / AT Protocol</CardTitle>
                        <CardDescription>
                          Link your Bluesky identity using an app password. The password is used once and never stored.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {federationSettings.atproto.linked ? (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2 text-sm">
                              <Badge variant="secondary">Linked</Badge>
                              <span className="font-medium">{federationSettings.atproto.handle ?? "AT Protocol identity"}</span>
                            </div>
                            {federationSettings.atproto.did ? (
                              <p className="text-xs break-all text-muted-foreground">{federationSettings.atproto.did}</p>
                            ) : null}
                            {federationSettings.atproto.handle ? (
                              <a
                                href={`https://bsky.app/profile/${federationSettings.atproto.handle}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                              >
                                View profile
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                            <Button
                              variant="outline"
                              onClick={handleUnlinkAtproto}
                              disabled={federationSaving !== null}
                            >
                              {federationSaving === "atproto" ? "Unlinking..." : "Unlink Bluesky"}
                            </Button>
                          </div>
                        ) : (
                          <>
                            <div className="grid gap-2">
                              <label className="text-sm font-medium">Handle</label>
                              <input
                                type="text"
                                className="p-2 border rounded-md bg-background text-foreground"
                                value={blueskyHandle}
                                onChange={(e) => setBlueskyHandle(e.target.value)}
                                placeholder="you.bsky.social"
                              />
                            </div>
                            <div className="grid gap-2">
                              <label className="text-sm font-medium">App Password</label>
                              <input
                                type="password"
                                className="p-2 border rounded-md bg-background text-foreground"
                                value={blueskyAppPassword}
                                onChange={(e) => setBlueskyAppPassword(e.target.value)}
                                placeholder="xxxx-xxxx-xxxx-xxxx"
                              />
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <a
                                href="https://bsky.app/settings/app-passwords"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                              >
                                Create app password
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                              <Button
                                onClick={handleLinkAtproto}
                                disabled={
                                  federationSaving !== null ||
                                  blueskyHandle.trim().length === 0 ||
                                  blueskyAppPassword.trim().length === 0
                                }
                              >
                                {federationSaving === "atproto" ? "Linking..." : "Link Bluesky"}
                              </Button>
                            </div>
                          </>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </>
              ) : (
                <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                  {federationSettings.error ?? "Unable to load federation settings right now."}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SellerAccountSection() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [setupLoading, setSetupLoading] = useState(false);
  const [status, setStatus] = useState<{
    hasAccount: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    dashboardUrl?: string;
  } | null>(null);
  const [balance, setBalance] = useState<{ availableCents: number; pendingCents: number } | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const [result, balanceResult] = await Promise.all([
        getConnectStatusAction(),
        getConnectBalanceAction(),
      ]);
      if (result.success && result.status) {
        setStatus({
          hasAccount: result.status.hasAccount,
          chargesEnabled: result.status.chargesEnabled,
          payoutsEnabled: result.status.payoutsEnabled,
          detailsSubmitted: result.status.detailsSubmitted,
          dashboardUrl: result.status.dashboardUrl,
        });
      } else {
        setStatus({ hasAccount: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false });
      }
      if (balanceResult.success && balanceResult.balance) {
        setBalance(balanceResult.balance);
      } else {
        setBalance({ availableCents: 0, pendingCents: 0 });
      }
    } catch {
      setStatus({ hasAccount: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false });
      setBalance({ availableCents: 0, pendingCents: 0 });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  async function handleSetup() {
    setSetupLoading(true);
    try {
      const result = await setupConnectAccountAction();
      if (result.success && result.url) {
        window.location.href = result.url;
      } else {
        toast({
          title: "Setup failed",
          description: result.error ?? "Could not create seller account. Please try again.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Setup failed",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setSetupLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!status?.hasAccount || !status.detailsSubmitted) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Store className="h-6 w-6 text-muted-foreground" />
            <div>
              <CardTitle>Stripe USD Wallet</CardTitle>
              <CardDescription>
                {status?.hasAccount
                  ? "Complete Stripe onboarding to activate your Stripe USD wallet and receive card sales."
                  : "Set up your Stripe USD wallet to receive card payments for offerings and request payouts."}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status?.hasAccount && (
            <div className="space-y-2">
              <StatusRow label="Details submitted" done={status.detailsSubmitted} />
              <StatusRow label="Charges enabled" done={status.chargesEnabled} />
              <StatusRow label="Payouts enabled" done={status.payoutsEnabled} />
            </div>
          )}
          <Button onClick={handleSetup} disabled={setupLoading} className="w-full">
            {setupLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Setting up...
              </>
            ) : status?.hasAccount ? (
              "Complete Setup"
            ) : (
              "Set Up Stripe USD Wallet"
            )}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const isFullyActive = status.chargesEnabled && status.payoutsEnabled;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Store className="h-6 w-6 text-muted-foreground" />
            <div>
              <CardTitle>Stripe USD Wallet</CardTitle>
              <CardDescription>Manage card sales, payout readiness, and Stripe dashboard access.</CardDescription>
            </div>
          </div>
          <Badge variant={isFullyActive ? "default" : "secondary"}>
            {isFullyActive ? "Active" : "Limited"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <StatusRow label="Details submitted" done={status.detailsSubmitted} />
          <StatusRow label="Charges enabled" done={status.chargesEnabled} />
          <StatusRow label="Payouts enabled" done={status.payoutsEnabled} />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground">Available Stripe balance</p>
              <p className="text-2xl font-semibold">
                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((balance?.availableCents ?? 0) / 100)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground">Pending Stripe balance</p>
              <p className="text-2xl font-semibold">
                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((balance?.pendingCents ?? 0) / 100)}
              </p>
            </CardContent>
          </Card>
        </div>

        <Separator />

        {status.dashboardUrl && (
          <Button variant="outline" className="w-full" asChild>
            <a href={status.dashboardUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4 mr-2" />
              Open Stripe Dashboard
            </a>
          </Button>
        )}

        {!isFullyActive && (
          <Button onClick={handleSetup} disabled={setupLoading} variant="secondary" className="w-full">
            {setupLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Loading...
              </>
            ) : (
              "Complete Account Setup"
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function StatusRow({ label, done }: { label: string; done: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {done ? (
        <CheckCircle2 className="h-4 w-4 text-green-600" />
      ) : (
        <AlertCircle className="h-4 w-4 text-amber-500" />
      )}
      <span className={done ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </div>
  );
}
