import { db } from "@/db";
import { resources } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";

export interface PostOfferingDeal {
  postId: string;
  postTitle: string;
  offeringId: string;
  dealPriceCents: number | null;
}

/**
 * Resolves a post-linked offering deal and validates that the post actually targets the offering.
 */
export async function resolvePostOfferingDeal(
  postId: string,
  offeringId: string,
): Promise<PostOfferingDeal | null> {
  const [post] = await db
    .select({
      id: resources.id,
      name: resources.name,
      type: resources.type,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(and(eq(resources.id, postId), isNull(resources.deletedAt)))
    .limit(1);

  if (!post) return null;

  const meta = (post.metadata ?? {}) as Record<string, unknown>;
  const entityType = String(meta.entityType ?? "").toLowerCase();
  const isPost =
    post.type === "post" ||
    post.type === "note" ||
    entityType === "post";

  if (!isPost) return null;

  const linkedOfferingId = String(meta.linkedOfferingId ?? "");
  if (!linkedOfferingId || linkedOfferingId !== offeringId) {
    return null;
  }

  const totalPriceCents =
    typeof meta.totalPriceCents === "number" && meta.totalPriceCents > 0
      ? meta.totalPriceCents
      : null;

  return {
    postId: post.id,
    postTitle: post.name,
    offeringId: linkedOfferingId,
    dealPriceCents: totalPriceCents,
  };
}
