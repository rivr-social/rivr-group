import { getDocumentsForGroup } from "@/lib/queries/resources"
import { GroupDocsContent } from "./group-docs-content"

interface GroupDocsPageProps {
  params: Promise<{
    id: string
  }>
  searchParams: Promise<{
    doc?: string
  }>
}

export default async function GroupDocsPage({ params, searchParams }: GroupDocsPageProps) {
  const { id: groupId } = await params
  const { doc: initialDocId = null } = (await searchParams) ?? {}

  const documents = await getDocumentsForGroup(groupId)

  return (
    <GroupDocsContent
      groupId={groupId}
      documents={documents}
      initialDocId={initialDocId ?? null}
    />
  )
}
