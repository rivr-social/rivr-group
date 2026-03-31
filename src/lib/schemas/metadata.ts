/**
 * Zod schemas for resource metadata validation.
 *
 * Purpose:
 * - Provides typed schemas for each resource type's metadata shape.
 * - Enables runtime validation at query boundaries.
 * - Exports a `parseMetadata` helper that returns typed metadata from raw JSONB.
 * - Exports `getTypedMetadata` for convenient typed access without validation errors.
 *
 * All fields are optional since metadata is sparse and incrementally populated.
 *
 * Dependencies:
 * - `zod` for schema declaration and inference.
 * - `@/db/schema` for the `ResourceType` union.
 */

import * as z from "zod";
import type { ResourceType } from "@/db/schema";

// ---------------------------------------------------------------------------
// Resource metadata schemas
// ---------------------------------------------------------------------------

export const EventMetadataSchema = z.object({
  entityType: z.string().optional(),
  resourceKind: z.string().optional(),
  date: z.string().optional(),
  time: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  location: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  eventType: z.string().optional(),
  price: z.union([z.number(), z.string(), z.null()]).optional(),
  capacity: z.number().optional(),
  rsvpCount: z.number().optional(),
  attendeeCount: z.number().optional(),
  status: z.string().optional(),
  groupId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  venueId: z.string().nullable().optional(),
  venueStartTime: z.string().nullable().optional(),
  venueEndTime: z.string().nullable().optional(),
  organizerId: z.string().optional(),
  creatorId: z.string().optional(),
  adminIds: z.array(z.string()).optional(),
  chapterTags: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  images: z.array(z.string()).optional(),
}).passthrough();

export const JobMetadataSchema = z.object({
  resourceKind: z.string().optional(),
  projectId: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  company: z.string().optional(),
  employmentType: z.string().optional(),
  salary: z.union([z.number(), z.string()]).optional(),
  skills: z.array(z.string()).optional(),
  requiredBadges: z.array(z.string()).optional(),
  maxAssignees: z.number().nullable().optional(),
  chapterTags: z.array(z.string()).optional(),
}).passthrough();

export const ShiftMetadataSchema = z.object({
  resourceKind: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  role: z.string().optional(),
  assignedTo: z.string().nullable().optional(),
  status: z.string().optional(),
  jobId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
}).passthrough();

export const BadgeMetadataSchema = z.object({
  resourceKind: z.string().optional(),
  category: z.string().optional(),
  level: z.union([z.string(), z.number()]).optional(),
  requirements: z.array(z.string()).optional(),
  trainingModules: z.array(z.string()).optional(),
  groupId: z.string().nullable().optional(),
  chapterTags: z.array(z.string()).optional(),
}).passthrough();

export const DocumentMetadataSchema = z.object({
  resourceKind: z.string().optional(),
  resourceSubtype: z.string().optional(),
  format: z.string().optional(),
  size: z.number().optional(),
  author: z.string().optional(),
  version: z.union([z.string(), z.number()]).optional(),
  groupId: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  createdBy: z.string().optional(),
  showOnAbout: z.boolean().optional(),
}).passthrough();

export const ListingMetadataSchema = z.object({
  entityType: z.string().optional(),
  resourceKind: z.string().optional(),
  listingType: z.string().optional(),
  listingKind: z.string().optional(),
  offerType: z.string().optional(),
  price: z.union([z.number(), z.string()]).optional(),
  condition: z.string().nullable().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  location: z.string().optional(),
  images: z.array(z.string()).optional(),
  sellerName: z.string().optional(),
  chapterTags: z.array(z.string()).optional(),
}).passthrough();

export const VoucherMetadataSchema = z.object({
  resourceKind: z.string().optional(),
  value: z.union([z.number(), z.string()]).optional(),
  currency: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
  issuerId: z.string().optional(),
  status: z.string().optional(),
  redeemedBy: z.string().nullable().optional(),
  redeemedAt: z.string().nullable().optional(),
}).passthrough();

export const ProjectMetadataSchema = z.object({
  entityType: z.string().optional(),
  resourceKind: z.string().optional(),
  category: z.string().optional(),
  groupId: z.string().nullable().optional(),
  status: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  deadline: z.string().nullable().optional(),
  budget: z.number().nullable().optional(),
  milestones: z.array(z.unknown()).optional(),
  jobs: z.array(z.unknown()).optional(),
  creatorId: z.string().optional(),
  memberCount: z.number().optional(),
  venueId: z.string().nullable().optional(),
  venueStartTime: z.string().nullable().optional(),
  venueEndTime: z.string().nullable().optional(),
  chapterTags: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
}).passthrough();

export const ProposalMetadataSchema = z.object({
  resourceKind: z.string().optional(),
  status: z.string().optional(),
  votesFor: z.number().optional(),
  votesAgainst: z.number().optional(),
  deadline: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
  creatorId: z.string().optional(),
  chapterTags: z.array(z.string()).optional(),
}).passthrough();

export const PostMetadataSchema = z.object({
  entityType: z.string().optional(),
  postType: z.string().optional(),
  isLiveInvitation: z.boolean().optional(),
  linkedOfferingId: z.string().nullable().optional(),
  eventId: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  images: z.array(z.string()).optional(),
  likes: z.number().optional(),
  commentCount: z.number().optional(),
  authorName: z.string().optional(),
  chapterTags: z.array(z.string()).optional(),
  groupTags: z.array(z.string()).optional(),
}).passthrough();

export const TaskMetadataSchema = z.object({
  resourceKind: z.string().optional(),
  projectId: z.string().nullable().optional(),
  jobId: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
  estimatedTime: z.union([z.number(), z.string()]).nullable().optional(),
  points: z.number().nullable().optional(),
  required: z.boolean().optional(),
  chapterTags: z.array(z.string()).optional(),
}).passthrough();

export const AssetMetadataSchema = z.object({
  resourceKind: z.string().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  assetValue: z.union([z.number(), z.string()]).optional(),
  value: z.union([z.number(), z.string()]).optional(),
  location: z.string().optional(),
  restrictions: z.array(z.string()).optional(),
  images: z.array(z.string()).optional(),
  currentUserId: z.string().optional(),
  currentUseStartDate: z.string().optional(),
  currentUseEndDate: z.string().optional(),
  maintenanceNotes: z.string().optional(),
  usageInstructions: z.string().optional(),
  bookingRequired: z.boolean().optional(),
  entityType: z.string().optional(),
}).passthrough();

export const VenueMetadataSchema = z.object({
  resourceKind: z.string().optional(),
  isVenue: z.boolean().optional(),
  venue: z.record(z.string(), z.unknown()).optional(),
  price: z.union([z.number(), z.string()]).optional(),
  location: z.string().optional(),
  hourlyRate: z.number().optional(),
}).passthrough();

/** Fallback schema for resource types without a dedicated metadata shape. */
export const GenericMetadataSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type EventMetadata = z.infer<typeof EventMetadataSchema>;
export type JobMetadata = z.infer<typeof JobMetadataSchema>;
export type ShiftMetadata = z.infer<typeof ShiftMetadataSchema>;
export type BadgeMetadata = z.infer<typeof BadgeMetadataSchema>;
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;
export type ListingMetadata = z.infer<typeof ListingMetadataSchema>;
export type VoucherMetadata = z.infer<typeof VoucherMetadataSchema>;
export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;
export type ProposalMetadata = z.infer<typeof ProposalMetadataSchema>;
export type PostMetadata = z.infer<typeof PostMetadataSchema>;
export type TaskMetadata = z.infer<typeof TaskMetadataSchema>;
export type AssetMetadata = z.infer<typeof AssetMetadataSchema>;
export type VenueMetadata = z.infer<typeof VenueMetadataSchema>;

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

/**
 * Maps resource type discriminators to their metadata Zod schema.
 *
 * Resource types without a dedicated schema fall through to `GenericMetadataSchema`.
 */
const METADATA_SCHEMAS: Partial<Record<ResourceType, z.ZodType>> = {
  event: EventMetadataSchema,
  job: JobMetadataSchema,
  shift: ShiftMetadataSchema,
  badge: BadgeMetadataSchema,
  document: DocumentMetadataSchema,
  listing: ListingMetadataSchema,
  voucher: VoucherMetadataSchema,
  project: ProjectMetadataSchema,
  proposal: ProposalMetadataSchema,
  post: PostMetadataSchema,
  task: TaskMetadataSchema,
  asset: AssetMetadataSchema,
  venue: VenueMetadataSchema,
};

// ---------------------------------------------------------------------------
// Type mapping for parseMetadata return types
// ---------------------------------------------------------------------------

type MetadataTypeMap = {
  event: EventMetadata;
  job: JobMetadata;
  shift: ShiftMetadata;
  badge: BadgeMetadata;
  document: DocumentMetadata;
  listing: ListingMetadata;
  voucher: VoucherMetadata;
  project: ProjectMetadata;
  proposal: ProposalMetadata;
  post: PostMetadata;
  task: TaskMetadata;
  asset: AssetMetadata;
  venue: VenueMetadata;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses raw JSONB metadata against the schema for a given resource type.
 *
 * @param type Resource type discriminator.
 * @param metadata Raw metadata from the database (typically `Record<string, unknown>`).
 * @returns A Zod `SafeParseReturnType` containing either typed `data` or validation `error`.
 *
 * @example
 * ```ts
 * const result = parseMetadata("event", resource.metadata);
 * if (result.success) {
 *   console.log(result.data.date); // typed as string | undefined
 * }
 * ```
 */
export function parseMetadata<T extends keyof MetadataTypeMap>(
  type: T,
  metadata: unknown,
): z.ZodSafeParseResult<MetadataTypeMap[T]>;
export function parseMetadata(
  type: ResourceType,
  metadata: unknown,
): z.ZodSafeParseResult<Record<string, unknown>>;
export function parseMetadata(
  type: ResourceType,
  metadata: unknown,
): z.ZodSafeParseResult<Record<string, unknown>> {
  const schema = METADATA_SCHEMAS[type] ?? GenericMetadataSchema;
  return schema.safeParse(metadata ?? {}) as z.ZodSafeParseResult<Record<string, unknown>>;
}

/**
 * Returns typed metadata for a resource, falling back to an empty object on validation failure.
 *
 * This is the recommended accessor for components that want typed metadata without
 * handling validation errors. Invalid or missing metadata silently returns `{}`.
 *
 * @param type Resource type discriminator.
 * @param metadata Raw metadata from the database.
 * @returns Typed metadata object, or empty object if parsing fails.
 *
 * @example
 * ```ts
 * const meta = getTypedMetadata("event", resource.metadata);
 * const date = meta.date; // string | undefined — fully typed
 * ```
 */
export function getTypedMetadata<T extends keyof MetadataTypeMap>(
  type: T,
  metadata: unknown,
): MetadataTypeMap[T];
export function getTypedMetadata(
  type: ResourceType,
  metadata: unknown,
): Record<string, unknown>;
export function getTypedMetadata(
  type: ResourceType,
  metadata: unknown,
): Record<string, unknown> {
  const result = parseMetadata(type, metadata);
  return result.success ? (result.data as Record<string, unknown>) : {};
}

/**
 * Returns the Zod schema for a given resource type, or the generic fallback.
 *
 * Useful for callers that want to compose validation logic or inspect schema shape.
 */
export function getMetadataSchema(type: ResourceType): z.ZodType {
  return METADATA_SCHEMAS[type] ?? GenericMetadataSchema;
}
