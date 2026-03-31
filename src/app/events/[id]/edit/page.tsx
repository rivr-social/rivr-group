"use client";

import { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Globe, Calendar, Clock, MapPin, DollarSign, ImageIcon, Building2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/use-toast";
import {
  fetchGroupDetail,
  fetchMarketplaceListings,
  fetchEventDetail,
} from "@/app/actions/graph";
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers";
import { updateResource } from "@/app/actions/create-resources";
import { agentToEvent } from "@/lib/graph-adapters";
import { LocationAutocompleteInput } from "@/components/location-autocomplete-input";
import { VisibilityScopeSelector, type VisibilityScopeState } from "@/components/visibility-scope-selector";
import { SearchableSelect } from "@/components/searchable-select";
import { AdminManager } from "@/components/admin-manager";
import type { MemberInfo } from "@/types/domain";
import { EftPicker, defaultEftValues, defaultCapitalValues, defaultAuditValues, type EftValues, type CapitalValues, type AuditValues } from "@/components/eft-picker";
import { useHomeFeed, useLocalesAndBasins } from "@/lib/hooks/use-graph-data";
import { fetchManagedGroupsAction } from "@/app/actions/event-form";
import {
  createCheckoutAction,
  startFreeTrialAction,
} from "@/app/actions/billing";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Event edit page for updating an existing event.
 *
 * Route: `/events/[id]/edit`
 * Rendering: Client Component (`"use client"`), rendered in browser with client-side state.
 * Data requirements: Route `id`, event data from `fetchEventDetail(id)`, and form updates via `updateResource`.
 * Metadata: This file does not export `metadata` or `generateMetadata`; inherited metadata is used.
 */
/**
 * Renders and manages the event edit form with full feature parity to the create page event tab.
 *
 * @param props - Async route params containing the event id.
 * @returns Edit form UI, loading skeleton, or not-found fallback UI.
 */
export default function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  // Unwrap dynamic route params in a Client Component via React `use`.
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useToast();

  // Live data hooks for locale and group selectors.
  const { data: homeData } = useHomeFeed(500, "all");
  const { data: localeData } = useLocalesAndBasins();

  const liveGroups = useMemo(() => homeData.groups, [homeData.groups]);

  const [saving, setSaving] = useState(false);
  const [eventAgent, setEventAgent] = useState<SerializedAgent | null>(null);
  const [loading, setLoading] = useState(true);

  // Core form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [location, setLocation] = useState("");
  const [price, setPrice] = useState("");
  const [isGlobal, setIsGlobal] = useState(true);

  // Extended form state (parity with create page)
  const [eventType, setEventType] = useState<"in-person" | "online">("in-person");
  const [postEventAsGroup, setPostEventAsGroup] = useState(false);
  const [selectedVenue, setSelectedVenue] = useState("none");
  const [venueStartTime, setVenueStartTime] = useState("");
  const [venueEndTime, setVenueEndTime] = useState("");
  const [eventGroup, setEventGroup] = useState("none");
  const [eventProject, setEventProject] = useState("none");
  const [eventVisibilityScope, setEventVisibilityScope] = useState<VisibilityScopeState>({
    localeIds: [],
    groupIds: [],
    userIds: [],
  });
  const [eftValues, setEftValues] = useState<EftValues>(defaultEftValues);
  const [capitalValues, setCapitalValues] = useState<CapitalValues>(defaultCapitalValues);
  const [auditValues, setAuditValues] = useState<AuditValues>(defaultAuditValues);

  // Fetched resource lists for pickers
  const [liveVenueResources, setLiveVenueResources] = useState<SerializedResource[]>([]);
  const [eventGroupProjects, setEventGroupProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [manageableGroups, setManageableGroups] = useState<Array<{ id: string; name: string; description: string | null; groupType: string | null }>>([]);
  const [eventTickets, setEventTickets] = useState<Array<{
    id: string;
    name: string;
    description: string;
    price: string;
    quantity: string;
  }>>([
    {
      id: "general-admission",
      name: "General Admission",
      description: "",
      price: "",
      quantity: "",
    },
  ]);

  // Admin management state
  const [eventAdminIds, setEventAdminIds] = useState<string[]>([]);
  const [eventCreatorId, setEventCreatorId] = useState<string>("");
  const [eventMembers, setEventMembers] = useState<MemberInfo[]>([]);

  // Membership gate state
  const [showMembershipGate, setShowMembershipGate] = useState(false);
  const [isMembershipActionPending, setIsMembershipActionPending] = useState(false);

  // Fetch venue resources on mount.
  useEffect(() => {
    let cancelled = false;
    fetchMarketplaceListings(500)
      .then((rows) => {
        if (cancelled) return;
        const venues = rows.filter((resource) => {
          const meta = (resource.metadata ?? {}) as Record<string, unknown>;
          return (
            resource.type === "venue" ||
            String(meta.resourceKind ?? "").toLowerCase() === "venue" ||
            meta.isVenue === true
          );
        });
        setLiveVenueResources(venues as SerializedResource[]);
      })
      .catch(() => {
        if (cancelled) return;
        setLiveVenueResources([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchManagedGroupsAction()
      .then((groups) => {
        if (!cancelled) setManageableGroups(groups);
      })
      .catch(() => {
        if (!cancelled) setManageableGroups([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Refetch projects whenever the selected event group changes so the project selector stays scoped.
  useEffect(() => {
    let cancelled = false;
    if (!eventGroup || eventGroup === "none") {
      return;
    }

    fetchGroupDetail(eventGroup)
      .then((detail) => {
        if (cancelled || !detail) return;
        const projects = detail.resources
          .filter((resource) => {
            const meta = (resource.metadata ?? {}) as Record<string, unknown>;
            return resource.type === "project" || String(meta.resourceKind ?? "").toLowerCase() === "project";
          })
          .map((project) => ({ id: project.id, name: project.name }));
        setEventGroupProjects(projects);
      })
      .catch(() => {
        if (cancelled) return;
        setEventGroupProjects([]);
      });

    return () => {
      cancelled = true;
    };
  }, [eventGroup]);

  // Events are stored as resources, so edit must resolve through fetchEventDetail
  // instead of the generic agent hook used for people/groups.
  useEffect(() => {
    let cancelled = false;

    const loadEvent = async () => {
      setLoading(true);
      try {
        const agent = await fetchEventDetail(id);
        if (cancelled) return;
        if (!agent) {
          setEventAgent(null);
          return;
        }

        const event = agentToEvent(agent);
        const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
        const sourceDate = typeof metadata.date === "string" ? metadata.date : event.timeframe.start;
        const sourceTime = typeof metadata.time === "string" ? metadata.time : "";
        const sourceLocation =
          typeof metadata.location === "string"
            ? metadata.location
            : typeof event.location === "object"
              ? event.location?.address || event.location?.name || ""
              : "";

        setEventAgent(agent);

        // Populate admin management state from event metadata.
        const creatorIdValue = typeof metadata.creatorId === "string" ? metadata.creatorId : "";
        setEventCreatorId(creatorIdValue);
        const adminIdsRaw = Array.isArray(metadata.adminIds) ? (metadata.adminIds as string[]) : [];
        setEventAdminIds(adminIdsRaw.length > 0 ? adminIdsRaw : (creatorIdValue ? [creatorIdValue] : []));
        // Build member list from attendees metadata if available.
        const attendeesRaw = Array.isArray(metadata.attendees) ? (metadata.attendees as Array<Record<string, unknown>>) : [];
        setEventMembers(attendeesRaw.map((a) => ({
          id: String(a.id ?? ""),
          name: String(a.name ?? "Unknown"),
          username: String(a.username ?? "unknown"),
          avatar: typeof a.avatar === "string" ? a.avatar : "/placeholder.svg",
        })));

        setName(event.name || "");
        setDescription(event.description || "");
        setDate(sourceDate ? sourceDate.slice(0, 10) : "");
        setTime(sourceTime ? sourceTime.slice(0, 5) : "");
        setLocation(sourceLocation);
        setPrice(event.price ? String(event.price) : "");
        setIsGlobal(metadata.isGlobal !== false);

        if (metadata.eventType === "online" || metadata.eventType === "in-person") {
          setEventType(metadata.eventType as "in-person" | "online");
        }
        if (typeof metadata.venueId === "string" && metadata.venueId) {
          setSelectedVenue(metadata.venueId);
        }
        if (typeof metadata.venueStartTime === "string") {
          setVenueStartTime(metadata.venueStartTime);
        }
        if (typeof metadata.venueEndTime === "string") {
          setVenueEndTime(metadata.venueEndTime);
        }
        if (typeof metadata.groupId === "string" && metadata.groupId) {
          setEventGroup(metadata.groupId);
        }
        const creatorId = typeof metadata.creatorId === "string" ? metadata.creatorId : null;
        setPostEventAsGroup(Boolean(creatorId && typeof metadata.groupId === "string" && metadata.groupId === creatorId));
        if (typeof metadata.projectId === "string" && metadata.projectId) {
          setEventProject(metadata.projectId);
        }
        const scopedLocaleIds = Array.isArray(metadata.scopedLocaleIds) ? metadata.scopedLocaleIds as string[] : [];
        const scopedGroupIds = Array.isArray(metadata.scopedGroupIds) ? metadata.scopedGroupIds as string[] : [];
        const scopedUserIds = Array.isArray(metadata.scopedUserIds) ? metadata.scopedUserIds as string[] : [];
        if (scopedLocaleIds.length > 0 || scopedGroupIds.length > 0 || scopedUserIds.length > 0) {
          setEventVisibilityScope({ localeIds: scopedLocaleIds, groupIds: scopedGroupIds, userIds: scopedUserIds });
        }
        if (metadata.eftValues && typeof metadata.eftValues === "object") {
          setEftValues(metadata.eftValues as EftValues);
        }
        if (metadata.capitalValues && typeof metadata.capitalValues === "object") {
          setCapitalValues(metadata.capitalValues as CapitalValues);
        }
        if (metadata.auditValues && typeof metadata.auditValues === "object") {
          setAuditValues(metadata.auditValues as AuditValues);
        }
        const ticketTypes = Array.isArray(metadata.ticketTypes) ? metadata.ticketTypes as Array<Record<string, unknown>> : [];
        if (ticketTypes.length > 0) {
          setEventTickets(ticketTypes.map((ticket, index) => ({
            id: typeof ticket.id === "string" ? ticket.id : `ticket-${index + 1}`,
            name: typeof ticket.name === "string" ? ticket.name : `Ticket ${index + 1}`,
            description: typeof ticket.description === "string" ? ticket.description : "",
            price:
              typeof ticket.priceCents === "number"
                ? (ticket.priceCents / 100).toFixed(2)
                : typeof ticket.price === "number"
                  ? String(ticket.price)
                  : "",
            quantity: typeof ticket.quantity === "number" ? String(ticket.quantity) : "",
          })));
        } else {
          setEventTickets([{
            id: "general-admission",
            name: "General Admission",
            description: "",
            price: event.price ? String(event.price) : "",
            quantity: "",
          }]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadEvent();
    return () => {
      cancelled = true;
    };
  }, [id]);

  /**
   * Updates selected event group, clears the currently selected project, and resets projects list.
   *
   * @param newGroup Group identifier selected in the event form.
   */
  const handleEventGroupChange = (newGroup: string) => {
    setEventGroup(newGroup);
    setEventProject("none");
    if (!newGroup || newGroup === "none") {
      setEventGroupProjects([]);
    }
  };

  const updateEventTicket = (
    ticketId: string,
    field: "name" | "description" | "price" | "quantity",
    fieldValue: string,
  ) => {
    setEventTickets((current) =>
      current.map((ticket) => (ticket.id === ticketId ? { ...ticket, [field]: fieldValue } : ticket))
    );
  };

  const addEventTicket = () => {
    setEventTickets((current) => [
      ...current,
      {
        id: `ticket-${Date.now()}`,
        name: "",
        description: "",
        price: "",
        quantity: "",
      },
    ]);
  };

  const removeEventTicket = (ticketId: string) => {
    setEventTickets((current) => (current.length === 1 ? current : current.filter((ticket) => ticket.id !== ticketId)));
  };

  const canSubmit = useMemo(() => {
    // Require all core fields before enabling submit.
    return name.trim().length > 0 && description.trim().length > 0 && date.length > 0 && time.length > 0 && location.trim().length > 0;
  }, [name, description, date, time, location]);

  /**
   * Submits the event update request and routes back to the event detail page on success.
   *
   * @param e - Form submit event.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!eventAgent) return;
    if (!canSubmit) {
      toast({ title: "Missing information", description: "Please fill all required fields.", variant: "destructive" });
      return;
    }
    if (postEventAsGroup && (!eventGroup || eventGroup === "none")) {
      toast({ title: "Select a group", description: "Choose which group should publish this event.", variant: "destructive" });
      return;
    }

    const normalizedTickets = eventTickets
      .map((ticket) => ({
        id: ticket.id,
        name: ticket.name.trim(),
        description: ticket.description.trim(),
        price: ticket.price.trim() ? Number.parseFloat(ticket.price.trim()) : 0,
        quantity: ticket.quantity.trim() ? Number.parseInt(ticket.quantity.trim(), 10) : null,
      }))
      .filter((ticket) => ticket.name.length > 0);
    const primaryLocaleId = eventVisibilityScope.localeIds[0] ?? null;
    const priceValue =
      normalizedTickets[0] && Number.isFinite(normalizedTickets[0].price)
        ? normalizedTickets[0].price
        : price.trim()
          ? Number.parseFloat(price.trim())
          : null;

    setSaving(true);
    try {
      // Persist edits through a server action; access control is enforced server-side.
      const result = await updateResource({
        resourceId: eventAgent.id,
        ownerId: postEventAsGroup ? (eventGroup !== "none" ? eventGroup : undefined) : "self",
        name: name.trim(),
        description: description.trim(),
        content: description.trim(),
        metadataPatch: {
          entityType: "event",
          resourceKind: "event",
          date,
          time,
          location: location.trim(),
          price: Number.isFinite(priceValue) ? priceValue : null,
          startDate: date,
          endDate: date,
          isGlobal,
          eventType,
          localeId: primaryLocaleId,
          venueId: selectedVenue !== "none" ? selectedVenue : null,
          venueStartTime: venueStartTime || null,
          venueEndTime: venueEndTime || null,
          groupId: eventGroup !== "none" ? eventGroup : null,
          projectId: eventProject !== "none" ? eventProject : null,
          ticketTypes: normalizedTickets,
          scopedLocaleIds: eventVisibilityScope.localeIds.length > 0 ? eventVisibilityScope.localeIds : undefined,
          scopedGroupIds: eventVisibilityScope.groupIds.length > 0 ? eventVisibilityScope.groupIds : undefined,
          scopedUserIds: eventVisibilityScope.userIds.length > 0 ? eventVisibilityScope.userIds : undefined,
          eftValues: Object.values(eftValues).some(v => v > 0) ? eftValues : undefined,
          capitalValues: Object.values(capitalValues).some(v => v > 0) ? capitalValues : undefined,
          auditValues: Object.values(auditValues).some(v => v > 0) ? auditValues : undefined,
        },
      });

      if (!result.success) {
        toast({ title: "Could not update event", description: result.message, variant: "destructive" });
        return;
      }

      // Event was saved, but paid ticket offering requires membership subscription.
      if (result.error?.code === "SUBSCRIPTION_REQUIRED") {
        setShowMembershipGate(true);
        toast({
          title: "Event saved — subscription needed for paid tickets",
          description: result.error.details ?? "Start a free 1-month trial or subscribe to sell tickets.",
        });
        return;
      }

      toast({ title: "Event updated", description: "Your event was updated successfully." });
      // Client-side navigation back to the event page, then refresh to ensure fresh server data.
      router.push(`/events/${id}`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  /**
   * Starts a free Organizer trial, then re-submits the price update to create the companion offering.
   */
  const handleStartFreeTrial = async () => {
    setIsMembershipActionPending(true);
    try {
      const result = await startFreeTrialAction("organizer");
      if (!result.success) {
        toast({ title: "Unable to start free trial", description: result.error ?? "Please try again.", variant: "destructive" });
        setIsMembershipActionPending(false);
        return;
      }
      if (result.url) {
        window.location.href = result.url;
        return;
      }
      toast({ title: "Trial already active", description: "Your Organizer trial is already active. You can now sell tickets." });
      setShowMembershipGate(false);
      setIsMembershipActionPending(false);
      await handleSubmit(new Event("submit") as unknown as React.FormEvent);
    } catch {
      setIsMembershipActionPending(false);
      toast({ title: "Unable to start free trial", description: "An unexpected error occurred.", variant: "destructive" });
    }
  };

  /**
   * Redirects to the paid Organizer checkout flow.
   */
  const handleSubscribeForTickets = async () => {
    setIsMembershipActionPending(true);
    try {
      const result = await createCheckoutAction("organizer", "monthly");
      if (result.success && result.url) {
        window.location.href = result.url;
        return;
      }
      toast({ title: "Unable to start checkout", description: result.error ?? "Please try again.", variant: "destructive" });
      setIsMembershipActionPending(false);
    } catch {
      setIsMembershipActionPending(false);
      toast({ title: "Unable to start checkout", description: "An unexpected error occurred.", variant: "destructive" });
    }
  };

  /**
   * Handles admin list changes from the AdminManager component.
   * Persists updated admin IDs to event metadata via updateResource.
   */
  const handleAdminChange = async (newAdmins: string[]) => {
    setEventAdminIds(newAdmins);
    if (!eventAgent) return;
    try {
      await updateResource({
        resourceId: eventAgent.id,
        metadataPatch: { adminIds: newAdmins },
      });
    } catch {
      toast({ title: "Failed to update admins", description: "Could not save admin changes.", variant: "destructive" });
    }
  };

  // Render skeleton placeholders while event data is loading.
  if (loading) {
    return (
      <div className="container max-w-3xl mx-auto px-4 py-8">
        <div className="h-6 w-40 bg-muted rounded animate-pulse mb-6" />
        <div className="rounded-lg border p-6 space-y-4">
          <div className="h-10 bg-muted rounded animate-pulse" />
          <div className="h-32 bg-muted rounded animate-pulse" />
          <div className="h-10 bg-muted rounded animate-pulse" />
        </div>
      </div>
    );
  }

  // Render fallback content when no event is found.
  if (!eventAgent) {
    return (
      <div className="container max-w-3xl mx-auto px-4 py-8 space-y-4">
        <Button variant="ghost" onClick={() => router.back()}>
          <ChevronLeft className="mr-2 h-4 w-4" />Back
        </Button>
        <p className="text-sm text-muted-foreground">Event not found.</p>
      </div>
    );
  }

  return (
    <div className="container max-w-3xl mx-auto px-4 py-8 space-y-6">
      <Button variant="ghost" onClick={() => router.back()} className="pl-0">
        <ChevronLeft className="mr-2 h-4 w-4" />Back
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>Edit Event</CardTitle>
          <CardDescription>Update the details for your event</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Event Name</Label>
              <Input id="name" placeholder="Enter event title" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" placeholder="Describe your event" className="min-h-[100px]" value={description} onChange={(e) => setDescription(e.target.value)} rows={5} required />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="date">Date</Label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                  <Input id="date" type="date" className="pl-10" value={date} onChange={(e) => setDate(e.target.value)} required />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="time">Time</Label>
                <div className="relative">
                  <Clock className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                  <Input id="time" type="time" className="pl-10" value={time} onChange={(e) => setTime(e.target.value)} required />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-type">Event Type</Label>
              <Select value={eventType} onValueChange={(v) => setEventType(v as "in-person" | "online")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select event type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="in-person">In-Person</SelectItem>
                  <SelectItem value="online">Online</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              Locale is managed through the Visibility Scope picker below.
            </div>

            <div className="space-y-2">
              <Label htmlFor="event-location">
                {eventType === "online" ? "Meeting Link/Platform" : "Location"}
              </Label>
              <div className="relative">
                <MapPin className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                {eventType === "online" ? (
                  <Input
                    id="event-location"
                    placeholder="Zoom, Meet, or platform link"
                    className="pl-10"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                  />
                ) : (
                  <LocationAutocompleteInput
                    id="event-location"
                    value={location}
                    onValueChange={setLocation}
                    placeholder="Search address or place"
                    inputClassName="pl-10"
                  />
                )}
              </div>
            </div>

            {/* Venue Booking Section - Only show for in-person events */}
            {eventType === "in-person" && (
              <div className="space-y-4 border-t pt-4">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4" />
                  <Label className="text-base font-medium">Venue Booking (Optional)</Label>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="venue-select">Select Venue</Label>
                  <SearchableSelect
                    value={selectedVenue}
                    onChange={setSelectedVenue}
                    placeholder="Choose a venue to book"
                    searchPlaceholder="Search venues..."
                    emptyLabel="No venues found."
                    options={[
                      { value: "none", label: "No venue booking" },
                      ...liveVenueResources.map((resource) => {
                        const meta = (resource.metadata ?? {}) as Record<string, unknown>;
                        const venue = (meta.venue ?? {}) as Record<string, unknown>;
                        const venueName = String(venue.name ?? resource.name);
                        const hourlyRate = Number(venue.hourlyRate ?? meta.price ?? 0);
                        const capacity = Number(venue.capacity ?? 0);
                        return {
                          value: resource.id,
                          label: venueName,
                          description: `$${hourlyRate}/hour${capacity > 0 ? ` • Capacity ${capacity}` : ""}`,
                        };
                      }),
                    ]}
                  />
                </div>

                {selectedVenue && selectedVenue !== "none" && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="venue-start-time">Start Time</Label>
                      <div className="relative">
                        <Clock className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                        <Input
                          id="venue-start-time"
                          type="time"
                          className="pl-10"
                          value={venueStartTime}
                          onChange={(e) => setVenueStartTime(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="venue-end-time">End Time</Label>
                      <div className="relative">
                        <Clock className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                        <Input
                          id="venue-end-time"
                          type="time"
                          className="pl-10"
                          value={venueEndTime}
                          onChange={(e) => setVenueEndTime(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {selectedVenue && selectedVenue !== "none" && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    {(() => {
                      const selected = liveVenueResources.find((resource) => resource.id === selectedVenue);
                      if (!selected) return null;
                      const meta = (selected.metadata ?? {}) as Record<string, unknown>;
                      const venue = (meta.venue ?? {}) as Record<string, unknown>;
                      const venueName = String(venue.name ?? selected.name);
                      const venueLocation = String(venue.location ?? meta.location ?? "");
                      const venueAmenities = Array.isArray(venue.amenities) ? (venue.amenities as string[]) : [];
                      const hourlyRate = Number(venue.hourlyRate ?? meta.price ?? 0);

                      const startTimeParsed = venueStartTime ? new Date(`2000-01-01T${venueStartTime}`) : null;
                      const endTimeParsed = venueEndTime ? new Date(`2000-01-01T${venueEndTime}`) : null;
                      const hours = startTimeParsed && endTimeParsed ?
                        Math.max(1, Math.ceil((endTimeParsed.getTime() - startTimeParsed.getTime()) / (1000 * 60 * 60))) : 1;
                      const totalCost = hourlyRate * hours;

                      return (
                        <div className="space-y-2">
                          <h4 className="font-medium text-blue-900">Booking Summary</h4>
                          <div className="text-sm text-blue-800">
                            <p><strong>Venue:</strong> {venueName}</p>
                            <p><strong>Location:</strong> {venueLocation || "Not specified"}</p>
                            <p><strong>Duration:</strong> {hours} hour{hours !== 1 ? 's' : ''}</p>
                            <p><strong>Total Cost:</strong> ${totalCost}</p>
                            {venueAmenities.length > 0 && (
                              <p><strong>Amenities:</strong> {venueAmenities.join(', ')}</p>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="edit-post-event-as-group"
                    checked={postEventAsGroup}
                    onCheckedChange={(checked) => {
                      const next = checked === true;
                      setPostEventAsGroup(next);
                      if (!next) {
                        setEventGroup("none");
                        setEventProject("none");
                      }
                    }}
                  />
                  <Label htmlFor="edit-post-event-as-group" className="text-sm font-normal">
                    Post event as a group
                  </Label>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="event-group">
                    {postEventAsGroup ? "Publishing Group" : "Associated Group (optional)"}
                  </Label>
                  <SearchableSelect
                    value={eventGroup}
                    onChange={handleEventGroupChange}
                    placeholder={postEventAsGroup ? "Select your group" : "Select group"}
                    searchPlaceholder="Search groups..."
                    emptyLabel="No groups found."
                    options={[
                      { value: "none", label: postEventAsGroup ? "Select a group" : "No group association" },
                      ...(postEventAsGroup ? manageableGroups : liveGroups).map((group) => ({
                        value: group.id,
                        label: group.name,
                        description: "description" in group ? (group.description ?? undefined) : undefined,
                      })),
                    ]}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="event-project">Associated Project (optional)</Label>
                <SearchableSelect
                  value={eventProject}
                  onChange={setEventProject}
                  disabled={!eventGroup || eventGroup === "none"}
                  placeholder={eventGroup && eventGroup !== "none" ? "Select project" : "Select group first"}
                  searchPlaceholder="Search projects..."
                  emptyLabel="No projects found."
                  options={[
                    { value: "none", label: "No project association" },
                    ...eventGroupProjects.map((project) => ({
                      value: project.id,
                      label: project.name,
                    })),
                  ]}
                />
              </div>
            </div>

            <Separator />

            <VisibilityScopeSelector
              value={eventVisibilityScope}
              onChange={setEventVisibilityScope}
              locales={localeData.locales.map((l) => ({ id: l.id, name: l.name }))}
            />

            <div className="flex items-center space-x-2">
              <Checkbox
                id="event-global"
                checked={isGlobal}
                onCheckedChange={(checked) => setIsGlobal(checked === true)}
              />
              <Label htmlFor="event-global" className="flex items-center gap-2 text-sm font-normal cursor-pointer">
                <Globe className="h-4 w-4 text-muted-foreground" />
                Show globally
              </Label>
              <span className="text-xs text-muted-foreground">
                Visible to everyone on the home feed
              </span>
            </div>

            <Separator />

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Tickets</Label>
                  <p className="text-xs text-muted-foreground">Add and edit ticket tiers for this event.</p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addEventTicket}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Ticket
                </Button>
              </div>
              <div className="space-y-3">
                {eventTickets.map((ticket, index) => (
                  <div key={ticket.id} className="rounded-lg border p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Ticket {index + 1}</p>
                      {eventTickets.length > 1 ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => removeEventTicket(ticket.id)}>
                          <X className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Ticket Name</Label>
                        <Input value={ticket.name} onChange={(e) => updateEventTicket(ticket.id, "name", e.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label>Quantity</Label>
                        <Input type="number" min="0" value={ticket.quantity} onChange={(e) => updateEventTicket(ticket.id, "quantity", e.target.value)} placeholder="Unlimited" />
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Price</Label>
                        <div className="relative">
                          <DollarSign className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                          <Input className="pl-10" value={ticket.price} onChange={(e) => updateEventTicket(ticket.id, "price", e.target.value)} placeholder="0.00" />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Description</Label>
                        <Input value={ticket.description} onChange={(e) => updateEventTicket(ticket.id, "description", e.target.value)} placeholder="What does this ticket include?" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <Separator />
            <EftPicker value={eftValues} onChange={setEftValues} capitalValue={capitalValues} onCapitalChange={setCapitalValues} auditValue={auditValues} onAuditChange={setAuditValues} />

            <div className="space-y-2">
              <Label>Event Image</Label>
              <div className="border-2 border-dashed rounded-md p-6 flex flex-col items-center justify-center cursor-pointer hover:bg-gray-50">
                <ImageIcon className="h-8 w-8 text-gray-400 mb-2" />
                <p className="text-sm text-gray-500">Click to upload an image</p>
                <p className="text-xs text-gray-400 mt-1">PNG, JPG up to 5MB</p>
              </div>
            </div>
          </form>
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button onClick={(e) => handleSubmit(e as unknown as React.FormEvent)} disabled={saving || !canSubmit}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
          <Button variant="outline" onClick={() => router.push(`/events/${id}`)}>
            Cancel
          </Button>
        </CardFooter>
      </Card>

      {/* Admin management panel for the event */}
      <AdminManager
        entityId={id}
        entityType="event"
        admins={eventAdminIds}
        creator={eventCreatorId}
        onAdminChange={handleAdminChange}
        members={eventMembers}
      />

      {/* Subscription gate dialog for paid ticket pricing on event edit. */}
      <Dialog open={showMembershipGate} onOpenChange={setShowMembershipGate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Subscription Required For Paid Tickets</DialogTitle>
            <DialogDescription>
              Your event was saved, but selling tickets requires an active membership.
              Start a free 1-month trial or subscribe now to create the ticket listing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowMembershipGate(false)}
              disabled={isMembershipActionPending}
            >
              Not Now
            </Button>
            <Button
              variant="outline"
              onClick={handleSubscribeForTickets}
              disabled={isMembershipActionPending}
            >
              {isMembershipActionPending ? "Processing..." : "Subscribe"}
            </Button>
            <Button
              onClick={handleStartFreeTrial}
              disabled={isMembershipActionPending}
            >
              {isMembershipActionPending ? "Processing..." : "Try Free For 1 Month"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
