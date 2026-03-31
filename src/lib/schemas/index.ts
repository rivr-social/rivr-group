/**
 * Schema barrel export.
 *
 * Re-exports all metadata schemas, inferred types, and helpers.
 */
export {
  // Schemas
  EventMetadataSchema,
  JobMetadataSchema,
  ShiftMetadataSchema,
  BadgeMetadataSchema,
  DocumentMetadataSchema,
  ListingMetadataSchema,
  VoucherMetadataSchema,
  ProjectMetadataSchema,
  ProposalMetadataSchema,
  PostMetadataSchema,
  TaskMetadataSchema,
  AssetMetadataSchema,
  VenueMetadataSchema,
  GenericMetadataSchema,
  // Types
  type EventMetadata,
  type JobMetadata,
  type ShiftMetadata,
  type BadgeMetadata,
  type DocumentMetadata,
  type ListingMetadata,
  type VoucherMetadata,
  type ProjectMetadata,
  type ProposalMetadata,
  type PostMetadata,
  type TaskMetadata,
  type AssetMetadata,
  type VenueMetadata,
  // Helpers
  parseMetadata,
  getTypedMetadata,
  getMetadataSchema,
} from "./metadata";
