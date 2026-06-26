/**
 * @fileoverview Shared upsert for provider-mirror document Resources.
 *
 * Both the parachute-mirror lane (Notion/Drive bulk import) and the on-demand
 * lane (Gmail single-item save) mint the same shape: a `document` Resource
 * owned by an agent, carrying a {@link SourceBlock} under `metadata.source`.
 * This module centralizes the find-by-source-block + last-write-wins upsert so
 * the per-provider sync code stays thin and the two lanes can't drift apart.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { resources } from "@/db/schema";
import {
  buildSourceBlock,
  getSourceBlock,
  shouldApplyRemoteUpdate,
  touchSync,
  withSourceBlock,
  type SourceLane,
} from "@/lib/resources/source-block";

/** Result of a single mirror upsert. */
export type MirrorOutcome = "created" | "updated" | "skipped";

/** Input describing one external item to mirror as a `document` Resource. */
export interface MirrorDocumentInput {
  /** Agent that owns the connector and the mirrored Resource. */
  ownerId: string;
  /** Connector provider id (e.g. `notion`, `gmail`). */
  provider: string;
  /** Stable id of the item within the provider. */
  externalId: string;
  /** Ingest lane that owns this mirror. */
  lane: SourceLane;
  /** Display title for the Resource. */
  title: string;
  /** Rendered document body (Markdown/plain text). */
  body: string;
  /** Canonical backlink to the provider item. */
  externalUrl?: string | null;
  /** Provider's last-modified timestamp — the last-write-wins basis. */
  externalUpdatedAt?: string | Date | null;
  /** Tags applied on first import. */
  tags?: string[];
  /** Human-readable provenance category (e.g. `Notion`, `Gmail`). */
  category?: string;
  /** Short description stored on the Resource. */
  description?: string;
  /** Override timestamp (defaults to now). */
  now?: Date;
}

/** Finds an existing mirrored Resource for an external item by its source block. */
export async function findMirroredResourceId(
  ownerId: string,
  provider: string,
  externalId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, ownerId),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->'source'->>'provider' = ${provider}`,
        sql`${resources.metadata}->'source'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Upserts a `document` Resource for one external item, recording provenance in
 * its source block. Idempotent: an unchanged item (per last-write-wins /
 * echo-suppression) returns `"skipped"` and writes nothing.
 *
 * @returns `"created"`, `"updated"`, or `"skipped"`.
 */
export async function upsertMirroredDocument(input: MirrorDocumentInput): Promise<MirrorOutcome> {
  const now = input.now ?? new Date();
  const externalUrl = input.externalUrl ?? null;
  const existingId = await findMirroredResourceId(input.ownerId, input.provider, input.externalId);

  if (existingId) {
    const [existing] = await db
      .select({ metadata: resources.metadata })
      .from(resources)
      .where(eq(resources.id, existingId))
      .limit(1);
    const existingSource = getSourceBlock(existing?.metadata ?? null);
    if (
      existingSource &&
      !shouldApplyRemoteUpdate(existingSource, {
        externalUpdatedAt: input.externalUpdatedAt ?? null,
        content: input.body,
      })
    ) {
      return "skipped";
    }
    const nextSource = existingSource
      ? touchSync(existingSource, {
          provenance: "provider_inbound",
          externalUpdatedAt: input.externalUpdatedAt ?? null,
          content: input.body,
          externalUrl,
        })
      : buildSourceBlock({
          provider: input.provider,
          externalId: input.externalId,
          lane: input.lane,
          externalUrl,
          externalUpdatedAt: input.externalUpdatedAt ?? null,
          content: input.body,
          now,
        });
    await db
      .update(resources)
      .set({
        name: input.title,
        content: input.body,
        contentType: "text/markdown",
        url: externalUrl,
        metadata: withSourceBlock(existing?.metadata ?? null, nextSource),
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  const source = buildSourceBlock({
    provider: input.provider,
    externalId: input.externalId,
    lane: input.lane,
    externalUrl,
    externalUpdatedAt: input.externalUpdatedAt ?? null,
    content: input.body,
    now,
  });
  await db.insert(resources).values({
    name: input.title,
    type: "document",
    description: input.description ?? null,
    content: input.body,
    contentType: "text/markdown",
    url: externalUrl,
    ownerId: input.ownerId,
    visibility: "private",
    tags: input.tags ?? [],
    metadata: withSourceBlock(input.category ? { category: input.category } : {}, source),
  });
  return "created";
}
