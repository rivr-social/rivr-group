"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import type { Document } from "@/types/domain"
import { DocumentList } from "@/components/document-list"
import { DocumentViewer } from "@/components/document-viewer"
import { Button } from "@/components/ui/button"
import { ChevronLeft } from "lucide-react"

interface GroupDocsContentProps {
  groupId: string
  documents: Document[]
  initialDocId: string | null
}

export function GroupDocsContent({ groupId, documents, initialDocId }: GroupDocsContentProps) {
  const router = useRouter()
  const [documentItems, setDocumentItems] = useState<Document[]>(documents)
  useEffect(() => {
    setDocumentItems(documents)
  }, [documents])
  const initialDoc = documents.find((d) => d.id === initialDocId) || null
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(initialDoc)
  useEffect(() => {
    if (!initialDocId) return
    const nextDocument = documentItems.find((document) => document.id === initialDocId) ?? null
    setSelectedDocument(nextDocument)
  }, [documentItems, initialDocId])

  return (
    <div className="container mx-auto px-4 py-6">
      <Button
        variant="ghost"
        onClick={() => router.back()}
        className="mb-4 flex items-center"
      >
        <ChevronLeft className="h-4 w-4 mr-2" /> Back to Group
      </Button>

      <div className="grid md:grid-cols-[320px_1fr] gap-6">
        <DocumentList
          documents={documentItems}
          groupId={groupId}
          onSelectDocument={(doc) => setSelectedDocument(doc)}
        />

        {selectedDocument ? (
          <DocumentViewer
            document={selectedDocument}
            onBack={() => setSelectedDocument(null)}
            onDocumentUpdated={(nextDocument) => {
              setDocumentItems((current) => current.map((document) => document.id === nextDocument.id ? nextDocument : document))
              setSelectedDocument(nextDocument)
            }}
          />
        ) : (
          <div className="flex items-center justify-center text-muted-foreground border rounded-lg">
            Select a document to preview
          </div>
        )}
      </div>
    </div>
  )
}
