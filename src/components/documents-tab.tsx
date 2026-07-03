"use client"

/**
 * Documents Tab container for the group workspace document feature.
 *
 * Used in:
 * - Group detail page/tab where users browse and open documents tied to a specific group.
 *
 * Two view modes:
 * - "documents": the classic list of the group's documents.
 * - "vault": the faceted-tag "Tags" view — the group's docs filed under multiple
 *   orthogonal tag hierarchies at once (`FacetedVaultPanel`). Selecting a doc
 *   opens it on the canonical docs surface.
 *
 * Key props:
 * - `groupId`: Identifier used to scope the document list to a single group.
 * - `documents`: Pre-fetched documents for the group (from server component parent).
 */
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { Document } from "@/types/domain"
import { DocumentList } from "./document-list"
import { EmptyState } from "./empty-state"
import { FileText } from "lucide-react"
import { createDocumentResourceAction } from "@/app/actions/create-resources"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import { FacetedVaultPanel } from "@/components/faceted-vault-panel"

type DocViewMode = "documents" | "vault"

interface DocumentsTabProps {
  groupId: string
  documents: Document[]
  docsPath: string
}

/**
 * Controls document list vs. faceted "Tags" vault rendering for a group.
 *
 * @param props Component props.
 * @param props.groupId Group identifier used to filter documents.
 * @param props.documents Pre-fetched document array for the group.
 * @returns The view-mode toggle plus the documents list / empty state / Tags vault.
 */
export function DocumentsTab({ groupId, documents, docsPath }: DocumentsTabProps) {
  const [isPending, startTransition] = useTransition()
  const [viewMode, setViewMode] = useState<DocViewMode>("documents")
  const { toast } = useToast()
  const router = useRouter()

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

  // Data derivation: filters to only documents that belong to the active group.
  const groupDocuments = documents.filter(doc => doc.groupId === groupId)

  const modeToggle = (
    <div className="flex items-center gap-2">
      <Button
        variant={viewMode === "documents" ? "default" : "outline"}
        size="sm"
        onClick={() => setViewMode("documents")}
      >
        Documents
      </Button>
      <Button
        variant={viewMode === "vault" ? "default" : "outline"}
        size="sm"
        onClick={() => setViewMode("vault")}
      >
        Tags
      </Button>
    </div>
  )

  if (viewMode === "vault") {
    return (
      <div className="p-4 space-y-4">
        {modeToggle}
        <FacetedVaultPanel
          groupId={groupId}
          onOpenDoc={(docId) => router.push(`${docsPath}?doc=${docId}`)}
        />
      </div>
    )
  }

  // Conditional rendering: show empty state when no documents exist for the provided group.
  if (groupDocuments.length === 0) {
    return (
      <div className="p-4 space-y-4">
        {modeToggle}
        <EmptyState
          title="No Documents Yet"
          description="This group doesn't have any documents yet. Create the first one to get started."
          action={{
            label: isPending ? "Creating..." : "Create Document",
            onClick: handleCreateDocument,
          }}
          icon={<FileText className="h-12 w-12" />}
        />
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      {modeToggle}
      <DocumentList
        documents={groupDocuments}
        groupId={groupId}
        onCreateDocument={handleCreateDocument}
        documentHrefBuilder={(doc) => `${docsPath}?doc=${doc.id}`}
      />
    </div>
  )
}
