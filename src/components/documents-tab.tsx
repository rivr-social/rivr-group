"use client"

/**
 * Documents module for the group workspace — a parachute vault surface.
 *
 * The module IS the vault: there is no separate "Documents" vs "Tags" toggle.
 * A single integrated layout renders
 *  - LEFT: the always-on `FacetedVaultPanel` tag rail (the group's docs filed
 *    under multiple orthogonal tag hierarchies at once), and
 *  - RIGHT: the doc list filtered by the selected facet (default: all docs), or
 *    the `DocumentViewer` when a doc is opened. Editing a doc's nested slash-path
 *    tags happens inline in the viewer as chips (`FacetedTagEditor`) and persists
 *    through the same `updateResource` action.
 *
 * Key props:
 * - `groupId`: scopes the vault + document list to a single group.
 * - `documents`: pre-fetched documents for the group (from the server parent).
 * - `docsPath`: base path used when creating a new document.
 */
import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { Document } from "@/types/domain"
import { DocumentList } from "./document-list"
import { DocumentViewer } from "./document-viewer"
import { EmptyState } from "./empty-state"
import { FileText } from "lucide-react"
import { createDocumentResourceAction } from "@/app/actions/create-resources"
import { useToast } from "@/components/ui/use-toast"
import {
  FacetedVaultPanel,
  UNTAGGED_FACET_VALUE,
} from "@/components/faceted-vault-panel"

interface DocumentsTabProps {
  groupId: string
  documents: Document[]
  docsPath: string
}

/**
 * Returns every materialized tag-path AND each of its prefixes across the docs,
 * used to seed the inline chip-editor autocomplete so nested facets stay
 * consistent (`work`, `work/projects`, `work/projects/rivr`).
 */
function collectFacetSuggestions(documents: Document[]): string[] {
  const paths = new Set<string>()
  for (const doc of documents) {
    for (const path of doc.facetedTags ?? []) {
      for (let depth = 1; depth <= path.length; depth += 1) {
        const prefix = path.slice(0, depth).join("/")
        if (prefix) paths.add(prefix)
      }
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b))
}

/** Tests whether a document belongs under the selected facet filter. */
function docMatchesFacet(doc: Document, facet: string | null): boolean {
  if (facet === null) return true
  const facets = doc.facetedTags ?? []
  if (facet === UNTAGGED_FACET_VALUE) return facets.length === 0
  return facets.some((path) => {
    const joined = path.join("/")
    return joined === facet || joined.startsWith(`${facet}/`)
  })
}

/**
 * Renders the group's documents as an integrated parachute vault: facet rail +
 * filtered list / inline viewer.
 *
 * @param props Component props.
 * @param props.groupId Group identifier used to scope the vault and list.
 * @param props.documents Pre-fetched document array for the group.
 * @param props.docsPath Base path used when creating a new document.
 */
export function DocumentsTab({ groupId, documents, docsPath }: DocumentsTabProps) {
  const [isPending, startTransition] = useTransition()
  const [documentItems, setDocumentItems] = useState<Document[]>(documents)
  const [selectedFacet, setSelectedFacet] = useState<string | null>(null)
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const { toast } = useToast()
  const router = useRouter()

  // Keep the local editable copy in sync with fresh server data (e.g. after a
  // create refresh) without dropping the current selection.
  useEffect(() => {
    setDocumentItems(documents)
  }, [documents])

  const handleCreateDocument = () => {
    startTransition(async () => {
      const result = await createDocumentResourceAction({
        groupId,
        title: "New Document",
        content: "",
      })
      if (result.success && result.resourceId) {
        toast({ title: "Document created", description: "Your new document is ready." })
        router.push(`${docsPath}?doc=${result.resourceId}`)
      } else {
        toast({ title: "Failed to create document", description: result.message, variant: "destructive" })
      }
    })
  }

  // Data derivation: only documents that belong to the active group.
  const groupDocuments = useMemo(
    () => documentItems.filter((doc) => doc.groupId === groupId),
    [documentItems, groupId],
  )

  const suggestions = useMemo(
    () => collectFacetSuggestions(groupDocuments),
    [groupDocuments],
  )

  const filteredDocuments = useMemo(
    () => groupDocuments.filter((doc) => docMatchesFacet(doc, selectedFacet)),
    [groupDocuments, selectedFacet],
  )

  const selectedDocument = useMemo(
    () => groupDocuments.find((doc) => doc.id === selectedDocId) ?? null,
    [groupDocuments, selectedDocId],
  )

  const rail = (
    <FacetedVaultPanel
      groupId={groupId}
      selectedFacet={selectedFacet}
      onSelectFacet={(facet) => {
        setSelectedFacet(facet)
        setSelectedDocId(null)
      }}
      onOpenDoc={(docId) => setSelectedDocId(docId)}
    />
  )

  const handleDocumentUpdated = (nextDocument: Document) => {
    setDocumentItems((current) =>
      current.map((doc) => (doc.id === nextDocument.id ? nextDocument : doc)),
    )
  }

  const right = selectedDocument ? (
    <DocumentViewer
      document={selectedDocument}
      suggestions={suggestions}
      onBack={() => setSelectedDocId(null)}
      onDocumentUpdated={handleDocumentUpdated}
    />
  ) : groupDocuments.length === 0 ? (
    <EmptyState
      title="No Documents Yet"
      description="This group doesn't have any documents yet. Create the first one to get started."
      action={{
        label: isPending ? "Creating..." : "Create Document",
        onClick: handleCreateDocument,
      }}
      icon={<FileText className="h-12 w-12" />}
    />
  ) : (
    <DocumentList
      documents={filteredDocuments}
      groupId={groupId}
      onSelectDocument={(doc) => setSelectedDocId(doc.id)}
      onCreateDocument={handleCreateDocument}
    />
  )

  return (
    <div className="p-4">
      <div className="grid gap-4 md:grid-cols-[300px_1fr]">
        <div className="md:sticky md:top-4 md:self-start">{rail}</div>
        <div className="min-w-0">{right}</div>
      </div>
    </div>
  )
}
