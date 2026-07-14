/**
 * Pure breadcrumb-chain helpers for the hierarchical navigation breadcrumb
 * (group → subgroup → project → job). No React, no DB — just the containment
 * chain math so it can be unit-tested in isolation and reused by the reusable
 * {@link file://../components/nav-breadcrumbs.tsx} component.
 *
 * A breadcrumb chain is ROOT-FIRST: the outermost container first, the current
 * page last. The current page carries no `href` (it is where you already are).
 */

/** One node in a breadcrumb chain. */
export interface BreadcrumbNode {
  /** Stable id (agent/resource id) — used as the React key and for dedup. */
  readonly id?: string;
  /** Human-readable label. */
  readonly label: string;
  /** Destination; omit for the current (last) page. */
  readonly href?: string;
}

/** A rendered breadcrumb slot: a single crumb, or a collapsed ellipsis group. */
export type BreadcrumbSlot =
  | { readonly kind: "crumb"; readonly node: BreadcrumbNode }
  | { readonly kind: "ellipsis"; readonly nodes: readonly BreadcrumbNode[] };

/** Default number of crumbs shown before the middle collapses to an ellipsis. */
export const DEFAULT_MAX_VISIBLE = 4;

/**
 * Builds a root-first containment chain from an ancestor list plus the current
 * page. Empty/whitespace labels are dropped, and consecutive duplicate ids are
 * collapsed (a page whose nearest ancestor IS itself shouldn't render twice).
 *
 * @param ancestorsRootFirst Ancestors ordered outermost → innermost (NOT
 *   including the current page). Pass `[]` for a top-level page.
 * @param current The current page (rendered last, without an href).
 * @returns Ordered, cleaned breadcrumb nodes (root-first, current last).
 */
export function buildContainmentChain(
  ancestorsRootFirst: readonly BreadcrumbNode[],
  current: BreadcrumbNode,
): BreadcrumbNode[] {
  const chain: BreadcrumbNode[] = [];
  const push = (node: BreadcrumbNode) => {
    if (!node.label || !node.label.trim()) return;
    const prev = chain[chain.length - 1];
    if (prev && node.id && prev.id === node.id) return; // collapse repeats
    chain.push(node);
  };
  for (const ancestor of ancestorsRootFirst) push(ancestor);
  // The current page is terminal: never a link, regardless of any href passed.
  push({ id: current.id, label: current.label });
  return chain;
}

/**
 * Collapses a long chain so at most `maxVisible` crumbs render: the first crumb,
 * an ellipsis standing in for the hidden middle, then the trailing crumbs
 * (always including the current page). Short chains pass through unchanged.
 *
 * @param nodes Root-first breadcrumb nodes.
 * @param maxVisible Max crumbs to show (>= 2; clamped). Default {@link DEFAULT_MAX_VISIBLE}.
 * @returns Ordered slots ready to render.
 */
export function collapseBreadcrumbs(
  nodes: readonly BreadcrumbNode[],
  maxVisible: number = DEFAULT_MAX_VISIBLE,
): BreadcrumbSlot[] {
  const limit = Math.max(2, Math.floor(maxVisible));
  if (nodes.length <= limit) {
    return nodes.map((node) => ({ kind: "crumb", node }));
  }
  // Reserve one slot for the head crumb + one for the ellipsis; the rest is the
  // trailing run, which must always include the current page (>= 1).
  const tailCount = Math.max(1, limit - 2);
  const head = nodes[0];
  const tail = nodes.slice(nodes.length - tailCount);
  const hidden = nodes.slice(1, nodes.length - tailCount);
  return [
    { kind: "crumb", node: head },
    { kind: "ellipsis", nodes: hidden },
    ...tail.map((node): BreadcrumbSlot => ({ kind: "crumb", node })),
  ];
}
