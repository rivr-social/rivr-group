"use client";

/**
 * Group settings page for `/groups/[id]/settings`.
 *
 * Purpose:
 * - Provides admin-facing controls for membership plans and join settings.
 * - Allows editing and persisting group subscription plans and onboarding requirements.
 *
 * Data requirements:
 * - Client-triggered admin settings fetch (`fetchGroupAdminSettings`) scoped to the group ID.
 * - Client-triggered mutations for join settings and membership plans.
 *
 * Rendering notes:
 * - This is a Client Component (`"use client"`), rendered and hydrated in the browser.
 * - Admin/access checks are enforced by server actions; UI displays an access-denied state on failure.
 * - No `metadata` export is defined in this file.
 */
import { use, useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Bot, Camera, Drama, ExternalLink, Loader2, Pencil, Plus, Rocket, Trash2, UserPlus, CreditCard, MessageSquare, Globe, Mail, Crown, Plug, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { LocationAutocompleteInput, type LocationSuggestion } from "@/components/location-autocomplete-input";
import { TagEditor } from "@/components/tag-editor";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResponsiveTabsList } from "@/components/responsive-tabs-list";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { JoinType, type GroupJoinSettings, type TabVisibilitySettings } from "@/lib/types";
import { GroupAdminPassword } from "@/components/group-admin-password";
import { GroupBroadcastCard } from "@/components/group-broadcast-card";
import { GroupJoinRequestsCard } from "@/components/group-join-requests-card";
import { JoinQuestionEditor } from "@/components/join-question-editor";
import {
  fetchGroupAdminSettings,
  updateGroupJoinSettings,
  updateGroupMembershipPlans,
  updateGroupTabVisibility,
} from "@/app/actions/group-admin";
import { GROUP_SETTINGS_ERROR_CODES } from "@/app/actions/group-admin-types";
import { TabVisibilityEditor } from "@/components/tab-visibility-editor";
import { updateGroupResource } from "@/app/actions/create-resources";
import { type GroupMembershipPlan } from "@/lib/group-memberships";
import { useToast } from "@/components/ui/use-toast";
import { getGroupMatrixRoom, setGroupChatMode } from "@/lib/matrix-groups";
import type { ChatMode } from "@/db/schema";
import { tierHasCapability } from "@/lib/entitlements";
import { getSubscriptionStatusAction } from "@/app/actions/billing";
import { SubscriptionGateDialog } from "@/components/subscription-gate-dialog";
import { GroupAdminView } from "@/components/group-admin-view";
import { GroupType as LegacyGroupType } from "@/lib/types";
import type { Group as LegacyGroup } from "@/lib/types";
import { ConnectionsForm, type GroupGoogleConnectionSummary } from "./connections/connections-form";
import { fetchGroupGoogleConnectionAction } from "./connections/actions";
import { ConnectorsSettingsPanel } from "@/components/connectors-settings-panel";
import { GroupAssistantConfigCard } from "@/components/group-assistant-config-card";
import { GroupAssistantChat } from "@/components/group-assistant-chat";
import { GroupPersonaManager } from "@/components/group-persona-manager";

/** Stable tab identifiers used in the `?tab=` query param. */
const TAB_VALUES = {
  PROFILE: "profile",
  MEMBERSHIPS: "memberships",
  JOIN: "join",
  REQUESTS: "requests",
  TAB_VISIBILITY: "tab-visibility",
  CHAT: "chat",
  ASSISTANT: "assistant",
  PERSONAS: "personas",
  SITE: "site",
  ANNOUNCEMENTS: "announcements",
  CONNECTIONS: "connections",
  MAP_MARKER: "map-marker",
  ADMIN_OVERVIEW: "admin-overview",
} as const;
type TabValue = (typeof TAB_VALUES)[keyof typeof TAB_VALUES];

const ALL_TABS = new Set<TabValue>(Object.values(TAB_VALUES));

const RESUME_ORG_UPGRADE_PARAM = "resumeOrgUpgrade";

type EditableMembershipPlan = GroupMembershipPlan;

/**
 * Starter shape for newly created membership plans.
 */
const EMPTY_PLAN: EditableMembershipPlan = {
  id: "",
  name: "",
  description: "",
  amountMonthlyCents: null,
  amountYearlyCents: null,
  active: true,
  perks: [],
  isDefault: false,
};

/**
 * Converts a cents value to a two-decimal USD string for form inputs.
 *
 * @param value - Monetary amount in cents.
 * @returns Decimal dollar text (e.g. `"12.00"`), or empty string when unavailable.
 */
function formatDollarsFromCents(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  return (value / 100).toFixed(2);
}

/**
 * Parses a user-entered dollar amount into integer cents.
 *
 * @param value - Raw input string from the pricing field.
 * @returns Cents value clamped to zero or greater, or `null` if input is empty/invalid.
 */
function parseDollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round(parsed * 100));
}

/** Maximum commission percentage allowed for mart sales. */
const MAX_COMMISSION_PERCENT = 50;

/**
 * Sanitizes a raw price-field keystroke: keeps digits and a single decimal
 * point so the value can be typed freely (e.g. `"12."`, `"12.5"`) without being
 * reformatted on every keystroke (B1). Parsing to cents happens on blur/save.
 *
 * @param raw - The raw input string from the price field.
 * @returns A string containing only digits and at most one `.`.
 */
function sanitizePriceInput(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot === -1) return cleaned;
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
}

/** Clamps a percentage to the supported `0..MAX_COMMISSION_PERCENT` range. */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_COMMISSION_PERCENT, value));
}

/**
 * Client-rendered group settings page.
 *
 * @param props - Promise-based dynamic route params supplied by the App Router.
 * @returns Admin settings UI for memberships and join controls.
 */
export default function GroupSettingsPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const groupId = params.id;

  const [loading, setLoading] = useState(true);
  const [savingJoin, setSavingJoin] = useState(false);
  const [savingMemberships, setSavingMemberships] = useState(false);
  const [groupName, setGroupName] = useState("Group");
  const [groupType, setGroupType] = useState("basic");
  const [error, setError] = useState<string | null>(null);
  // True when the viewer is not a group admin (or not signed in). Drives a
  // clean redirect to the group page rather than an access-denied card.
  const [forbidden, setForbidden] = useState(false);

  const [joinSettings, setJoinSettings] = useState<GroupJoinSettings>({
    joinType: JoinType.Public,
    questions: [],
    approvalRequired: false,
  });

  const [membershipPlans, setMembershipPlans] = useState<EditableMembershipPlan[]>([]);
  const [tabVisibility, setTabVisibility] = useState<TabVisibilitySettings>({});
  const [savingTabVisibility, setSavingTabVisibility] = useState(false);
  const [connection, setConnection] = useState<GroupGoogleConnectionSummary | null>(null);
  const [chatMode, setChatMode] = useState<ChatMode>("both");
  const [hasMatrixRoom, setHasMatrixRoom] = useState(false);
  const [savingChatMode, setSavingChatMode] = useState(false);
  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [hasGroupPassword, setHasGroupPassword] = useState(false);
  const [uploadingModel, setUploadingModel] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [showMembershipGate, setShowMembershipGate] = useState(false);
  const [upgradePending, setUpgradePending] = useState(false);

  // ── Profile tab (A4): folds the former Edit-Profile modal into settings ──
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [description, setDescription] = useState("");
  const [profileLocationText, setProfileLocationText] = useState("");
  const [profileLocationData, setProfileLocationData] = useState<LocationSuggestion | null>(null);
  const [profileTags, setProfileTags] = useState<string[]>([]);
  const [coverImage, setCoverImage] = useState("");
  const [coverPreview, setCoverPreview] = useState("");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [commissionPercent, setCommissionPercent] = useState(0);
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);

  // ── Map-marker location (A5): place search + manual lat/lng ──
  const [markerLat, setMarkerLat] = useState("");
  const [markerLng, setMarkerLng] = useState("");
  const [markerLocationText, setMarkerLocationText] = useState("");
  const [markerLocationData, setMarkerLocationData] = useState<LocationSuggestion | null>(null);
  const [savingMapMarker, setSavingMapMarker] = useState(false);

  // ── Membership price drafts (B1): raw per-field strings so the input is not
  //    reformatted on every keystroke; parsed to cents on blur + on save. ──
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});

  const isOrganization = groupType === "organization";

  useEffect(() => {
    let cancelled = false;

    /**
     * Loads current admin settings for the target group.
     *
     * On access failure, this sets an error state that renders an access-denied card.
     */
    async function loadSettings() {
      setLoading(true);
      const result = await fetchGroupAdminSettings(groupId);

      if (cancelled) return;

      if (!result.success || !result.group) {
        // Non-admins (and unauthenticated viewers) are redirected to the group
        // page — config surfaces are admin-only and must not render at all.
        if (
          result.code === GROUP_SETTINGS_ERROR_CODES.FORBIDDEN ||
          result.code === GROUP_SETTINGS_ERROR_CODES.UNAUTHENTICATED
        ) {
          setForbidden(true);
          setLoading(false);
          router.replace(`/groups/${groupId}`);
          return;
        }
        setError(result.error ?? "Unable to load group settings.");
        setLoading(false);
        return;
      }

      setGroupName(result.group.name);
      setGroupType(result.group.groupType === "org" ? "organization" : result.group.groupType);
      setJoinSettings(result.group.joinSettings);

      // Hydrate the Profile tab (A4) from the loaded settings.
      setDescription(result.group.description);
      setProfileLocationText(result.group.location);
      setProfileTags(result.group.tags);
      setCoverImage(result.group.coverImage);
      setCoverPreview(result.group.coverImage);
      setCommissionPercent(Math.round(result.group.commissionBps / 100));

      // Hydrate the map-marker location (A5) from the structured location.
      setMarkerLocationText(result.group.location);
      setMarkerLat(
        result.group.locationData?.lat !== undefined ? String(result.group.locationData.lat) : "",
      );
      setMarkerLng(
        result.group.locationData?.lng !== undefined ? String(result.group.locationData.lng) : "",
      );

      // Ensure the form always has at least one editable plan entry.
      const loadedPlans: EditableMembershipPlan[] =
        result.group.membershipPlans.length > 0
          ? result.group.membershipPlans
          : [
              {
                id: "basic-member",
                name: "Basic Member",
                description: "Core access to group updates and participation.",
                amountMonthlyCents: 0,
                amountYearlyCents: 0,
                active: true,
                perks: [],
                isDefault: true,
              },
            ];
      setMembershipPlans(loadedPlans);

      // Seed per-field price drafts from the loaded plans (B1).
      const drafts: Record<string, string> = {};
      for (const plan of loadedPlans) {
        drafts[`${plan.id}:monthly`] = formatDollarsFromCents(plan.amountMonthlyCents);
        drafts[`${plan.id}:yearly`] = formatDollarsFromCents(plan.amountYearlyCents);
      }
      setPriceDrafts(drafts);

      setTabVisibility(result.group.tabVisibility ?? {});
      setModelUrl(result.group.modelUrl ?? null);
      setHasGroupPassword(result.group.hasPassword);

      // Load Matrix room config for chat mode
      try {
        const matrixRoom = await getGroupMatrixRoom(groupId);
        if (matrixRoom) {
          setHasMatrixRoom(true);
          setChatMode(matrixRoom.chatMode);
        }
      } catch {
        // Matrix room lookup is non-critical
      }

      // Load Google Workspace connection summary for the Connections tab.
      // Falls through silently when not admin or no row exists; the form
      // renders its own zero-state in that case.
      try {
        const connResult = await fetchGroupGoogleConnectionAction(groupId);
        if (!cancelled && connResult.success) {
          setConnection(connResult.connection);
        }
      } catch {
        // Connection lookup is non-critical for the rest of the page.
      }

      setError(null);
      setLoading(false);
    }

    loadSettings();

    return () => {
      cancelled = true;
    };
  }, [groupId, router]);

  /**
   * Persists join settings through the group-admin server action.
   */
  const onSaveJoinSettings = async () => {
    setSavingJoin(true);
    const result = await updateGroupJoinSettings(groupId, joinSettings);
    setSavingJoin(false);

    if (!result.success) {
      toast({ title: "Could not save join settings", description: result.error, variant: "destructive" });
      return;
    }

    toast({ title: "Join settings saved" });
  };

  /**
   * Persists tab visibility settings through the group-admin server action.
   */
  const onSaveTabVisibility = async () => {
    setSavingTabVisibility(true);
    const result = await updateGroupTabVisibility(groupId, tabVisibility);
    setSavingTabVisibility(false);

    if (!result.success) {
      toast({ title: "Could not save tab visibility", description: result.error, variant: "destructive" });
      return;
    }

    toast({ title: "Tab visibility saved" });
  };

  /**
   * Adds a new in-memory plan row to the memberships editor.
   */
  const onAddPlan = () => {
    setMembershipPlans((prev) => {
      const nextIndex = prev.length + 1;
      const newPlan: EditableMembershipPlan = {
        ...EMPTY_PLAN,
        id: `plan-${Date.now()}-${nextIndex}`,
        name: `Membership ${nextIndex}`,
        isDefault: prev.length === 0,
      };
      // Seed empty price drafts so the new plan's inputs are controlled (B1).
      setPriceDrafts((drafts) => ({
        ...drafts,
        [`${newPlan.id}:monthly`]: "",
        [`${newPlan.id}:yearly`]: "",
      }));
      return [...prev, newPlan];
    });
  };

  /**
   * Removes a plan and guarantees a default plan still exists when plans remain.
   */
  const onRemovePlan = (id: string) => {
    setMembershipPlans((prev) => {
      const remaining = prev.filter((plan) => plan.id !== id);
      if (remaining.length > 0 && !remaining.some((plan) => plan.isDefault)) {
        remaining[0] = { ...remaining[0], isDefault: true };
      }
      return remaining;
    });
  };

  /**
   * Marks one plan as default and clears the default flag from all others.
   */
  const onSetDefaultPlan = (id: string) => {
    setMembershipPlans((prev) => prev.map((plan) => ({ ...plan, isDefault: plan.id === id })));
  };

  /**
   * Generic controlled-input updater for editable plan fields.
   */
  const onPlanFieldChange = (
    id: string,
    field: keyof EditableMembershipPlan,
    value: string | boolean | number | null | string[]
  ) => {
    setMembershipPlans((prev) =>
      prev.map((plan) => {
        if (plan.id !== id) return plan;
        return { ...plan, [field]: value };
      })
    );
  };

  /**
   * Persists membership plans through the group-admin server action.
   */
  const onSaveMembershipPlans = async () => {
    setSavingMemberships(true);
    // Flush any unblurred price drafts into the plans before persisting (B1).
    const plansToSave = membershipPlans.map((plan) => ({
      ...plan,
      amountMonthlyCents: parseDollarsToCents(
        priceDrafts[`${plan.id}:monthly`] ?? formatDollarsFromCents(plan.amountMonthlyCents),
      ),
      amountYearlyCents: parseDollarsToCents(
        priceDrafts[`${plan.id}:yearly`] ?? formatDollarsFromCents(plan.amountYearlyCents),
      ),
    }));
    setMembershipPlans(plansToSave);
    const result = await updateGroupMembershipPlans(groupId, plansToSave);
    setSavingMemberships(false);

    if (!result.success) {
      toast({ title: "Could not save memberships", description: result.error, variant: "destructive" });
      return;
    }

    toast({ title: "Membership plans saved" });
  };

  /** Stages a newly selected cover image for the Profile tab (uploaded on save). */
  const handleCoverSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setCoverFile(file);
    setCoverPreview(URL.createObjectURL(file));
    event.target.value = "";
  }, []);

  /** Captures a selected location suggestion (label + coordinates) for the Profile tab. */
  const handleProfileLocationSelect = useCallback((suggestion: LocationSuggestion) => {
    setProfileLocationText(suggestion.label);
    setProfileLocationData(suggestion);
  }, []);

  /**
   * Persists the group's public profile (cover, name, description, location,
   * tags, commission) via `updateGroupResource` (A4 — the former Edit-Profile
   * modal folded into settings).
   */
  const onSaveProfile = async () => {
    if (!groupName.trim()) {
      toast({ title: "Name required", description: "Group name cannot be empty.", variant: "destructive" });
      return;
    }
    setSavingProfile(true);
    try {
      let finalCoverUrl = coverImage;
      if (coverFile) {
        setUploadingCover(true);
        const formData = new FormData();
        formData.append("file", coverFile);
        formData.append("bucket", "avatars");
        const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
        const uploadJson = await uploadRes.json().catch(() => ({}));
        if (!uploadRes.ok || !uploadJson.results?.[0]?.url) {
          toast({ title: "Cover upload failed", description: uploadJson.error || "Could not upload image.", variant: "destructive" });
          setSavingProfile(false);
          setUploadingCover(false);
          return;
        }
        finalCoverUrl = uploadJson.results[0].url;
        setUploadingCover(false);
      }

      const metadataPatch: Record<string, unknown> = {
        coverImage: finalCoverUrl,
        chapterTags: profileTags,
        tags: profileTags,
      };
      if (isOrganization) {
        metadataPatch.commissionBps = clampPercent(commissionPercent) * 100;
      }
      if (profileLocationData) {
        metadataPatch.location = {
          name: profileLocationData.label,
          city: profileLocationData.locality ?? profileLocationData.name ?? profileLocationData.label,
          lat: profileLocationData.lat,
          lng: profileLocationData.lon,
        };
      } else if (profileLocationText.trim()) {
        metadataPatch.location = profileLocationText.trim();
      } else {
        metadataPatch.location = null;
      }

      const result = await updateGroupResource({
        groupId,
        name: groupName.trim(),
        description: description.trim(),
        metadataPatch,
      });
      if (result.success) {
        setCoverImage(finalCoverUrl);
        setCoverFile(null);
        toast({ title: "Profile updated" });
        router.refresh();
      } else {
        toast({ title: "Update failed", description: result.message, variant: "destructive" });
      }
    } catch {
      toast({ title: "Update failed", description: "Something went wrong.", variant: "destructive" });
    } finally {
      setSavingProfile(false);
    }
  };

  /** Captures a selected location suggestion for the map-marker tab, syncing lat/lng (A5). */
  const handleMarkerLocationSelect = useCallback((suggestion: LocationSuggestion) => {
    setMarkerLocationText(suggestion.label);
    setMarkerLocationData(suggestion);
    if (typeof suggestion.lat === "number") setMarkerLat(String(suggestion.lat));
    if (typeof suggestion.lon === "number") setMarkerLng(String(suggestion.lon));
  }, []);

  /**
   * Persists the group's map-marker location (place + optional manual lat/lng)
   * as a structured `metadata.location` object via `updateGroupResource` (A5).
   */
  const onSaveMapMarker = async () => {
    setSavingMapMarker(true);
    try {
      const lat = markerLat.trim() ? Number(markerLat.trim()) : undefined;
      const lng = markerLng.trim() ? Number(markerLng.trim()) : undefined;
      if ((markerLat.trim() && !Number.isFinite(lat)) || (markerLng.trim() && !Number.isFinite(lng))) {
        toast({ title: "Invalid coordinates", description: "Latitude and longitude must be numbers.", variant: "destructive" });
        setSavingMapMarker(false);
        return;
      }
      const name = markerLocationData?.label ?? markerLocationText.trim();
      if (!name && lat === undefined && lng === undefined) {
        toast({ title: "Nothing to save", description: "Provide a place or coordinates.", variant: "destructive" });
        setSavingMapMarker(false);
        return;
      }
      const location = {
        name,
        city: markerLocationData?.locality ?? markerLocationData?.name ?? name,
        lat: lat ?? markerLocationData?.lat,
        lng: lng ?? markerLocationData?.lon,
      };
      const result = await updateGroupResource({ groupId, metadataPatch: { location } });
      if (result.success) {
        toast({ title: "Map location saved" });
        router.refresh();
      } else {
        toast({ title: "Could not save location", description: result.message, variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not save location", description: "Something went wrong.", variant: "destructive" });
    } finally {
      setSavingMapMarker(false);
    }
  };

  /**
   * Handles GLB file selection: uploads to MinIO and saves URL to group metadata.
   */
  const onUploadModel = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== "model/gltf-binary" && !file.name.endsWith(".glb")) {
      toast({ title: "Invalid file type", description: "Only .glb files are accepted.", variant: "destructive" });
      return;
    }

    setUploadingModel(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("bucket", "uploads");

      const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({ error: "Upload failed" }));
        toast({ title: "Upload failed", description: err.error || "Could not upload model file.", variant: "destructive" });
        setUploadingModel(false);
        return;
      }

      const uploadData = await uploadRes.json();
      const url = uploadData.results?.[0]?.url;
      if (!url) {
        toast({ title: "Upload failed", description: "No URL returned from upload.", variant: "destructive" });
        setUploadingModel(false);
        return;
      }

      const result = await updateGroupResource({ groupId, metadataPatch: { modelUrl: url } });
      if (!result.success) {
        toast({ title: "Could not save model", description: result.message, variant: "destructive" });
      } else {
        setModelUrl(url);
        toast({ title: "3D model uploaded and saved" });
      }
    } catch {
      toast({ title: "Upload error", description: "An unexpected error occurred.", variant: "destructive" });
    }
    setUploadingModel(false);
  };

  /**
   * Removes the GLB model URL from group metadata.
   */
  const onRemoveModel = async () => {
    setSavingModel(true);
    const result = await updateGroupResource({ groupId, metadataPatch: { modelUrl: null } });
    if (!result.success) {
      toast({ title: "Could not remove model", description: result.message, variant: "destructive" });
    } else {
      setModelUrl(null);
      toast({ title: "3D model removed" });
    }
    setSavingModel(false);
  };

  /**
   * Persists the chat mode selection for this group's Matrix room.
   */
  const onSaveChatMode = async () => {
    setSavingChatMode(true);
    try {
      await setGroupChatMode({ groupAgentId: groupId, chatMode });
      toast({ title: "Chat mode updated" });
    } catch {
      toast({ title: "Could not update chat mode", variant: "destructive" });
    }
    setSavingChatMode(false);
  };

  const upgradeToOrganization = async () => {
    setUpgradePending(true);
    const result = await updateGroupResource({
      groupId,
      metadataPatch: { groupType: "organization" },
    });
    setUpgradePending(false);

    if (!result.success) {
      if (result.error?.code === "SUBSCRIPTION_REQUIRED") {
        setShowMembershipGate(true);
        return;
      }
      toast({ title: "Could not upgrade group", description: result.message, variant: "destructive" });
      return;
    }

    setGroupType("organization");
    toast({ title: "Organization enabled" });
    router.refresh();
  };

  useEffect(() => {
    if (searchParams.get(RESUME_ORG_UPGRADE_PARAM) !== "1" || groupType === "organization") return;

    void (async () => {
      const subscription = await getSubscriptionStatusAction().catch(() => null);
      // Auto-upgrade to an organization only if the active tier actually grants
      // organization creation (Organization / Steward / Worker).
      if (!subscription || !tierHasCapability(subscription.tier, "create_org_group")) return;

      await upgradeToOrganization();
      router.replace(`/groups/${groupId}/settings`);
    })();
  }, [groupId, groupType, router, searchParams]);

  // Resolve initial tab from `?tab=` query param. Allows the OAuth callback
  // to deep-link back into the Connections tab after a round-trip.
  const requestedTab = searchParams.get("tab");
  const initialTab: TabValue =
    requestedTab && ALL_TABS.has(requestedTab as TabValue)
      ? (requestedTab as TabValue)
      : TAB_VALUES.PROFILE;

  // Surface OAuth callback errors only when the user landed on the
  // Connections tab — other tabs should not render unrelated error cards.
  const connectionsInitialError =
    initialTab === TAB_VALUES.CONNECTIONS ? searchParams.get("error") : null;

  // Non-admins are redirected away; render a neutral placeholder while the
  // client-side navigation to the group page completes.
  if (forbidden) {
    return <div className="container max-w-4xl mx-auto p-4">Redirecting…</div>;
  }

  // Conditional render for initial client fetch state.
  if (loading) {
    return <div className="container max-w-4xl mx-auto p-4">Loading settings...</div>;
  }

  // Conditional render for failed admin check or unavailable group settings.
  if (error) {
    return (
      <div className="container max-w-4xl mx-auto p-4 space-y-4">
        <Button variant="ghost" onClick={() => router.back()} className="w-fit">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>Access denied</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.push(`/groups/${groupId}`)}>Return to group</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-4xl mx-auto p-4 pb-20 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => router.back()} aria-label="Go back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-bold">{groupName} Settings</h1>
        </div>
        <Button variant="outline" onClick={() => router.push(`/groups/${groupId}`)}>
          View Group
        </Button>
      </div>

      <Tabs defaultValue={initialTab} className="space-y-6">
        <ResponsiveTabsList>
          <TabsTrigger value={TAB_VALUES.PROFILE} className="inline-flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            Profile
          </TabsTrigger>
          <TabsTrigger value={TAB_VALUES.MEMBERSHIPS} className="inline-flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            Memberships
          </TabsTrigger>
          <TabsTrigger value={TAB_VALUES.JOIN} className="inline-flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Join Settings
          </TabsTrigger>
          <TabsTrigger value={TAB_VALUES.REQUESTS} className="inline-flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Requests
          </TabsTrigger>
          <TabsTrigger value={TAB_VALUES.TAB_VISIBILITY} className="inline-flex items-center gap-2">
            <Eye className="h-4 w-4" />
            Tab Visibility
          </TabsTrigger>
          <TabsTrigger value={TAB_VALUES.CHAT} className="inline-flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Chat
          </TabsTrigger>
          <TabsTrigger value={TAB_VALUES.ASSISTANT} className="inline-flex items-center gap-2">
            <Bot className="h-4 w-4" />
            Assistant
          </TabsTrigger>
          <TabsTrigger value={TAB_VALUES.PERSONAS} className="inline-flex items-center gap-2">
            <Drama className="h-4 w-4" />
            Personas
          </TabsTrigger>
          <TabsTrigger value={TAB_VALUES.SITE} className="inline-flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            Site
          </TabsTrigger>
          <TabsTrigger value={TAB_VALUES.ANNOUNCEMENTS} className="inline-flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Announcements
          </TabsTrigger>
          <TabsTrigger value={TAB_VALUES.CONNECTIONS} className="inline-flex items-center gap-2">
            <Plug className="h-4 w-4" />
            Connectors
          </TabsTrigger>
          <TabsTrigger value={TAB_VALUES.MAP_MARKER} className="inline-flex items-center gap-2">
            <Globe className="h-4 w-4" />
            Map Marker
          </TabsTrigger>
          <TabsTrigger value={TAB_VALUES.ADMIN_OVERVIEW} className="inline-flex items-center gap-2">
            <Crown className="h-4 w-4" />
            Admin Overview
          </TabsTrigger>
        </ResponsiveTabsList>

        {/* Profile tab folds the former Edit-Profile modal into settings (A4). */}
        <TabsContent value="profile" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>
                Edit your group&apos;s public profile: cover image, name, description,
                location, and tags.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Cover Image */}
              <div className="space-y-2">
                <Label>Cover Image</Label>
                <button
                  type="button"
                  className="relative w-full h-32 rounded-lg border bg-muted overflow-hidden group cursor-pointer"
                  onClick={() => coverInputRef.current?.click()}
                >
                  {coverPreview ? (
                    <Image src={coverPreview} alt="Cover preview" fill className="object-cover" unoptimized />
                  ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                      Click to upload cover image
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                    <Camera className="h-6 w-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  {uploadingCover && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <span className="text-white text-sm">Uploading...</span>
                    </div>
                  )}
                </button>
                <input
                  ref={coverInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleCoverSelect}
                />
              </div>

              {/* Name */}
              <div className="space-y-2">
                <Label htmlFor="profile-name">Name</Label>
                <Input
                  id="profile-name"
                  value={groupName}
                  onChange={(event) => setGroupName(event.target.value)}
                  placeholder="Group name"
                  maxLength={120}
                />
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="profile-description">Description</Label>
                <Textarea
                  id="profile-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Describe your group..."
                  rows={4}
                  maxLength={2000}
                />
              </div>

              {/* Location */}
              <div className="space-y-2">
                <Label>Location</Label>
                <LocationAutocompleteInput
                  value={profileLocationText}
                  onValueChange={setProfileLocationText}
                  onSelectSuggestion={handleProfileLocationSelect}
                  placeholder="Search for a location..."
                />
              </div>

              {/* Tags */}
              <div className="space-y-2">
                <Label>Tags</Label>
                <TagEditor tags={profileTags} setTags={setProfileTags} placeholder="Add tags and press Enter..." />
              </div>

              {/* Mart commission — organizations only */}
              {isOrganization && (
                <div className="space-y-2">
                  <Label htmlFor="commission-percent">Mart Commission (%)</Label>
                  <Input
                    id="commission-percent"
                    type="number"
                    min={0}
                    max={MAX_COMMISSION_PERCENT}
                    step={1}
                    value={commissionPercent}
                    onChange={(event) => setCommissionPercent(clampPercent(parseInt(event.target.value, 10)))}
                    placeholder="0"
                  />
                  <p className="text-xs text-muted-foreground">
                    Percentage taken from member sales in your mart (0&ndash;{MAX_COMMISSION_PERCENT}%)
                  </p>
                </div>
              )}

              <Button type="button" onClick={onSaveProfile} disabled={savingProfile}>
                {savingProfile ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Profile"
                )}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="memberships" className="space-y-4">
          {groupType !== "organization" ? (
            <Card>
              <CardHeader>
                <CardTitle>Upgrade To Organization</CardTitle>
                <CardDescription>
                  Convert this basic group into an organization. Organization membership is required.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => void upgradeToOrganization()} disabled={upgradePending}>
                  {upgradePending ? "Processing..." : "Change Group Type To Org"}
                </Button>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Membership Subscriptions</CardTitle>
              <CardDescription>
                Configure recurring membership options for this group. Plans appear on the group About page.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Zero-state guidance when no plans are currently in local form state. */}
              {membershipPlans.length === 0 ? (
                <p className="text-sm text-muted-foreground">No plans yet. Add your first membership plan.</p>
              ) : null}

              {/* Render one editable card per membership plan in local state. */}
              {membershipPlans.map((plan) => (
                <div key={plan.id} className="rounded-md border p-4 space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>Plan Name</Label>
                      <Input
                        value={plan.name}
                        onChange={(event) => onPlanFieldChange(plan.id, "name", event.target.value)}
                        placeholder="Host Membership"
                      />
                    </div>
                    <div className="flex items-end gap-4">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={plan.active}
                          onCheckedChange={(checked) => onPlanFieldChange(plan.id, "active", checked)}
                        />
                        <Label>Active</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={plan.isDefault}
                          onCheckedChange={(checked) => {
                            if (checked) onSetDefaultPlan(plan.id);
                          }}
                        />
                        <Label>Default</Label>
                      </div>
                      <Button variant="destructive" size="sm" onClick={() => onRemovePlan(plan.id)}>
                        <Trash2 className="h-4 w-4 mr-1" />
                        Remove
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Description</Label>
                    <Textarea
                      rows={2}
                      value={plan.description}
                      onChange={(event) => onPlanFieldChange(plan.id, "description", event.target.value)}
                      placeholder="Access to member events and governance."
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>Monthly Price (USD)</Label>
                      <Input
                        inputMode="decimal"
                        value={priceDrafts[`${plan.id}:monthly`] ?? formatDollarsFromCents(plan.amountMonthlyCents)}
                        onChange={(event) =>
                          setPriceDrafts((drafts) => ({
                            ...drafts,
                            [`${plan.id}:monthly`]: sanitizePriceInput(event.target.value),
                          }))
                        }
                        onBlur={() => {
                          const cents = parseDollarsToCents(priceDrafts[`${plan.id}:monthly`] ?? "");
                          onPlanFieldChange(plan.id, "amountMonthlyCents", cents);
                          setPriceDrafts((drafts) => ({ ...drafts, [`${plan.id}:monthly`]: formatDollarsFromCents(cents) }));
                        }}
                        placeholder="22.00"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Yearly Price (USD)</Label>
                      <Input
                        inputMode="decimal"
                        value={priceDrafts[`${plan.id}:yearly`] ?? formatDollarsFromCents(plan.amountYearlyCents)}
                        onChange={(event) =>
                          setPriceDrafts((drafts) => ({
                            ...drafts,
                            [`${plan.id}:yearly`]: sanitizePriceInput(event.target.value),
                          }))
                        }
                        onBlur={() => {
                          const cents = parseDollarsToCents(priceDrafts[`${plan.id}:yearly`] ?? "");
                          onPlanFieldChange(plan.id, "amountYearlyCents", cents);
                          setPriceDrafts((drafts) => ({ ...drafts, [`${plan.id}:yearly`]: formatDollarsFromCents(cents) }));
                        }}
                        placeholder="220.00"
                      />
                    </div>
                  </div>


                  <div className="space-y-2">
                    <Label>Perks (one per line)</Label>
                    <Textarea
                      rows={3}
                      value={(plan.perks ?? []).join("\n")}
                      onChange={(event) =>
                        onPlanFieldChange(
                          plan.id,
                          "perks",
                          event.target.value
                            .split("\n")
                            .map((line) => line.trim())
                            .filter(Boolean)
                        )
                      }
                      placeholder="Priority support\nDiscounted event tickets"
                    />
                  </div>
                </div>
              ))}

              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={onAddPlan}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Plan
                </Button>
                <Button type="button" onClick={onSaveMembershipPlans} disabled={savingMemberships}>
                  {savingMemberships ? "Saving..." : "Save Membership Plans"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Join tab controls how users can discover/apply/invite into the group. */}
        <TabsContent value="join" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Join Settings</CardTitle>
              <CardDescription>Control how people join this group.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="join-visibility">Discovery</Label>
                <select
                  id="join-visibility"
                  className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                  value={joinSettings.visibility ?? "public"}
                  onChange={(event) =>
                    setJoinSettings((prev) => ({
                      ...prev,
                      visibility: event.target.value === "hidden" ? "hidden" : "public",
                    }))
                  }
                >
                  <option value="public">Public</option>
                  <option value="hidden">Hidden</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="join-type">Join Type</Label>
                <select
                  id="join-type"
                  className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                  value={joinSettings.joinType}
                  onChange={(event) =>
                    setJoinSettings((prev) => ({
                      ...prev,
                      joinType: event.target.value as JoinType,
                      approvalRequired:
                        event.target.value === JoinType.ApprovalRequired ||
                        event.target.value === JoinType.InviteAndApply,
                    }))
                  }
                >
                  <option value={JoinType.Public}>Open</option>
                  <option value={JoinType.ApprovalRequired}>Apply and approve</option>
                  <option value={JoinType.InviteOnly}>Invite Only</option>
                  <option value={JoinType.InviteAndApply}>Invite + apply and approve</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="invite-link">Invite link</Label>
                <div className="flex gap-2">
                  <Input
                    id="invite-link"
                    value={joinSettings.inviteLink ?? ""}
                    readOnly
                    placeholder="No invite link yet — generate one"
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
                      setJoinSettings((prev) => ({
                        ...prev,
                        inviteLink: `${window.location.origin}/groups/${groupId}?invite=${token}`,
                      }));
                    }}
                  >
                    {joinSettings.inviteLink ? "New link" : "Generate"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!joinSettings.inviteLink}
                    onClick={() => {
                      if (joinSettings.inviteLink) void navigator.clipboard.writeText(joinSettings.inviteLink);
                    }}
                  >
                    Copy
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Share this link to invite people. Generating a new link retires the old one once you save.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="application-instructions">Application Instructions</Label>
                <Textarea
                  id="application-instructions"
                  rows={4}
                  value={joinSettings.applicationInstructions ?? ""}
                  onChange={(event) =>
                    setJoinSettings((prev) => ({ ...prev, applicationInstructions: event.target.value }))
                  }
                  placeholder="Tell applicants what to include in their request."
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  checked={Boolean(joinSettings.approvalRequired)}
                  onCheckedChange={(checked) =>
                    setJoinSettings((prev) => ({ ...prev, approvalRequired: checked }))
                  }
                />
                <Label>Require admin approval</Label>
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  checked={Boolean(joinSettings.passwordRequired)}
                  onCheckedChange={(checked) =>
                    setJoinSettings((prev) => ({ ...prev, passwordRequired: checked }))
                  }
                />
                <Label>Require password challenge</Label>
              </div>

              <div className="flex items-start gap-2">
                <Switch
                  checked={Boolean(joinSettings.requireActiveSubscription)}
                  onCheckedChange={(checked) =>
                    setJoinSettings((prev) => ({ ...prev, requireActiveSubscription: checked }))
                  }
                />
                <div>
                  <Label>Require an active membership subscription</Label>
                  <p className="text-xs text-muted-foreground">
                    Members must hold an active paid subscription to join. Subscribing grants
                    membership automatically; configure plans under Memberships.
                  </p>
                </div>
              </div>

              <JoinQuestionEditor
                value={joinSettings.questions ?? []}
                onChange={(questions) =>
                  setJoinSettings((prev) => ({ ...prev, questions }))
                }
              />

              <Button type="button" onClick={onSaveJoinSettings} disabled={savingJoin}>
                {savingJoin ? "Saving..." : "Save Join Settings"}
              </Button>
            </CardContent>
          </Card>

          <GroupAdminPassword groupId={groupId} hasPassword={hasGroupPassword} />
        </TabsContent>

        <TabsContent value="requests" className="space-y-4">
          <GroupJoinRequestsCard groupId={groupId} />
        </TabsContent>

        {/* Tab Visibility controls which tabs appear for public, members, and admins. */}
        <TabsContent value="tab-visibility" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Tab Visibility</CardTitle>
              <CardDescription>
                Control which tabs are visible on the group page. Set each tab to Public
                (everyone), Members (group members only), Admin (admins only), or Hidden
                (completely removed).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <TabVisibilityEditor
                value={tabVisibility}
                onChange={setTabVisibility}
                groupType={groupType}
              />
              <Button type="button" onClick={onSaveTabVisibility} disabled={savingTabVisibility}>
                {savingTabVisibility ? "Saving..." : "Save Tab Visibility"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Chat tab controls the group's messaging mode (ledger/matrix/both). */}
        <TabsContent value="chat" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Chat Settings</CardTitle>
              <CardDescription>
                Choose how members communicate: public posts, private chat,
                or both.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {hasMatrixRoom ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="chat-mode">Chat Mode</Label>
                    <select
                      id="chat-mode"
                      className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                      value={chatMode}
                      onChange={(event) =>
                        setChatMode(event.target.value as ChatMode)
                      }
                    >
                      <option value="both">Public posts + private chat</option>
                      <option value="ledger">Public posts only</option>
                      <option value="matrix">Private chat only</option>
                    </select>
                    <p className="text-xs text-muted-foreground">
                      {chatMode === "both" &&
                        "Members can post publicly and message each other in the group's private chat."}
                      {chatMode === "ledger" &&
                        "Members post to the public feed only; posts are searchable across the community."}
                      {chatMode === "matrix" &&
                        "Members talk in the group's private chat only; messages stay private and unsearchable."}
                    </p>
                  </div>

                  <Button
                    type="button"
                    onClick={onSaveChatMode}
                    disabled={savingChatMode}
                  >
                    {savingChatMode ? "Saving..." : "Save Chat Settings"}
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Group chat isn&apos;t on yet. It turns on automatically
                  when the group is created with chat enabled.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Assistant tab: configure the group's AI assistant and chat with it
            at full admin scope. Both surfaces target the group's resolved
            direct agent via admin-gated server actions / the chat endpoint. */}
        <TabsContent value={TAB_VALUES.ASSISTANT} className="space-y-4">
          <GroupAssistantConfigCard groupId={groupId} />
          <GroupAssistantChat groupId={groupId} />
        </TabsContent>

        {/* Personas tab: manage the group's alternate public identities and pick
            which one (if any) carries the group's AI assistant. Backed by the
            admin-gated `group-personas` server actions. */}
        <TabsContent value={TAB_VALUES.PERSONAS} className="space-y-4">
          <GroupPersonaManager groupId={groupId} />
        </TabsContent>

        {/* Site tab: entry point to the sovereign site builder. The builder is a
            full-page surface (`/builder?group=`) that generates + publishes a
            static site from the group's RIVR content; the published site is
            served publicly at `/groups/{id}/site`. */}
        <TabsContent value={TAB_VALUES.SITE} className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Rocket className="h-5 w-5" />
                Group Site
              </CardTitle>
              <CardDescription>
                Generate and publish a simple public website for this group from its
                RIVR content (profile, posts, events, offerings). No coding required —
                pick sections and a theme, then publish.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button asChild>
                <a href={`/builder?group=${groupId}`}>
                  <Rocket className="h-4 w-4 mr-2" />
                  Open Site Builder
                </a>
              </Button>
              <Button variant="outline" asChild>
                <a href={`/groups/${groupId}/site`} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  View Published Site
                </a>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="announcements" className="space-y-4">
          <GroupBroadcastCard groupId={groupId} groupName={groupName} />
        </TabsContent>

        {/* Connectors tab.
            Two layers:
            1. Google Workspace OAuth card — the richer, OAuth-backed Google
               integration (calendar sync, group SMTP) on `groupConnections`.
            2. Generic connector panel — the full 13-provider catalog
               (`@/lib/connectors/catalog`) backed by `userConnectors`, so a
               group admin can also connect Notion, Substack, Luma, X and the
               messenger-class providers. Sync backends differ by provider:
               messenger providers (telegram/whatsapp/signal/slack/facebook/
               instagram) sync via mautrix bridges on the shared Matrix/Synapse
               infra; non-messenger providers use direct API/OAuth. This panel
               only stores credentials + runs a one-shot connectivity test. */}
        <TabsContent value={TAB_VALUES.CONNECTIONS} className="space-y-4">
          <ConnectionsForm
            groupId={groupId}
            connection={connection}
            initialError={connectionsInitialError}
          />
          <Card>
            <CardHeader>
              <CardTitle>All Connectors</CardTitle>
              <CardDescription>
                Connect this group to additional providers. Messenger providers
                sync through RIVR&apos;s Matrix bridges; the rest use direct
                API/OAuth.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ConnectorsSettingsPanel targetAgentId={groupId} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Admin Overview tab renders the GroupAdminView component with data mapped from settings state. */}
        <TabsContent value="admin-overview" className="space-y-4">
          <GroupAdminView
            group={{
              id: groupId,
              name: groupName,
              description: "",
              image: "",
              memberCount: 0,
              createdAt: new Date().toISOString(),
              type: groupType === "organization" ? LegacyGroupType.Organization : LegacyGroupType.Basic,
              modelUrl: modelUrl ?? undefined,
            } satisfies LegacyGroup}
          />
        </TabsContent>

        {/* Map Marker tab: place location (A5) + a GLB 3D model for the marker. */}
        <TabsContent value="map-marker" className="space-y-4">
          {/* A5: search a place or enter latitude/longitude directly for precise placement. */}
          <Card>
            <CardHeader>
              <CardTitle>Map Location</CardTitle>
              <CardDescription>
                Search for the group&apos;s place, or enter latitude/longitude directly for
                precise placement. Saved as the group&apos;s location.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Place</Label>
                <LocationAutocompleteInput
                  value={markerLocationText}
                  onValueChange={setMarkerLocationText}
                  onSelectSuggestion={handleMarkerLocationSelect}
                  placeholder="Search for a location..."
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="marker-lat">Latitude (optional)</Label>
                  <Input
                    id="marker-lat"
                    inputMode="decimal"
                    value={markerLat}
                    onChange={(event) => setMarkerLat(event.target.value)}
                    placeholder="40.0150"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="marker-lng">Longitude (optional)</Label>
                  <Input
                    id="marker-lng"
                    inputMode="decimal"
                    value={markerLng}
                    onChange={(event) => setMarkerLng(event.target.value)}
                    placeholder="-105.2705"
                  />
                </div>
              </div>
              <Button type="button" onClick={onSaveMapMarker} disabled={savingMapMarker}>
                {savingMapMarker ? "Saving..." : "Save Map Location"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>3D Map Marker</CardTitle>
              <CardDescription>
                Upload a .glb 3D model to use as this group&apos;s marker on the map instead of the default point.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {modelUrl ? (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label>Current Model</Label>
                    <p className="text-sm text-muted-foreground break-all">{modelUrl}</p>
                  </div>
                  <div className="flex gap-2">
                    <Label
                      htmlFor="glb-replace"
                      className="inline-flex items-center gap-2 cursor-pointer rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
                    >
                      {uploadingModel ? "Uploading..." : "Replace Model"}
                      <input
                        id="glb-replace"
                        type="file"
                        accept=".glb,model/gltf-binary"
                        className="hidden"
                        onChange={onUploadModel}
                        disabled={uploadingModel}
                      />
                    </Label>
                    <Button
                      variant="destructive"
                      onClick={onRemoveModel}
                      disabled={savingModel}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      {savingModel ? "Removing..." : "Remove"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    No 3D model uploaded. Upload a .glb file to replace the default map marker.
                  </p>
                  <Label
                    htmlFor="glb-upload"
                    className="inline-flex items-center gap-2 cursor-pointer rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
                  >
                    {uploadingModel ? "Uploading..." : "Upload .glb Model"}
                    <input
                      id="glb-upload"
                      type="file"
                      accept=".glb,model/gltf-binary"
                      className="hidden"
                      onChange={onUploadModel}
                      disabled={uploadingModel}
                    />
                  </Label>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <SubscriptionGateDialog
        open={showMembershipGate}
        onOpenChange={setShowMembershipGate}
        requiredTier="organizer"
        featureDescription="Changing a basic group into an organization requires an Organization membership or higher."
        onTrialStarted={() => void upgradeToOrganization()}
        returnPath={`/groups/${groupId}/settings?${RESUME_ORG_UPGRADE_PARAM}=1`}
      />
    </div>
  );
}
