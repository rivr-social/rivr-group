import Link from "next/link"
import { FileText } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Document } from "@/types/domain"

interface AboutDocumentsCardProps {
  documents: Document[]
  docsPath: string
  emptyLabel: string
}

export function AboutDocumentsCard({
  documents,
  docsPath,
  emptyLabel,
}: AboutDocumentsCardProps) {
  const aboutDocuments = documents.filter((document) => document.showOnAbout)
  const documentsByCategory = new Map<string, Document[]>()
  for (const document of aboutDocuments) {
    const category = document.category?.trim() || "Other"
    const existing = documentsByCategory.get(category) ?? []
    existing.push(document)
    documentsByCategory.set(category, existing)
  }

  const groupedDocuments = Array.from(documentsByCategory.entries())
    .sort(([left], [right]) => {
      return left.localeCompare(right)
    })
    .map(([category, categoryDocuments]) => ({
      category,
      label: `${category} Documents`,
      documents: [...categoryDocuments].sort((left, right) => {
        return left.title.localeCompare(right.title)
      }),
    }))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Documents
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {groupedDocuments.length > 0 ? (
          <>
            <div className="grid gap-6 md:grid-cols-2">
              {groupedDocuments.map((group) => (
                <div key={group.category} className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">{group.label}</h3>
                  <div className="space-y-2">
                    {group.documents.map((document) => (
                      <Link
                        key={document.id}
                        href={`${docsPath}?doc=${document.id}`}
                        className="flex items-start gap-2 rounded-md px-1 py-1 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <span>{document.title}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="border-t pt-4 text-sm text-muted-foreground">
              These are real group documents that have been marked to appear on the About tab.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No documents have been shared on the About tab yet. {emptyLabel}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
