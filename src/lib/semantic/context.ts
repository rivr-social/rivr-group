/**
 * @file ParseContext — the deixis grounding required so pronouns don't hallucinate.
 *
 * The parser emits deictic slots (self/group/this/them/here/now) but cannot
 * ground them. The {@link ParseContext} supplies the speaker (`actorId`), their
 * current locale (`here`), the clock (`now`), the active group scope, and a
 * short history of recently-referenced entities. The typechecker/resolver binds
 * deictic slots against this context.
 *
 * Per the v1 plan §2 + §8: a natural-language intent is just an ambient claim;
 * grounding it against a verified principal's context is the first gate before
 * resolution and permission checks.
 *
 * @dependencies none (pure types + helpers; no db/IO)
 */

import { DEICTIC_REFS, type DeicticRef, type SemanticDomain } from "./ast";

/** A recently-referenced entity, newest first, for "this/that/them" resolution. */
export interface RecentEntity {
  id: string;
  name: string;
  domain: SemanticDomain;
  /** Optional kind hint to disambiguate ("that event" vs "that group"). */
  kind?: string;
}

/**
 * Grounding context for a single parse. REQUIRED — without it, deictic slots
 * cannot be bound and the parser refuses to resolve them (returns them
 * unbound), never inventing an identity.
 */
export interface ParseContext {
  /** The verified principal speaking (the session user's agent id). */
  actorId: string;
  /** The speaker's current locale id ("here"). May be absent if no locale set. */
  here?: string;
  /** The reference clock for "now"/relative dates. */
  now: Date;
  /** The active group the speaker is operating within ("we"/"our"). */
  groupScope?: string;
  /** Recently-referenced entities, newest first (for this/that/them/it). */
  recentEntities: RecentEntity[];
}

/** Result of binding a single deictic reference against the context. */
export interface DeicticBinding {
  ref: DeicticRef;
  /** Resolved id (agent id / locale id), if the context could supply one. */
  resolvedId?: string;
  /** Resolved literal (e.g. ISO timestamp for `now`). */
  resolvedValue?: string;
  /** True when the context lacked the data to bind this reference. */
  unbound: boolean;
  /** Reason when unbound (specific, for explain/debug). */
  reason?: string;
}

/** Reasons a deictic reference could not be bound. */
export const DEICTIC_UNBOUND_REASONS = {
  NO_LOCALE: "context has no `here` locale to bind",
  NO_GROUP_SCOPE: "context has no active group scope to bind `we`/`our`",
  NO_RECENT_ENTITY: "context has no recent entity to bind `this`/`that`/`it`",
  NO_RECENT_SET: "context has no recent entity set to bind `them`/`those`",
  UNKNOWN_REF: "unknown deictic reference",
} as const;

/**
 * Bind a single deictic reference against a {@link ParseContext}. Pure: never
 * touches the db, never invents identity. When the context lacks the data, the
 * binding is returned `unbound` with a specific reason — the caller decides
 * whether that is fatal.
 */
export function bindDeictic(
  ref: DeicticRef,
  context: ParseContext,
): DeicticBinding {
  switch (ref) {
    case DEICTIC_REFS.SELF:
      return { ref, resolvedId: context.actorId, unbound: false };

    case DEICTIC_REFS.GROUP:
      if (!context.groupScope) {
        return {
          ref,
          unbound: true,
          reason: DEICTIC_UNBOUND_REASONS.NO_GROUP_SCOPE,
        };
      }
      return { ref, resolvedId: context.groupScope, unbound: false };

    case DEICTIC_REFS.HERE:
      if (!context.here) {
        return {
          ref,
          unbound: true,
          reason: DEICTIC_UNBOUND_REASONS.NO_LOCALE,
        };
      }
      return { ref, resolvedId: context.here, unbound: false };

    case DEICTIC_REFS.NOW:
      return {
        ref,
        resolvedValue: context.now.toISOString(),
        unbound: false,
      };

    case DEICTIC_REFS.THIS: {
      const recent = context.recentEntities[0];
      if (!recent) {
        return {
          ref,
          unbound: true,
          reason: DEICTIC_UNBOUND_REASONS.NO_RECENT_ENTITY,
        };
      }
      return { ref, resolvedId: recent.id, unbound: false };
    }

    case DEICTIC_REFS.THEM: {
      if (context.recentEntities.length === 0) {
        return {
          ref,
          unbound: true,
          reason: DEICTIC_UNBOUND_REASONS.NO_RECENT_SET,
        };
      }
      // "them" binds to the most-recent referenced entity as the set anchor.
      return { ref, resolvedId: context.recentEntities[0].id, unbound: false };
    }

    default:
      return {
        ref,
        unbound: true,
        reason: DEICTIC_UNBOUND_REASONS.UNKNOWN_REF,
      };
  }
}

/** Build a minimal context for the common single-speaker case. */
export function makeContext(
  actorId: string,
  opts: Partial<Omit<ParseContext, "actorId">> = {},
): ParseContext {
  return {
    actorId,
    here: opts.here,
    now: opts.now ?? new Date(),
    groupScope: opts.groupScope,
    recentEntities: opts.recentEntities ?? [],
  };
}
