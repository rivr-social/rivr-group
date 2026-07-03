"use client"

/**
 * Faceted vault RAIL — the always-on left column of the group Docs module.
 *
 * Renders the group's doc Resources as a faceted virtual filesystem: each doc's
 * `metadata.facetedTags` tag-paths place it under multiple orthogonal folder
 * hierarchies at once. The tree comes from `GET /api/agent-hq/faceted-fs?groupId=…`,
 * which lists docs owned by the group agent and gates on group membership. Tags
 * are an overlay/index only — the same doc can appear under several hierarchies
 * without duplicating the underlying Resource.
 *
 * The rail drives the module in two ways:
 *  - Clicking a folder NAME selects that facet (`onSelectFacet`) so the doc list
 *    on the right filters to it. "All docs" clears the filter (`null`); the
 *    synthetic "Untagged" folder selects the `"__untagged__"` sentinel.
 *  - Clicking a doc LEAF hands off to the group's document viewer (`onOpenDoc`)
 *    — editing/tagging stays on the canonical document surface.
 */

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { ChevronDown, ChevronRight, FileText, FolderOpen, Layers, Loader2 } from "lucide-react"
import { UNTAGGED_FACET_LABEL, type FacetTreeNode } from "@/lib/parachute-doc"

const FACETED_FS_ENDPOINT = "/api/agent-hq/faceted-fs"

/** Sentinel facet value selecting docs that carry no faceted tags. */
export const UNTAGGED_FACET_VALUE = "__untagged__"

interface FacetedVaultPanelProps {
  /** Group whose doc Resources form the vault. */
  groupId: string
  /** Called with a document id when a leaf is selected. */
  onOpenDoc: (docId: string) => void
  /** Called with the selected facet path, `UNTAGGED_FACET_VALUE`, or `null` (all). */
  onSelectFacet: (facet: string | null) => void
  /** Currently selected facet (`null` = all docs). */
  selectedFacet: string | null
}

/** Maps a facet folder node to the value emitted through `onSelectFacet`. */
function facetValueForNode(node: Extract<FacetTreeNode, { type: "facet" }>): string {
  return node.path === UNTAGGED_FACET_LABEL ? UNTAGGED_FACET_VALUE : node.path
}

export function FacetedVaultPanel({
  groupId,
  onOpenDoc,
  onSelectFacet,
  selectedFacet,
}: FacetedVaultPanelProps): React.ReactElement {
  const [tree, setTree] = useState<FacetTreeNode[]>([])
  const [docCount, setDocCount] = useState(0)
  const [treeLoading, setTreeLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)

  const loadTree = useCallback(async () => {
    setTreeLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${FACETED_FS_ENDPOINT}?groupId=${encodeURIComponent(groupId)}`,
        { cache: "no-store" },
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Failed to load vault (${res.status})`)
      }
      const body = (await res.json()) as { tree: FacetTreeNode[]; docCount: number }
      setTree(body.tree)
      setDocCount(body.docCount)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load vault")
    } finally {
      setTreeLoading(false)
    }
  }, [groupId])

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  const toggleFolder = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleSelectDoc = useCallback(
    (docId: string) => {
      setSelectedDocId(docId)
      onOpenDoc(docId)
    },
    [onOpenDoc],
  )

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-muted-foreground">Vault</p>
          {treeLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <Badge variant="secondary" className="text-[10px]">
          {docCount} {docCount === 1 ? "doc" : "docs"}
        </Badge>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Group docs filed by facet. A doc can appear under several hierarchies at
        once; tags are an index, not ownership.
      </p>
      <div className="max-h-[560px] space-y-0.5 overflow-y-auto rounded-md border bg-muted/20 p-2">
        {/* "All docs" clears the facet filter. */}
        <button
          type="button"
          className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted ${
            selectedFacet === null ? "bg-primary/10 font-medium text-primary" : ""
          }`}
          style={{ paddingLeft: "8px" }}
          onClick={() => onSelectFacet(null)}
        >
          <span className="inline-block w-3 shrink-0" />
          <Layers className="h-3 w-3 shrink-0" />
          <span className="truncate">All docs</span>
          <span className="ml-auto text-[10px] text-muted-foreground">{docCount}</span>
        </button>

        {!treeLoading && tree.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            No docs in the vault yet.
          </p>
        ) : (
          <FacetTree
            nodes={tree}
            expanded={expanded}
            selectedDocId={selectedDocId}
            selectedFacet={selectedFacet}
            onToggleFolder={toggleFolder}
            onSelectDoc={handleSelectDoc}
            onSelectFacet={onSelectFacet}
          />
        )}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

interface FacetTreeProps {
  nodes: FacetTreeNode[]
  expanded: Set<string>
  selectedDocId: string | null
  selectedFacet: string | null
  onToggleFolder: (id: string) => void
  onSelectDoc: (docId: string) => void
  onSelectFacet: (facet: string | null) => void
  depth?: number
}

function FacetTree({
  nodes,
  expanded,
  selectedDocId,
  selectedFacet,
  onToggleFolder,
  onSelectDoc,
  onSelectFacet,
  depth = 0,
}: FacetTreeProps): React.ReactElement | null {
  if (nodes.length === 0) return null
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        if (node.type === "doc") {
          const isSelected = selectedDocId === node.docId
          return (
            <button
              key={node.id}
              type="button"
              className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted ${
                isSelected ? "bg-primary/10 text-primary" : ""
              }`}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              onClick={() => onSelectDoc(node.docId)}
            >
              <span className="inline-block w-3 shrink-0" />
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
          )
        }
        const isOpen = expanded.has(node.id)
        const facetValue = facetValueForNode(node)
        const isFacetSelected = selectedFacet === facetValue
        return (
          <div key={node.id}>
            <div
              className={`flex w-full items-center gap-1 rounded pr-2 text-xs ${
                isFacetSelected ? "bg-primary/10 text-primary" : "hover:bg-muted"
              }`}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
            >
              {/* Chevron toggles expand/collapse without changing the filter. */}
              <button
                type="button"
                aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
                className="flex shrink-0 items-center rounded-sm py-1 hover:text-primary"
                onClick={() => onToggleFolder(node.id)}
              >
                {isOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>
              {/* Folder name selects this facet as the doc-list filter. */}
              <button
                type="button"
                className={`flex flex-1 items-center gap-1.5 py-1 text-left ${
                  isFacetSelected ? "font-medium" : ""
                }`}
                onClick={() => onSelectFacet(facetValue)}
              >
                <FolderOpen className="h-3 w-3 shrink-0" />
                <span className="truncate">{node.name}</span>
              </button>
              <span className="ml-auto text-[10px] text-muted-foreground">{node.docCount}</span>
            </div>
            {isOpen && node.children.length > 0 ? (
              <FacetTree
                nodes={node.children}
                expanded={expanded}
                selectedDocId={selectedDocId}
                selectedFacet={selectedFacet}
                onToggleFolder={onToggleFolder}
                onSelectDoc={onSelectDoc}
                onSelectFacet={onSelectFacet}
                depth={depth + 1}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
