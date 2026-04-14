// src/lib/federation/cross-instance-types.ts

/**
 * Cross-instance federation types for home authority resolution,
 * remote actor context, and canonical profile references.
 *
 * IMPORTANT: This file mirrors the same contracts in rivr-person and
 * rivr-monorepo until a shared package is extracted.
 */

import type { InstanceType } from "./instance-config";

export type HomeAuthorityRef = {
  homeBaseUrl: string;
  homeAgentId: string;
  homeInstanceType: InstanceType;
  globalIndexAgentId?: string;
  manifestUrl?: string;
  canonicalProfileUrl?: string;
};

export type FederatedActorContext = {
  actorId: string;
  homeBaseUrl: string;
  manifestUrl?: string;
  assertionType: "session" | "token" | "signed";
  assertion: string;
  issuedAt: string;
  expiresAt: string;
  nonce?: string;
};

export type CanonicalProfileRef = {
  agentId: string;
  displayName: string;
  username?: string;
  avatarUrl?: string;
  homeAuthority: HomeAuthorityRef;
  isLocallyHomed: boolean;
  canonicalUrl: string;
  globalIndexUrl?: string;
};

export type ProjectionPointer = {
  rel: string;
  href: string;
  mediaType?: string;
  authority?: "rivr" | "solid" | "external";
};

export type ManifestRef = {
  id?: string | null;
  url?: string | null;
};

export type ProjectedDatapoint = {
  id: string;
  subjectId: string;
  subjectType: "agent" | "resource" | "relationship" | "document_shard";
  projectionKind: "summary" | "detail" | "shard" | "pointer" | "claim";
  authorityNodeId: string;
  authorityBaseUrl: string;
  visibility: "public" | "locale" | "connections" | "self" | "granted";
  publicationSurfaces: string[];
  validFrom?: string | null;
  validUntil?: string | null;
  permissionsBasis: {
    ownership?: boolean;
    directGrant?: boolean;
    relationship?: string[];
    attributePolicies?: string[];
  };
  payload: Record<string, unknown>;
  pointers?: ProjectionPointer[];
  manifest?: ManifestRef;
};

export type UniversalManifestProjection = {
  "@context": string | string[];
  "@id"?: string;
  "@type": string | string[];
  manifestVersion: string;
  subject: Record<string, unknown>;
  claims?: Array<Record<string, unknown>>;
  consents?: Array<Record<string, unknown>>;
  shards?: Array<Record<string, unknown>>;
  pointers?: Array<Record<string, unknown>>;
  validFrom?: string;
  validUntil?: string;
};

export type FederationFacadeResponse = {
  subjectId: string;
  authority: {
    nodeId: string;
    baseUrl: string;
    instanceType: InstanceType;
  };
  projections: ProjectedDatapoint[];
  portableManifestSubset?: UniversalManifestProjection;
  cache: {
    ttlSeconds?: number;
    etag?: string;
  };
};

export type RemoteViewerState =
  | "anonymous"
  | "locally_authenticated"
  | "remotely_authenticated";

export type RemoteAuthResult = {
  success: boolean;
  viewerState: RemoteViewerState;
  sessionToken?: string;
  actorId?: string;
  homeBaseUrl?: string;
  displayName?: string;
  error?: string;
  errorCode?: string;
};

export type FederatedInteractionAction =
  | "connect"
  | "follow"
  | "react"
  | "rsvp"
  | "thanks"
  | "message_thread_start"
  | "membership_request"
  | "kg_push_doc"
  | "kg_query";

export type FederatedInteractionRequest = {
  action: FederatedInteractionAction;
  actor: FederatedActorContext;
  targetAgentId: string;
  targetInstanceNodeId: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
};

export type FederatedInteractionResult = {
  success: boolean;
  action: FederatedInteractionAction;
  data?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
  federationEventEmitted?: boolean;
};
