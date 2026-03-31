"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResponsiveTabsList } from "@/components/responsive-tabs-list";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, Award, Calendar, Camera, Clock, CreditCard, Globe, History, MapPin, MessageSquare, Receipt, Send, Store, Users } from "lucide-react";
import { getSocialIcon, getSocialHref, getSocialDisplayLabel } from "@/lib/social-platform-icon";
import { useToast } from "@/components/ui/use-toast";
import { MetaMaskConnectButton } from "@/components/metamask-connect-button";
import {
  fetchMySavedListingIds,
  fetchMyReceipts,
  fetchProfileData,
  fetchUserPosts,
  fetchUserEvents,
  fetchUserGroups,
  fetchMarketplaceListings,
  fetchReactionCountsForUser,
  fetchUserConnections,
} from "@/app/actions/graph";
import type { ReactionCountsMap } from "@/app/actions/graph";
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers";
import {
  getMyTicketPurchasesAction,
  getMyWalletAction,
  getMyWalletsAction,
  getTransactionHistoryAction,
  getConnectBalanceAction,
  getConnectStatusAction,
  releaseTestConnectBalanceToWalletAction,
  requestPayoutAction,
  setupConnectAccountAction,
} from "@/app/actions/wallet";
import { getAllSubscriptionStatusesAction } from "@/app/actions/billing";
import { useAgent, useLocalesAndBasins } from "@/lib/hooks/use-graph-data";
import {
  agentToEvent,
  agentToGroup,
  agentToUser,
  resourceToMarketplaceListing,
  resourceToPost,
} from "@/lib/graph-adapters";
import { PostFeed } from "@/components/post-feed";
import { EventFeed } from "@/components/event-feed";
import { ProfileGroupFeed } from "@/components/profile-group-feed";
import { ProfileCalendar } from "@/components/profile-calendar";
import { OfferingsTab } from "@/components/offerings-tab";
import { PersonaManager } from "@/components/persona-manager";
import { AgentGraph } from "@/components/agent-graph";
import { UserConnections } from "@/components/user-connections";
import { ReceiptCard } from "@/components/receipt-card";
import WalletDepositDialog from "@/components/wallet-deposit-dialog";
import WalletHistory from "@/components/wallet-history";
import SendMoneyDialog from "@/components/send-money-dialog";
import EthAddressForm from "@/components/eth-address-form";
import { setEventRsvp, toggleJoinGroup, toggleLikeOnTarget, toggleSaveListing } from "@/app/actions/interactions";
import { updateProfileImageAction } from "@/app/actions/settings";
import type { Event, Group, MarketplaceListing, Post, User } from "@/lib/types";
import { OfferingType, PostType } from "@/lib/types";

const STABLE_FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";
type GraphEvent = ReturnType<typeof agentToEvent>;

function getStableTimestamp(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return STABLE_FALLBACK_TIMESTAMP;
}

/**
 * Inline Connect balance section for the wallet tab.
 * Fetches and displays the seller's Connect account balance and payout controls.
 */
function ConnectBalanceSection() {
  const isStripeTestMode =
    typeof process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY === "string" &&
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.startsWith("pk_test_");
  const [connectBalance, setConnectBalance] = useState<{ availableCents: number; pendingCents: number } | null>(null);
  const [connectStatus, setConnectStatus] = useState<{
    hasAccount: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted?: boolean;
    dashboardUrl?: string;
  } | null>(null);
  const [payoutLoading, setPayoutLoading] = useState(false);
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    getConnectStatusAction().then((res) => {
      if (cancelled || !res.success || !res.status) return;
      setConnectStatus({
        hasAccount: res.status.hasAccount,
        chargesEnabled: res.status.chargesEnabled,
        payoutsEnabled: res.status.payoutsEnabled,
        detailsSubmitted: res.status.detailsSubmitted,
        dashboardUrl: res.status.dashboardUrl,
      });
      if (res.status.hasAccount && res.status.chargesEnabled) {
        getConnectBalanceAction().then((balRes) => {
          if (cancelled || !balRes.success || !balRes.balance) return;
          setConnectBalance(balRes.balance);
        });
      }
    });
    return () => { cancelled = true; };
  }, []);

  const handleSetupSeller = async () => {
    setSetupLoading(true);
    const result = await setupConnectAccountAction(undefined, "/profile?tab=wallet&walletTab=sales");
    setSetupLoading(false);
    if (result.success && result.url) {
      window.location.assign(result.url);
    } else {
      toast({ title: "Setup failed", description: result.error ?? "Unable to start seller onboarding.", variant: "destructive" });
    }
  };

  const handleContinueSetup = async () => {
    setSetupLoading(true);
    const result = await setupConnectAccountAction(undefined, "/profile?tab=wallet&walletTab=sales");
    setSetupLoading(false);
    if (result.success && result.url) {
      window.location.assign(result.url);
    } else {
      toast({ title: "Setup failed", description: result.error ?? "Unable to continue onboarding.", variant: "destructive" });
    }
  };

  // Loading state
  if (!connectStatus) {
    return (
      <Card>
        <CardContent className="py-6 text-center">
          <p className="text-sm text-muted-foreground">Loading seller account status...</p>
        </CardContent>
      </Card>
    );
  }

  // No Connect account — show "Become a Seller" CTA
  if (!connectStatus.hasAccount) {
    return (
      <Card>
        <CardContent className="py-6 space-y-3">
          <div className="flex items-center gap-3">
            <Store className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="font-medium">Become a Seller</p>
              <p className="text-sm text-muted-foreground">
                Set up your payout account to receive payments for your listings, services, and events.
              </p>
            </div>
          </div>
          <Button disabled={setupLoading} onClick={handleSetupSeller}>
            {setupLoading ? "Setting up..." : "Set Up Payout Account"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Account exists but onboarding incomplete
  if (!connectStatus.chargesEnabled) {
    return (
      <Card>
        <CardContent className="py-6 space-y-3">
          <div className="flex items-center gap-3">
            <Store className="h-8 w-8 text-yellow-500" />
            <div>
              <p className="font-medium">Complete Seller Setup</p>
              <p className="text-sm text-muted-foreground">
                Your payout account needs additional information before you can accept payments.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Charges: {connectStatus.chargesEnabled ? "Enabled" : "Pending"}</Badge>
            <Badge variant="outline">Payouts: {connectStatus.payoutsEnabled ? "Enabled" : "Pending"}</Badge>
            <Badge variant="outline">Details: {connectStatus.detailsSubmitted ? "Submitted" : "Incomplete"}</Badge>
          </div>
          <Button disabled={setupLoading} onClick={handleContinueSetup}>
            {setupLoading ? "Loading..." : "Complete Setup"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Fully onboarded — show balance + controls
  const availableDollars = (connectBalance?.availableCents ?? 0) / 100;
  const pendingDollars = (connectBalance?.pendingCents ?? 0) / 100;

  const handlePayout = async (speed: "standard" | "instant") => {
    if (!connectBalance || connectBalance.availableCents <= 0) return;
    setPayoutLoading(true);
    const result = await requestPayoutAction(connectBalance.availableCents, speed);
    setPayoutLoading(false);
    if (result.success) {
      toast({ title: "Payout initiated", description: `${speed === "instant" ? "Instant" : "Standard (1-3 days)"} payout started.` });
      setConnectBalance({ availableCents: 0, pendingCents: connectBalance.pendingCents });
    } else {
      toast({ title: "Payout failed", description: result.error, variant: "destructive" });
    }
  };

  const handleReleaseTestSales = async () => {
    setReleaseLoading(true);
    const result = await releaseTestConnectBalanceToWalletAction();
    setReleaseLoading(false);
    if (result.success) {
      toast({
        title: "Test sales released",
        description: result.releasedCents && result.releasedCents > 0
          ? `$${(result.releasedCents / 100).toFixed(2)} moved into your Rivr wallet for testing.`
          : "No new test sales were available to release.",
      });
      const balRes = await getConnectBalanceAction();
      if (balRes.success && balRes.balance) setConnectBalance(balRes.balance);
    } else {
      toast({ title: "Release failed", description: result.error, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <p className="text-sm font-medium">Stripe USD Wallet</p>
        <p className="text-xs text-muted-foreground">
          Card sales land here first. Use payouts to move funds to your bank or eligible instant payout destination.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card>
          <CardContent className="py-4">
            <p className="text-xs text-muted-foreground">Available</p>
            <p className="text-2xl font-semibold">${availableDollars.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <p className="text-xs text-muted-foreground">Pending</p>
            <p className="text-2xl font-semibold">${pendingDollars.toFixed(2)}</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardContent className="py-4 space-y-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={connectStatus.chargesEnabled ? "default" : "outline"}>
              Charges {connectStatus.chargesEnabled ? "Enabled" : "Disabled"}
            </Badge>
            <Badge variant={connectStatus.payoutsEnabled ? "default" : "outline"}>
              Payouts {connectStatus.payoutsEnabled ? "Enabled" : "Disabled"}
            </Badge>
            <Badge variant={connectStatus.detailsSubmitted ? "default" : "outline"}>
              Details {connectStatus.detailsSubmitted ? "Submitted" : "Incomplete"}
            </Badge>
          </div>
        </CardContent>
      </Card>
      {connectBalance && connectBalance.availableCents > 0 && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={payoutLoading} onClick={() => handlePayout("standard")}>
            Bank payout (1-3 days)
          </Button>
          <Button variant="outline" size="sm" disabled={payoutLoading} onClick={() => handlePayout("instant")}>
            Instant payout
          </Button>
        </div>
      )}
      {connectStatus.dashboardUrl ? (
        <Button variant="outline" size="sm" asChild>
          <a href={connectStatus.dashboardUrl} target="_blank" rel="noreferrer">
            Seller Dashboard
          </a>
        </Button>
      ) : null}
      {isStripeTestMode ? (
        <Button variant="outline" size="sm" disabled={releaseLoading} onClick={() => void handleReleaseTestSales()}>
          {releaseLoading ? "Releasing..." : "Release Test Sales To Wallet"}
        </Button>
      ) : null}
    </div>
  );
}

const PROFILE_TABS = [
  "about",
  "posts",
  "events",
  "groups",
  "photos",
  "offerings",
  "calendar",
  "wallet",
  "personas",
  "saved",
  "activity",
] as const;

type ProfileTab = (typeof PROFILE_TABS)[number];
const WALLET_VIEW_TABS = ["transactions", "purchases", "sales"] as const;
type WalletViewTab = (typeof WALLET_VIEW_TABS)[number];

const asString = (value: unknown) => (typeof value === "string" ? value : "");
const asNumber = (value: unknown, fallback = 0) => (typeof value === "number" ? value : fallback);
const asStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function isProfileTab(value: string | null): value is ProfileTab {
  return !!value && PROFILE_TABS.includes(value as ProfileTab);
}

function isWalletViewTab(value: string | null): value is WalletViewTab {
  return !!value && WALLET_VIEW_TABS.includes(value as WalletViewTab);
}

function parsePrice(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.-]/g, "");
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function getOfferingType(resource: SerializedResource, meta: Record<string, unknown>): OfferingType {
  const listingType = String(meta.offerType ?? meta.listingType ?? "").toLowerCase();
  const kind = String(meta.resourceKind ?? "").toLowerCase();

  if (resource.type === "skill" || listingType === "service") return OfferingType.Skill;
  if (resource.type === "voucher" || kind === "voucher") return OfferingType.Voucher;
  if (resource.type === "venue" || kind === "venue") return OfferingType.Ticket;
  if (listingType === "product") return OfferingType.Product;
  if (resource.type === "resource") return OfferingType.Resource;
  return OfferingType.Product;
}

function getEventStart(event: Record<string, unknown>): string {
  const timeframe = asRecord(event.timeframe);
  const start = asString(timeframe.start);
  if (start) return start;
  return asString(event.startDate) || STABLE_FALLBACK_TIMESTAMP;
}

function getActivityObjectHref(
  object: {
    id: string;
    kind: "agent" | "resource";
    type: string;
    metadata?: Record<string, unknown>;
  } | null | undefined
): string | null {
  if (!object) return null;

  if (object.kind === "agent") {
    if (object.type === "organization") return `/groups/${object.id}`;
    if (object.type === "ring") return `/rings/${object.id}`;
    if (object.type === "family") return `/families/${object.id}`;
    if (object.type === "person") {
      const username = asString(object.metadata?.username);
      return `/profile/${username || object.id}`;
    }
    return null;
  }

  const resourceKind = asString(object.metadata?.resourceKind)?.toLowerCase();

  if (object.type === "post" || resourceKind === "post") return `/posts/${object.id}`;
  if (object.type === "event" || resourceKind === "event") return `/events/${object.id}`;
  if (object.type === "project" || resourceKind === "project") return `/projects/${object.id}`;
  if (object.type === "group" || resourceKind === "group") return `/groups/${object.id}`;
  if (
    object.type === "listing" ||
    object.type === "resource" ||
    object.type === "voucher" ||
    resourceKind === "listing" ||
    resourceKind === "voucher"
  ) {
    return `/marketplace/${object.id}`;
  }

  return null;
}

function getActivityObjectImage(
  object: {
    image?: string | null;
    metadata?: Record<string, unknown>;
  } | null | undefined
): string | null {
  if (!object) return null;

  if (object.image) return object.image;

  const images = asStringArray(object.metadata?.images);
  if (images.length > 0) return images[0];

  const image = asString(object.metadata?.image);
  if (image) return image;

  return null;
}

function getActivityObjectSummary(
  object: {
    type: string;
    metadata?: Record<string, unknown>;
  } | null | undefined
): string {
  if (!object) return "";

  const description = asString(object.metadata?.description);
  if (description) return description;

  const location = asString(object.metadata?.location);
  if (location) return location;

  const price = asString(object.metadata?.price);
  if (price) return price;

  return object.type;
}

function ActivityObjectCard({
  object,
}: {
  object: {
    id: string;
    name: string;
    kind: "agent" | "resource";
    type: string;
    image?: string | null;
    metadata?: Record<string, unknown>;
  };
}) {
  const href = getActivityObjectHref(object);
  const image = getActivityObjectImage(object);
  const summary = getActivityObjectSummary(object);
  const objectTypeLabel =
    object.kind === "agent"
      ? object.type
      : asString(object.metadata?.resourceKind) || object.type;

  const content = (
    <div className="flex items-start gap-3">
      {image ? (
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border bg-muted">
          <Image
            src={image}
            alt={object.name}
            fill
            className="object-cover"
            unoptimized
          />
        </div>
      ) : null}
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium break-words">{object.name}</p>
        <p className="text-xs text-muted-foreground capitalize">{objectTypeLabel}</p>
        {summary ? (
          <p className="text-xs text-muted-foreground line-clamp-2 break-words">{summary}</p>
        ) : null}
      </div>
    </div>
  );

  if (!href) {
    return <div className="rounded-lg border bg-muted/20 p-3">{content}</div>;
  }

  return (
    <Link
      href={href}
      className="block rounded-lg border bg-muted/20 p-3 transition-colors hover:bg-muted/40"
    >
      {content}
    </Link>
  );
}

export default function ProfilePage() {
  const { data: session, status, update: updateSession } = useSession();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();

  // IndexedDB-first: useAgent reads from local cache instantly, then syncs from server.
  const { agent } = useAgent(session?.user?.id ?? null);
  const [userPosts, setUserPosts] = useState<Post[]>([]);
  const [userEvents, setUserEvents] = useState<GraphEvent[]>([]);
  const [userGroups, setUserGroups] = useState<Group[]>([]);
  const [reactionCounts, setReactionCounts] = useState<ReactionCountsMap>({});
  const [marketplace, setMarketplace] = useState<MarketplaceListing[]>([]);
  const [profileResources, setProfileResources] = useState<SerializedResource[]>([]);
  const [profileActivity, setProfileActivity] = useState<
    Array<{
      id: string;
      verb: string;
      timestamp: string;
      objectId?: string | null;
      object?: {
        id: string;
        name: string;
        kind: "agent" | "resource";
        type: string;
        image?: string | null;
        metadata?: Record<string, unknown>;
      } | null;
    }>
  >([]);
  const [savedListingIds, setSavedListingIds] = useState<string[]>([]);
  const [walletSummary, setWalletSummary] = useState<{
    personalBalanceDollars: number;
    walletCount: number;
    transactionCount: number;
    connectAvailableCents: number;
    connectPendingCents: number;
    hasConnectAccount: boolean;
    thanksTokenCount: number;
    thanksTokensBurned: number;
    thanksTransferred: number;
    thanksReceived: number;
    thanksFlowRatio: number | null;
    /** Combined total: local wallet + Connect available, in dollars. */
    totalBalanceDollars: number;
    transactions: Array<{
      id: string;
      type: string;
      amountDollars: number;
      description: string;
      createdAt: string;
      status: string;
    }>;
  }>({
    personalBalanceDollars: 0,
    walletCount: 0,
    transactionCount: 0,
    connectAvailableCents: 0,
    connectPendingCents: 0,
    hasConnectAccount: false,
    thanksTokenCount: 0,
    thanksTokensBurned: 0,
    thanksTransferred: 0,
    thanksReceived: 0,
    thanksFlowRatio: 0,
    totalBalanceDollars: 0,
    transactions: [],
  });
  const [ethAddress, setEthAddress] = useState<string | null>(null);
  const [depositDialogOpen, setDepositDialogOpen] = useState(false);
  const [sendMoneyDialogOpen, setSendMoneyDialogOpen] = useState(false);
  const [walletHistoryOpen, setWalletHistoryOpen] = useState(false);
  const [ticketPurchases, setTicketPurchases] = useState<
    Array<{
      transactionId: string;
      ticketProductId: string;
      ticketProductName: string;
      eventId?: string;
      eventName?: string;
      amountCents: number;
      feeCents: number;
      totalDollars: number;
      purchasedAt: string;
      paymentMethod: "wallet" | "card";
    }>
  >([]);
  const [receipts, setReceipts] = useState<
    Array<{
      id: string;
      metadata: Record<string, unknown>;
      createdAt: string;
      listing: { id: string; name: string; description: string | null; metadata: Record<string, unknown> } | null;
      seller: { id: string; name: string; username: string | null; image: string | null } | null;
    }>
  >([]);
  const [activeTab, setActiveTab] = useState<ProfileTab>("about");
  const [activeWalletTab, setActiveWalletTab] = useState<WalletViewTab>("transactions");
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [localAvatarUrl, setLocalAvatarUrl] = useState<string | null>(null);
  const [localCoverUrl, setLocalCoverUrl] = useState<string | null>(null);
  const [activeTiers, setActiveTiers] = useState<Set<string>>(new Set());
  const [userConnections, setUserConnections] = useState<User[]>([]);

  const refreshWalletData = useCallback(async () => {
    const [myWallet, txHistory] = await Promise.all([
      getMyWalletAction(),
      getTransactionHistoryAction({ limit: 12, offset: 0 }),
    ]);
    const personalBal = myWallet.success && myWallet.wallet ? myWallet.wallet.balanceDollars : 0;
    const connectAvail = myWallet.success && myWallet.wallet ? (myWallet.wallet.connectAvailableCents ?? 0) : 0;
    const connectPend = myWallet.success && myWallet.wallet ? (myWallet.wallet.connectPendingCents ?? 0) : 0;
    const hasConnect = myWallet.success && myWallet.wallet ? (myWallet.wallet.hasConnectAccount ?? false) : 0;
    setEthAddress(myWallet.success && myWallet.wallet ? (myWallet.wallet.ethAddress ?? null) : null);
    setWalletSummary((prev) => ({
      ...prev,
      personalBalanceDollars: personalBal,
      connectAvailableCents: connectAvail,
      connectPendingCents: connectPend,
      hasConnectAccount: !!hasConnect,
      totalBalanceDollars: personalBal + (connectAvail / 100),
      transactions:
        txHistory.success && txHistory.transactions
          ? txHistory.transactions.slice(0, 12).map((tx) => ({
              id: tx.id,
              type: tx.type,
              amountDollars: tx.amountDollars,
              description: tx.description ?? "Wallet transaction",
              createdAt: tx.createdAt,
              status: tx.status,
            }))
          : prev.transactions,
    }));
  }, []);

  const handleImageUpload = useCallback(async (field: "avatar" | "coverImage", file: File) => {
    const setLoading = field === "avatar" ? setUploadingAvatar : setUploadingCover;
    setLoading(true);
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
      const newUrl = uploadJson.results[0].url;
      const result = await updateProfileImageAction(field, newUrl);
      if (result.success) {
        toast({ title: field === "avatar" ? "Avatar updated" : "Cover image updated" });
        if (field === "avatar") {
          setLocalAvatarUrl(newUrl);
          void updateSession();
        } else {
          setLocalCoverUrl(newUrl);
        }
      } else {
        toast({ title: "Update failed", description: result.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "Upload failed", description: "Something went wrong.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const { data: localesData } = useLocalesAndBasins();

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (isProfileTab(tab) && tab !== activeTab) {
      setActiveTab(tab);
    }
  }, [activeTab, searchParams]);

  useEffect(() => {
    const walletTab = searchParams.get("walletTab");
    if (isWalletViewTab(walletTab) && walletTab !== activeWalletTab) {
      setActiveWalletTab(walletTab);
    }
  }, [activeWalletTab, searchParams]);

  const setTab = (tab: string) => {
    if (!isProfileTab(tab)) return;
    setActiveTab(tab);
    const query = new URLSearchParams(searchParams.toString());
    query.set("tab", tab);
    router.replace(`/profile?${query.toString()}`, { scroll: false });
  };

  const setWalletTab = (tab: string) => {
    if (!isWalletViewTab(tab)) return;
    setActiveWalletTab(tab);
    const query = new URLSearchParams(searchParams.toString());
    query.set("tab", "wallet");
    query.set("walletTab", tab);
    router.replace(`/profile?${query.toString()}`, { scroll: false });
  };

  // Supplementary data (profile resources, wallet, saved listings) still fetched from server.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!session?.user?.id) {
        setProfileResources([]);
        setSavedListingIds([]);
        return;
      }

      const [profile, savedIds, myWallet, myWallets, txHistory, ticketPurchaseResult, subscriptionStatus, receiptsResult, postsResult, eventAgents, groupAgents, marketplaceListings, reactionCountsResult, connectionAgents] = await Promise.all([
        fetchProfileData(session.user.id).catch(() => null),
        fetchMySavedListingIds().catch(() => [] as string[]),
        getMyWalletAction().catch(() => ({ success: false as const })),
        getMyWalletsAction().catch(() => ({ success: false as const })),
        getTransactionHistoryAction({ limit: 30 }).catch(() => ({ success: false as const })),
        getMyTicketPurchasesAction().catch(() => ({ success: false as const })),
        getAllSubscriptionStatusesAction().catch(() => []),
        fetchMyReceipts().catch(() => ({ receipts: [] })),
        fetchUserPosts(session.user.id, 30).catch(() => ({ posts: [] as SerializedResource[], owner: null })),
        fetchUserEvents(session.user.id, 30).catch(() => [] as SerializedAgent[]),
        fetchUserGroups(session.user.id, 30).catch(() => [] as SerializedAgent[]),
        fetchMarketplaceListings(50).catch(() => [] as Array<SerializedResource & { ownerName: string; ownerImage: string }>),
        fetchReactionCountsForUser(session.user.id).catch(() => ({} as ReactionCountsMap)),
        fetchUserConnections(session.user.id).catch(() => [] as SerializedAgent[]),
      ]);

      if (cancelled) return;

      // Build user's posts from targeted fetch
      const ownerForPosts = postsResult.owner;
      setUserPosts(
        postsResult.posts.map((resource) => resourceToPost(resource, ownerForPosts ?? undefined)) as Post[]
      );
      setUserEvents(eventAgents.map((event) => agentToEvent(event)));
      setUserGroups(groupAgents.map(agentToGroup));
      setReactionCounts(reactionCountsResult);
      setUserConnections(connectionAgents.map(agentToUser));
      setMarketplace(
        (marketplaceListings as Array<SerializedResource & { ownerName?: string; ownerImage?: string }>).map((listing) =>
          resourceToMarketplaceListing(listing, undefined)
        )
      );

      setProfileResources((profile?.resources as SerializedResource[]) ?? []);
      setProfileActivity(
        ((profile?.recentActivity as Array<{
          id: string;
          verb: string;
          timestamp: string;
          objectId?: string | null;
          object?: {
            id: string;
            name: string;
            kind: "agent" | "resource";
            type: string;
            image?: string | null;
            metadata?: Record<string, unknown>;
          } | null;
        }>) ?? []).map((entry) => ({
          id: entry.id,
          verb: entry.verb,
          timestamp: entry.timestamp,
          objectId: entry.objectId ?? null,
          object: entry.object ?? null,
        }))
      );
      setSavedListingIds(savedIds);
      const personalBal = myWallet.success && myWallet.wallet ? myWallet.wallet.balanceDollars : 0;
      const connectAvail = myWallet.success && myWallet.wallet ? (myWallet.wallet.connectAvailableCents ?? 0) : 0;
      const connectPend = myWallet.success && myWallet.wallet ? (myWallet.wallet.connectPendingCents ?? 0) : 0;
      const hasConnect = myWallet.success && myWallet.wallet ? (myWallet.wallet.hasConnectAccount ?? false) : false;
      const thanksTokenCount = myWallet.success && myWallet.wallet ? (myWallet.wallet.thanksTokenCount ?? 0) : 0;
      const thanksTokensBurned = myWallet.success && myWallet.wallet ? (myWallet.wallet.thanksTokensBurned ?? 0) : 0;
      const thanksTransferred = myWallet.success && myWallet.wallet ? (myWallet.wallet.thanksTransferred ?? 0) : 0;
      const thanksReceivedTotal = myWallet.success && myWallet.wallet ? (myWallet.wallet.thanksReceived ?? 0) : 0;
      const thanksFlowRatio = myWallet.success && myWallet.wallet ? (myWallet.wallet.thanksFlowRatio ?? 0) : 0;
      setEthAddress(myWallet.success && myWallet.wallet ? (myWallet.wallet.ethAddress ?? null) : null);
      setWalletSummary({
        personalBalanceDollars: personalBal,
        walletCount: myWallets.success && myWallets.wallets ? myWallets.wallets.length : 0,
        transactionCount: txHistory.success && txHistory.transactions ? txHistory.transactions.length : 0,
        connectAvailableCents: connectAvail,
        connectPendingCents: connectPend,
        hasConnectAccount: hasConnect,
        thanksTokenCount,
        thanksTokensBurned,
        thanksTransferred,
        thanksReceived: thanksReceivedTotal,
        thanksFlowRatio,
        totalBalanceDollars: personalBal + (connectAvail / 100),
        transactions:
          txHistory.success && txHistory.transactions
            ? txHistory.transactions.slice(0, 12).map((tx) => ({
                id: tx.id,
                type: tx.type,
                amountDollars: tx.amountDollars,
                description: tx.description ?? "Wallet transaction",
                createdAt: tx.createdAt,
                status: tx.status,
              }))
            : [],
      });
      setTicketPurchases(
        ticketPurchaseResult.success && ticketPurchaseResult.purchases
          ? ticketPurchaseResult.purchases
          : []
      );
      setActiveTiers(
        new Set(
          (subscriptionStatus as Array<{ tier: string; status: string }>)
            .filter((s) => s.status === "active" || s.status === "trialing")
            .map((s) => s.tier)
        )
      );
      setReceipts(receiptsResult.receipts ?? []);
    }

    if (status === "authenticated") {
      load();
    }

    return () => {
      cancelled = true;
    };
  }, [session?.user?.id, status]);

  const metadata = (agent?.metadata ?? {}) as Record<string, unknown>;
  const socialLinks = asRecord(metadata.socialLinks ?? metadata.social_links);
  const userId = agent?.id || session?.user?.id || "";

  const profileUser: User = useMemo(
    () => ({
      id: userId,
      name: agent?.name || session?.user?.name || "Your Profile",
      username: asString(metadata.username) || session?.user?.email?.split("@")[0] || "user",
      email: agent?.email || session?.user?.email || "",
      bio: agent?.description || asString(metadata.bio) || "",
      tagline: asString(metadata.tagline) || "",
      avatar: localAvatarUrl || agent?.image || session?.user?.image || "/placeholder-user.jpg",
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
      homeLocale: asString(metadata.homeLocale),
    }),
    [
      agent?.description,
      agent?.email,
      agent?.id,
      agent?.image,
      agent?.name,
      metadata,
      localAvatarUrl,
      session?.user?.email,
      session?.user?.id,
      session?.user?.image,
      session?.user?.name,
      userId,
    ]
  );

  // Build lookup Maps from the profile user + targeted group data for getUser/getGroup helpers
  const usersById = useMemo(() => {
    const map = new Map<string, User>();
    map.set(profileUser.id, profileUser);
    return map;
  }, [profileUser]);
  const groupsById = useMemo(() => new Map(userGroups.map((g) => [g.id, g])), [userGroups]);

  const offeringResources = useMemo(
    () =>
      profileResources.filter((resource) => {
        const meta = asRecord(resource.metadata);
        const kind = asString(meta.resourceKind).toLowerCase();
        return (
          resource.type === "resource" ||
          resource.type === "skill" ||
          resource.type === "venue" ||
          resource.type === "voucher" ||
          asString(meta.listingKind).toLowerCase() === "marketplace-listing" ||
          typeof meta.listingType === "string" ||
          kind === "offering"
        );
      }),
    [profileResources]
  );

  const offeringPostsForTab = useMemo<Post[]>(() => {
    const mappedFromResources = offeringResources.map((resource) => {
      const meta = asRecord(resource.metadata);
      const offeringType = getOfferingType(resource, meta);
      const price = parsePrice(meta.price ?? meta.basePrice);

      return {
        id: `offering-${resource.id}`,
        content: resource.content || resource.description || "",
        author: profileUser,
        createdAt: resource.createdAt,
        likes: asNumber(meta.likes),
        comments: asNumber(meta.commentCount),
        postType: PostType.Offer,
        title: resource.name,
        description: resource.description || resource.content || "",
        offeringType,
        basePrice: price,
        currency: asString(meta.currency) || "USD",
        isActive: true,
        tags: resource.tags || [],
      } as Post;
    });

    const offerAndRequestPosts = userPosts.filter(
      (post) => post.postType === PostType.Offer || post.postType === PostType.Request
    );

    const deduped = new Map<string, Post>();
    for (const post of [...mappedFromResources, ...offerAndRequestPosts]) {
      deduped.set(post.id, post);
    }
    return Array.from(deduped.values());
  }, [offeringResources, profileUser, userPosts]);

  const userServices = useMemo<MarketplaceListing[]>(
    () => marketplace.filter((listing) => listing.seller?.id === userId && listing.type === "service"),
    [marketplace, userId]
  );

  const savedListings = useMemo(
    () => marketplace.filter((listing) => savedListingIds.includes(listing.id)),
    [marketplace, savedListingIds]
  );

  const chapterMap = useMemo(() => {
    const map = new Map<string, { id: string; name: string; image?: string; location?: string }>();
    for (const locale of localesData.locales) {
      const entry = { id: locale.id, name: locale.name, image: locale.image, location: locale.location };
      map.set(locale.id, entry);
      if (locale.slug) map.set(locale.slug, entry);
    }
    for (const basin of localesData.basins) {
      const entry = { id: basin.id, name: basin.name, image: basin.image };
      map.set(basin.id, entry);
    }
    return map;
  }, [localesData.locales, localesData.basins]);

  const userChapters = useMemo(
    () => (profileUser.chapterTags ?? []).map((id) => chapterMap.get(id)).filter((v): v is { id: string; name: string; image?: string; location?: string } => !!v),
    [chapterMap, profileUser.chapterTags]
  );

  const homeLocaleName = useMemo(() => {
    if (!profileUser.homeLocale) return "";
    const locale = localesData.locales.find((l) => l.id === profileUser.homeLocale);
    return locale?.name ?? "";
  }, [profileUser.homeLocale, localesData.locales]);

  const commentsReceived = useMemo(() => userPosts.reduce((sum, post) => sum + (post.comments || 0), 0), [userPosts]);
  const thanksReceivedCount = walletSummary.thanksReceived;

  const hoursContributed = useMemo(() => {
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
      const candidates = [
        ...(Array.isArray(meta.images) ? (meta.images as string[]) : []),
        typeof meta.imageUrl === "string" ? meta.imageUrl : "",
      ].filter((v): v is string => typeof v === "string" && v.length > 0);
      for (const image of candidates) {
        if (seen.has(image)) continue;
        seen.add(image);
        photos.push({ src: image, label: resource.name || "Resource image", id: resource.id, createdAt: resource.createdAt });
      }
    }
    return photos.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 60);
  }, [metadata.profilePhotos, profileResources, profileUser.joinedAt, userPosts]);

  const upcomingEventCount = useMemo(
    () =>
      userEvents.filter((event) => {
        const start = getEventStart(event as unknown as Record<string, unknown>);
        return new Date(start).getTime() >= Date.now();
      }).length,
    [userEvents]
  );
  const salesTransactions = useMemo(
    () =>
      walletSummary.transactions.filter((tx) =>
        ["marketplace_purchase", "marketplace_payout", "connect_payout", "service_fee", "event_ticket"].includes(tx.type)
      ),
    [walletSummary.transactions]
  );

  const getUser = useCallback((id: string): User =>
    usersById.get(id) || {
      id,
      name: "Unknown User",
      username: "unknown",
      avatar: "/placeholder-user.jpg",
      followers: 0,
      following: 0,
    }, [usersById]);

  const getGroup = useCallback((id: string): Group =>
    (groupsById.get(id) as Group | undefined) || {
      id,
      name: "Unknown Group",
      description: "",
      image: "/placeholder.svg",
      memberCount: 0,
      createdAt: STABLE_FALLBACK_TIMESTAMP,
    }, [groupsById]);

  const calendarEvents = useMemo<Event[]>(
    () =>
      userEvents.map((event) => {
        const organizerId = typeof event.organizer === "string" ? event.organizer : "";
        return {
          id: event.id,
          name: event.name,
          title: event.title,
          description: event.description,
          timeframe: event.timeframe,
          startDate: event.timeframe?.start,
          endDate: event.timeframe?.end,
          organizer: getUser(organizerId),
          attendees: typeof event.attendees === "number" ? event.attendees : 0,
          image: event.image,
          location: event.location,
          tags: event.tags,
          chapterTags: event.chapterTags,
        } as Event;
      }),
    [getUser, userEvents]
  );

  const handleLike = async (postId: string) => {
    const result = await toggleLikeOnTarget(postId, "post");
    toast({
      title: result.success ? (result.active ? "Liked" : "Unliked") : "Could not update like",
      description: result.message,
      variant: result.success ? "default" : "destructive",
    });
  };

  const handleSharePost = async (postId: string) => {
    const shareUrl = `${window.location.origin}/posts/${postId}`;
    if (navigator.share) {
      await navigator.share({ title: "Post", url: shareUrl });
      return;
    }
    await navigator.clipboard.writeText(shareUrl);
    toast({ title: "Link copied", description: "Post URL copied to clipboard." });
  };

  const handleJoinGroup = async (groupId: string) => {
    const result = await toggleJoinGroup(groupId, "group");
    toast({
      title: result.success ? (result.active ? "Joined group" : "Left group") : "Could not update membership",
      description: result.message,
      variant: result.success ? "default" : "destructive",
    });
  };

  const handleToggleSavedListing = async (listingId: string) => {
    const result = await toggleSaveListing(listingId);
    if (!result.success) {
      toast({
        title: "Could not update saved listing",
        description: result.message,
        variant: "destructive",
      });
      return;
    }

    setSavedListingIds((prev) =>
      result.active ? Array.from(new Set([...prev, listingId])) : prev.filter((id) => id !== listingId)
    );
  };

  const handleEventRsvp = async (eventId: string, statusValue: "going" | "interested" | "maybe" | "none") => {
    const normalized = statusValue === "maybe" ? "interested" : statusValue;
    const result = await setEventRsvp(eventId, normalized);
    toast({
      title: result.success ? "RSVP updated" : "Could not update RSVP",
      description: result.message,
      variant: result.success ? "default" : "destructive",
    });
  };

  const coverImage = localCoverUrl || asString(metadata.coverImage) || "/vibrant-garden-tending.png";
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

  return (
    <div className="pb-20">
      <div className="container max-w-6xl mx-auto py-4 space-y-6">
        <div className="rounded-xl border overflow-hidden bg-card">
          <button
            type="button"
            className="relative h-40 md:h-52 bg-cover bg-center w-full group cursor-pointer"
            style={{ backgroundImage: `url(${coverImage})` }}
            onClick={() => coverInputRef.current?.click()}
            disabled={uploadingCover}
          >
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
              <Camera className="h-8 w-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            {uploadingCover && <div className="absolute inset-0 bg-black/50 flex items-center justify-center"><span className="text-white text-sm">Uploading...</span></div>}
          </button>
          <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageUpload("coverImage", f); e.target.value = ""; }} />
          <div className="px-4 md:px-6 pb-4">
            <div className="relative z-10 flex items-start justify-between gap-4 -mt-12 md:-mt-14">
              <button
                type="button"
                className="relative h-24 w-24 md:h-28 md:w-28 rounded-full border-4 border-background bg-muted overflow-hidden group cursor-pointer"
                onClick={() => avatarInputRef.current?.click()}
                disabled={uploadingAvatar}
              >
                <Image
                  src={profileUser.avatar}
                  alt={profileUser.name}
                  width={112}
                  height={112}
                  className="h-full w-full object-cover"
                  unoptimized
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center rounded-full">
                  <Camera className="h-6 w-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                {uploadingAvatar && <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-full"><span className="text-white text-xs">...</span></div>}
              </button>
              <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageUpload("avatar", f); e.target.value = ""; }} />
              <Button size="sm" variant="outline" asChild>
                <Link href="/settings">Edit Profile</Link>
              </Button>
            </div>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2 space-y-2">
                <h1 className="text-2xl font-bold leading-tight">{profileUser.name}</h1>
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
                  <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{profileUser.location || homeLocaleName || "Location not set"}</span>
                  {homeLocaleName && profileUser.location && homeLocaleName !== profileUser.location && (
                    <span className="inline-flex items-center gap-1"><Globe className="h-3.5 w-3.5" />{homeLocaleName}</span>
                  )}
                  <span className="inline-flex items-center gap-1"><Award className="h-3.5 w-3.5" />{profileUser.points || 0} points</span>
                  <span className="inline-flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />{upcomingEventCount} upcoming events</span>
                  <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />{userGroups.length} groups</span>
                </div>
                <p className="text-sm text-muted-foreground">{profileUser.tagline || "No tagline yet."}</p>
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Quick Stats</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {(() => {
                    const REACTION_EMOJI_LABELS: Record<string, { emoji: string; label: string }> = {
                      like: { emoji: "\u2764\uFE0F", label: "Likes" },
                      love: { emoji: "\uD83D\uDE0D", label: "Loves" },
                      laugh: { emoji: "\uD83D\uDE02", label: "Laughs" },
                      wow: { emoji: "\uD83D\uDE2E", label: "Wows" },
                      sad: { emoji: "\uD83D\uDE22", label: "Sads" },
                      angry: { emoji: "\uD83D\uDE21", label: "Angries" },
                    };
                    const activeReactions = Object.entries(reactionCounts).filter(([, count]) => count > 0);
                    if (activeReactions.length === 0) {
                      return <div className="text-sm text-muted-foreground">No reactions yet</div>;
                    }
                    return activeReactions.map(([type, count]) => {
                      const info = REACTION_EMOJI_LABELS[type];
                      if (!info) return null;
                      return (
                        <div key={type} className="flex items-center justify-between text-sm">
                          <span className="inline-flex items-center gap-2 text-muted-foreground">
                            <span className="text-base">{info.emoji}</span>{info.label}
                          </span>
                          <span className="font-medium">{count}</span>
                        </div>
                      );
                    });
                  })()}
                  <div className="flex items-center justify-between text-sm"><span className="inline-flex items-center gap-2 text-muted-foreground"><MessageSquare className="h-4 w-4" />Comments</span><span className="font-medium">{commentsReceived}</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="inline-flex items-center gap-2 text-muted-foreground"><Clock className="h-4 w-4" />Hours contributed</span><span className="font-medium">{hoursContributed}</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="inline-flex items-center gap-2 text-muted-foreground"><Award className="h-4 w-4" />Thanks received</span><span className="font-medium">{thanksReceivedCount}</span></div>
                  <Link href="/settings"><Button variant="outline" size="sm" className="w-full mt-2">Account Settings</Button></Link>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setTab}>
          <ResponsiveTabsList>
            <TabsTrigger value="about">About</TabsTrigger>
            <TabsTrigger value="posts">Posts</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
            <TabsTrigger value="groups">Groups</TabsTrigger>
            <TabsTrigger value="photos">Photos</TabsTrigger>
            <TabsTrigger value="offerings">Offerings</TabsTrigger>
            <TabsTrigger value="calendar">Calendar</TabsTrigger>
            <TabsTrigger value="wallet">Wallet</TabsTrigger>
            <TabsTrigger value="personas">Personas</TabsTrigger>
            <TabsTrigger value="saved">Saved</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </ResponsiveTabsList>

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
                  <CardHeader><CardTitle className="text-lg">Platform Membership</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">Unlock additional platform features and support the cooperative with a membership.</p>
                    <div className="space-y-2">
                      {(() => {
                        const TIER_LEVELS: Record<string, number> = {
                          basic: 1,
                          host: 2,
                          seller: 2,
                          organizer: 3,
                          steward: 4,
                        };
                        const highestLevel = Math.max(0, ...[...activeTiers].map((t) => TIER_LEVELS[t] ?? 0));
                        const hasOrganizer = activeTiers.has("organizer");

                        return [
                          { name: "Basic Member", href: "/products/membership-basic", billingTier: "basic", level: 1 },
                          { name: "Host Membership", href: "/products/membership-host", billingTier: "host", level: 2 },
                          { name: "Seller Membership", href: "/products/membership-seller", billingTier: "seller", level: 2 },
                          { name: "Organizer Membership", href: "/products/membership-organizer", billingTier: "organizer", level: 3 },
                          { name: "Steward Membership", href: "/products/membership-steward", billingTier: "steward", level: 4 },
                        ].map((tier) => {
                          const isActive = activeTiers.has(tier.billingTier);
                          const isIncluded = !isActive && hasOrganizer && (tier.billingTier === "host" || tier.billingTier === "seller");
                          const isDowngrade = !isActive && !isIncluded && tier.level < highestLevel;
                          const isUpgrade = !isActive && !isIncluded && !isDowngrade;

                          let subtitle = "Upgrade to access more tools";
                          if (isActive) subtitle = "Current membership tier";
                          else if (isIncluded) subtitle = "Included with Organizer";
                          else if (isDowngrade) subtitle = "Lower tier than current";

                          return (
                            <div key={tier.name} className="border rounded-md px-3 py-2 flex items-center justify-between">
                              <div>
                                <p className="text-sm font-medium">{tier.name}</p>
                                <p className="text-xs text-muted-foreground">{subtitle}</p>
                              </div>
                              {isActive ? (
                                <Badge className="bg-green-100 text-green-700">Active</Badge>
                              ) : isIncluded ? (
                                <Badge variant="secondary">Included</Badge>
                              ) : isDowngrade ? (
                                <Badge variant="outline">Downgrade</Badge>
                              ) : isUpgrade ? (
                                <Button variant="outline" size="sm" asChild>
                                  <Link href={tier.href}>Upgrade</Link>
                                </Button>
                              ) : null}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle className="text-lg">Chapters</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {userChapters.length > 0 ? (
                      userChapters.map((chapter) => (
                        <Badge key={chapter.id} variant="secondary">{chapter.name}</Badge>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">No chapters set.</p>
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

                <UserConnections connections={userConnections} />
              </div>
            </div>
            <Card className="mt-4">
              <CardHeader><CardTitle>Relationships</CardTitle></CardHeader>
              <CardContent>
                <AgentGraph agentId={session?.user?.id ?? ""} agentName={session?.user?.name ?? "Me"} agentType="person" />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="posts" className="mt-4">
            <PostFeed
              posts={userPosts}
              getUser={getUser}
              getGroup={getGroup}
              onLike={handleLike}
              onComment={() => {}}
              onShare={(postId) => void handleSharePost(postId)}
              onThank={() => {}}
              includeAllTypes={false}
            />
          </TabsContent>

        <TabsContent value="events" className="mt-4">
          {ticketPurchases.length > 0 ? (
            <Card className="mb-4">
              <CardHeader>
                <CardTitle className="text-lg">Purchased Tickets</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {ticketPurchases.map((purchase) => (
                  <div key={purchase.transactionId} className="border rounded-md px-3 py-2 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">
                        {purchase.eventName || purchase.ticketProductName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(purchase.purchasedAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium">${purchase.totalDollars.toFixed(2)}</p>
                      <Badge variant="outline" className="text-xs">
                        {purchase.paymentMethod === "wallet" ? "Wallet" : "Card"}
                      </Badge>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
          <EventFeed
            events={userEvents}
            getGroupName={(id) => getGroup(id).name}
              getGroupId={(id) => id}
              getCreatorName={(id) => getUser(id).name}
              getCreatorUsername={(id) => getUser(id).username}
              onRsvpChange={handleEventRsvp}
            />
          </TabsContent>

          <TabsContent value="groups" className="mt-4">
            <ProfileGroupFeed
              groups={userGroups}
              currentUserId={userId}
              getMembers={(memberIds) => memberIds.map((id) => getUser(id))}
              onJoinGroup={handleJoinGroup}
            />
          </TabsContent>

          <TabsContent value="photos" className="mt-4">
            {profilePhotos.length === 0 ? (
              <p className="text-sm text-muted-foreground">No photos yet.</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {profilePhotos.map((photo) => (
                  <Card key={`${photo.id}-${photo.src}`} className="overflow-hidden">
                    <Image src={photo.src} alt={photo.label} width={420} height={260} className="h-40 w-full object-cover" unoptimized />
                    <CardContent className="py-2">
                      <p className="text-xs text-muted-foreground truncate">{photo.label}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="offerings" className="mt-4">
            <OfferingsTab
              userPosts={offeringPostsForTab}
              userMatches={[]}
              onCreatePost={() => router.push("/create?tab=offering")}
              onCreateRequest={() => router.push("/create?tab=post")}
            />
          </TabsContent>

          <TabsContent value="calendar" className="mt-4">
            <ProfileCalendar
              userShifts={[]}
              userEvents={calendarEvents}
              userServices={userServices}
              currentUserId={userId}
            />
          </TabsContent>

          <TabsContent value="wallet" className="mt-4 space-y-3">
            {/* Total Balance card spans full width when Connect is active */}
            {walletSummary.hasConnectAccount && (
              <Card>
                <CardContent className="py-4">
                  <p className="text-xs text-muted-foreground">Total USD Balance</p>
                  <p className="text-3xl font-bold">${walletSummary.totalBalanceDollars.toFixed(2)}</p>
                  <p className="text-xs text-muted-foreground mt-1">Rivr wallet plus Stripe USD wallet</p>
                </CardContent>
              </Card>
            )}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">Rivr USD Wallet</p><p className="text-2xl font-semibold">${walletSummary.personalBalanceDollars.toFixed(2)}</p></CardContent></Card>
              <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">Stripe USD Wallet</p><p className="text-2xl font-semibold">${(walletSummary.connectAvailableCents / 100).toFixed(2)}</p><p className="text-xs text-muted-foreground mt-1">Pending ${(walletSummary.connectPendingCents / 100).toFixed(2)}</p></CardContent></Card>
              <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">Wallets</p><p className="text-2xl font-semibold">{walletSummary.walletCount}</p></CardContent></Card>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setDepositDialogOpen(true)}>
                <CreditCard className="h-4 w-4 mr-2" />
                Add Money
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSendMoneyDialogOpen(true)}>
                <Send className="h-4 w-4 mr-2" />
                Send Money
              </Button>
              <Button size="sm" variant="outline" onClick={() => setWalletHistoryOpen(true)}>
                <History className="h-4 w-4 mr-2" />
                Transaction History
              </Button>
            </div>
            <WalletDepositDialog
              open={depositDialogOpen}
              onClose={() => setDepositDialogOpen(false)}
              onSuccess={refreshWalletData}
            />
            <SendMoneyDialog
              open={sendMoneyDialogOpen}
              onClose={() => setSendMoneyDialogOpen(false)}
              onSuccess={refreshWalletData}
            />
            <WalletHistory
              open={walletHistoryOpen}
              onClose={() => setWalletHistoryOpen(false)}
            />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Card>
                <CardContent className="py-4">
                  <p className="text-xs text-muted-foreground">Thanks Tokens</p>
                  <p className="text-2xl font-semibold">{walletSummary.thanksTokenCount}</p>
                  <p className="text-xs text-muted-foreground mt-1">Current tokens in your account</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4">
                  <p className="text-xs text-muted-foreground">Burned For Inactivity</p>
                  <p className="text-2xl font-semibold">{walletSummary.thanksTokensBurned}</p>
                  <p className="text-xs text-muted-foreground mt-1">Total tokens removed by demurrage</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4">
                  <p className="text-xs text-muted-foreground">Thanks Flow Ratio</p>
                  <p className="text-2xl font-semibold">
                    {walletSummary.thanksFlowRatio === null ? "∞" : walletSummary.thanksFlowRatio.toFixed(2)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {walletSummary.thanksTransferred} sent / {walletSummary.thanksReceived} received
                  </p>
                </CardContent>
              </Card>
            </div>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Crypto Wallet</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MetaMaskConnectButton currentEthAddress={ethAddress} />
                    {ethAddress && (
                      <Badge variant="secondary">Connected</Badge>
                    )}
                  </div>
                </div>
                <EthAddressForm
                  currentAddress={ethAddress ?? undefined}
                  onUpdate={(addr) => setEthAddress(addr)}
                />
              </CardContent>
            </Card>
            <Tabs value={activeWalletTab} onValueChange={setWalletTab}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="transactions">Transactions</TabsTrigger>
                <TabsTrigger value="purchases">Purchases</TabsTrigger>
                <TabsTrigger value="sales">Sales</TabsTrigger>
              </TabsList>

              <TabsContent value="transactions" className="mt-3 space-y-3">
                {walletSummary.transactions.length > 0 ? (
                  walletSummary.transactions.map((tx) => (
                    <Card key={tx.id}>
                      <CardContent className="py-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium">{tx.description}</p>
                          <p className="text-xs text-muted-foreground">{new Date(tx.createdAt).toLocaleString()} • {tx.type} • {tx.status}</p>
                        </div>
                        <p className="font-semibold">${Math.abs(tx.amountDollars).toFixed(2)}</p>
                      </CardContent>
                    </Card>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No wallet transactions yet.</p>
                )}
              </TabsContent>

              <TabsContent value="purchases" className="mt-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">Purchases</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {receipts.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {receipts.map((r) => {
                          const meta = r.metadata;
                          const listingMeta = (r.listing?.metadata ?? {}) as Record<string, unknown>;
                          const priceCents = (meta.totalCents as number) || (meta.priceCents as number) || 0;
                          return (
                            <ReceiptCard
                              key={r.id}
                              receiptId={r.id}
                              listingId={(meta.originalListingId as string) || ""}
                              title={r.listing?.name || "Unknown Item"}
                              description={r.listing?.description || ""}
                              price={`$${(priceCents / 100).toFixed(2)}`}
                              images={(listingMeta.images as string[]) || []}
                              type={(listingMeta.listingType as "product" | "service") || "product"}
                              category={(listingMeta.category as string) || undefined}
                              location={(listingMeta.location as string) || undefined}
                              purchaseDate={(meta.purchasedAt as string) || r.createdAt}
                              status={(meta.status as string) || "completed"}
                              seller={r.seller}
                            />
                          );
                        })}
                      </div>
                    ) : null}
                    {ticketPurchases.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">Tickets</p>
                        {ticketPurchases.map((purchase) => (
                          <div key={purchase.transactionId} className="border rounded-md px-3 py-2 flex items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium">
                                {purchase.eventName || purchase.ticketProductName}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {new Date(purchase.purchasedAt).toLocaleString()}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-sm font-medium">${purchase.totalDollars.toFixed(2)}</p>
                              <Badge variant="outline" className="text-xs">
                                {purchase.paymentMethod === "wallet" ? "Wallet" : "Card"}
                              </Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      receipts.length === 0 ? (
                        <div className="text-center py-6">
                          <Receipt className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
                          <p className="text-sm text-muted-foreground">No purchases yet.</p>
                        </div>
                      ) : null
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="sales" className="mt-3 space-y-3">
                <ConnectBalanceSection />
                {salesTransactions.length > 0 ? (
                  salesTransactions.map((tx) => (
                    <Card key={tx.id}>
                      <CardContent className="py-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium">{tx.description}</p>
                          <p className="text-xs text-muted-foreground">{new Date(tx.createdAt).toLocaleString()} • {tx.type} • {tx.status}</p>
                        </div>
                        <p className="font-semibold">${Math.abs(tx.amountDollars).toFixed(2)}</p>
                      </CardContent>
                    </Card>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No sales recorded yet.</p>
                )}
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="saved" className="mt-4 space-y-3">
            {savedListings.length === 0 ? <p className="text-sm text-muted-foreground">No saved listings yet.</p> : null}
            {savedListings.map((listing) => (
              <Card key={listing.id}>
                <CardContent className="py-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{listing.title}</p>
                    <p className="text-sm text-muted-foreground">{listing.description || "No description"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => router.push(`/marketplace/${listing.id}`)}>Open</Button>
                    <Button variant="outline" size="sm" onClick={() => handleToggleSavedListing(listing.id)}>Remove</Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </TabsContent>

          <TabsContent value="personas" className="mt-4">
            <PersonaManager />
          </TabsContent>

          <TabsContent value="activity" className="mt-4 space-y-3">
            {profileActivity.length === 0 ? <p className="text-sm text-muted-foreground">No activity yet.</p> : null}
            {profileActivity.map((entry) => (
              <Card key={entry.id}>
                <CardContent className="py-3 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium capitalize">{entry.verb}</p>
                    <p className="shrink-0 text-xs text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</p>
                  </div>
                  {entry.object ? (
                    <ActivityObjectCard object={entry.object} />
                  ) : entry.objectId ? (
                    <p className="text-sm text-muted-foreground break-all">{entry.objectId}</p>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </TabsContent>
        </Tabs>

        {status === "authenticated" && !agent ? <div className="text-sm text-muted-foreground">Loading profile data...</div> : null}
      </div>
    </div>
  );
}
