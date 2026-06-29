/**
 * @file to-ledger-filter.ts — FindStatement → structured LedgerFilter.
 *
 * Compiles a typechecked {@link FindStatement} into a structured filter shape
 * the read layer can apply. The codebase has NO single typed `LedgerFilter`
 * (plan §3.1): reads go through the permission-aware `q()` and bespoke ledger
 * SQL (`is_active`, `verb IN (...)`, `subject_id`/`object_id`). This compiler
 * therefore emits a neutral, explicit filter object whose fields line up 1:1
 * with those read primitives, so the executor can translate it into a `q()` call
 * (for agent/resource listings) or a ledger `verb`/`subject`/`object` query.
 *
 * Permission filtering is NOT applied here — it happens inside `q()`/the ledger
 * read when this filter is executed (plan §8). Deictic filters are grounded
 * against the {@link ParseContext} so the query never silently widens.
 *
 * @dependencies ./..ast, ./..context. No db/IO.
 */

import {
  AGENT_KINDS,
  DEICTIC_REFS,
  RESOURCE_KINDS,
  SEMANTIC_DOMAINS,
  type FindStatement,
} from "../ast";
import { bindDeictic, type ParseContext } from "../context";

/** Specific compile error codes. */
export const LEDGER_FILTER_ERROR_CODES = {
  UNBOUND_DEICTIC_FILTER: "UNBOUND_DEICTIC_FILTER",
} as const;

export type LedgerFilterErrorCode =
  (typeof LEDGER_FILTER_ERROR_CODES)[keyof typeof LEDGER_FILTER_ERROR_CODES];

export class LedgerFilterCompileError extends Error {
  readonly code: LedgerFilterErrorCode;
  readonly source?: string;
  constructor(code: LedgerFilterErrorCode, message: string, source?: string) {
    super(message);
    this.name = "LedgerFilterCompileError";
    this.code = code;
    this.source = source;
  }
}

/**
 * Structured filter aligned with the read primitives:
 *  - `domain` chooses the listing source (agents vs resources).
 *  - `dbType` narrows the agent_type / resource_type when known.
 *  - `verb` + `subjectId`/`objectId` map onto a ledger `verb IN (...)` query.
 *  - `localeId` maps onto locale-scoped reads.
 */
export interface LedgerFilter {
  domain: "agent" | "resource" | "ledger";
  /** Concrete db type to narrow by (e.g. "event", "organization"), if known. */
  dbType?: string;
  /** Ledger verb to constrain on (e.g. "create", "join"). */
  verb?: string;
  /** Grounded subject id (who) from a deictic/named subject filter. */
  subjectId?: string;
  /** Grounded object id (what) from a deictic/named object filter. */
  objectId?: string;
  /** Grounded locale id from a `here` deictic. */
  localeId?: string;
  /** Default result cap, mirrors composer reads. */
  limit: number;
  /** The original input for audit/telemetry. */
  originalInput: string;
}

const DEFAULT_FIND_LIMIT = 200;

/**
 * Map a clean agent/resource kind to a concrete db type string for narrowing.
 * Group is not an agent_type — narrowing by it is left to the executor (it spans
 * organization/community/family), so a group kind yields no dbType.
 */
function kindToDbType(kind: string | undefined): string | undefined {
  if (!kind) return undefined;
  switch (kind) {
    case RESOURCE_KINDS.PROJECT:
      return "project";
    case RESOURCE_KINDS.EVENT:
      return "event";
    case RESOURCE_KINDS.PLACE:
      return "place";
    case RESOURCE_KINDS.POST:
      return "post";
    case RESOURCE_KINDS.LISTING:
      return "listing";
    case RESOURCE_KINDS.TASK:
      return "task";
    case AGENT_KINDS.PERSON:
      return "person";
    // Group spans multiple agent_types → no single narrow; executor handles it.
    default:
      return undefined;
  }
}

/**
 * Compile a {@link FindStatement} into a {@link LedgerFilter}.
 *
 * @param statement A typechecked find statement.
 * @param context Grounding context for deictic filters.
 * @param originalInput Verbatim user input.
 * @throws {LedgerFilterCompileError} when a deictic filter cannot be grounded.
 */
export function compileToLedgerFilter(
  statement: FindStatement,
  context: ParseContext,
  originalInput: string,
): LedgerFilter {
  const domain =
    statement.verb
      ? "ledger"
      : statement.domain === SEMANTIC_DOMAINS.AGENT
        ? "agent"
        : "resource";

  const filter: LedgerFilter = {
    domain,
    ...(kindToDbType(statement.kind_) ? { dbType: kindToDbType(statement.kind_) } : {}),
    ...(statement.verb?.verbType ? { verb: statement.verb.verbType } : {}),
    limit: DEFAULT_FIND_LIMIT,
    originalInput,
  };

  for (const f of statement.filters) {
    if (f.deictic) {
      const binding = bindDeictic(f.deictic, context);
      if (binding.unbound) {
        throw new LedgerFilterCompileError(
          LEDGER_FILTER_ERROR_CODES.UNBOUND_DEICTIC_FILTER,
          `Cannot ground filter "${f.source}": ${binding.reason}.`,
          f.source,
        );
      }
      // self/group → subject (who); here → locale; this/them → object.
      if (f.deictic === DEICTIC_REFS.SELF || f.deictic === DEICTIC_REFS.GROUP) {
        if (binding.resolvedId) filter.subjectId = binding.resolvedId;
      } else if (f.deictic === DEICTIC_REFS.HERE) {
        if (binding.resolvedId) filter.localeId = binding.resolvedId;
      } else if (
        f.deictic === DEICTIC_REFS.THIS ||
        f.deictic === DEICTIC_REFS.THEM
      ) {
        if (binding.resolvedId) filter.objectId = binding.resolvedId;
      }
    }
  }

  return filter;
}
