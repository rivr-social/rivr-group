"use client"

/**
 * Document Viewer component for the group documents feature.
 *
 * Used in:
 * - Group documents tab when a user opens a single document from the document list.
 *
 * Key props:
 * - `document`: The selected document record to render.
 * - `onBack`: Callback used to return to the document list view.
 */
import { useEffect, useState, useTransition, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { updateResource } from "@/app/actions/create-resources"
import type { Document } from "@/types/domain"
import type { MemberInfo } from "@/types/domain"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/components/ui/use-toast"
import { ChevronLeft, FileText, Clock, User, Tag } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

interface DocumentViewerProps {
  document: Document
  onBack: () => void
  onDocumentUpdated?: (document: Document) => void
  members?: MemberInfo[]
}

/**
 * Renders lightweight inline markdown tokens (`*italic*`, `**bold**`) as React nodes.
 *
 * @param text Plain text line that may include inline markdown markers.
 * @returns Tokenized inline content rendered as text, `<em>`, and `<strong>` nodes.
 */
function renderInlineMarkdown(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean)
  return tokens.map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={index}>{token.slice(2, -2)}</strong>
    }
    if (token.startsWith("*") && token.endsWith("*")) {
      return <em key={index}>{token.slice(1, -1)}</em>
    }
    return <span key={index}>{token}</span>
  })
}

/**
 * Converts markdown-like document content into structured React elements.
 *
 * @param content Raw document body text.
 * @returns Renderable nodes containing headings, lists, separators, and paragraphs.
 */
function renderDocumentContent(content: string): ReactNode[] {
  const lines = content.split(/\r?\n/)
  const nodes: ReactNode[] = []
  let listItems: string[] = []
  let listKey = 0

  // Ensures accumulated list items are emitted as a single list block before switching sections.
  const flushList = () => {
    if (listItems.length === 0) return
    nodes.push(
      <ul key={`list-${listKey}`} className="list-disc pl-6 space-y-1">
        {listItems.map((item, index) => (
          <li key={`${listKey}-${index}`}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>
    )
    listItems = []
    listKey += 1
  }

  lines.forEach((line, index) => {
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    const listItem = line.match(/^(?:-|\d+\.)\s+(.*)$/)

    if (heading) {
      flushList()
      const level = heading[1].length
      const text = heading[2]
      if (level === 1) nodes.push(<h1 key={`h1-${index}`} className="text-2xl font-bold mt-6 mb-3">{renderInlineMarkdown(text)}</h1>)
      else if (level === 2) nodes.push(<h2 key={`h2-${index}`} className="text-xl font-bold mt-5 mb-2">{renderInlineMarkdown(text)}</h2>)
      else if (level === 3) nodes.push(<h3 key={`h3-${index}`} className="text-lg font-semibold mt-4 mb-2">{renderInlineMarkdown(text)}</h3>)
      else nodes.push(<h4 key={`h4-${index}`} className="text-base font-semibold mt-3 mb-2">{renderInlineMarkdown(text)}</h4>)
      return
    }

    if (/^---$/.test(line.trim())) {
      flushList()
      nodes.push(<hr key={`hr-${index}`} className="my-4" />)
      return
    }

    if (listItem) {
      listItems.push(listItem[1])
      return
    }

    flushList()
    if (line.trim().length === 0) {
      nodes.push(<div key={`spacer-${index}`} className="h-2" />)
      return
    }
    nodes.push(<p key={`p-${index}`} className="leading-7">{renderInlineMarkdown(line)}</p>)
  })

  flushList()
  return nodes
}

/**
 * Displays a single document with metadata and formatted content.
 *
 * @param props Component props.
 * @param props.document Document selected from the group document list.
 * @param props.onBack Callback that returns to the previous documents view.
 * @returns Document detail UI with metadata, actions, and rendered content.
 */
export function DocumentViewer({ document, onBack, onDocumentUpdated, members = [] }: DocumentViewerProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isEditing, setIsEditing] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [title, setTitle] = useState(document.title)
  const [description, setDescription] = useState(document.description)
  const [content, setContent] = useState(document.content)
  const [category, setCategory] = useState(document.category ?? "")
  const [tags, setTags] = useState((document.tags ?? []).join(", "))
  const [showOnAbout, setShowOnAbout] = useState(document.showOnAbout === true)
  const creator = members.find(user => user.id === document.createdBy)

  useEffect(() => {
    setTitle(document.title)
    setDescription(document.description)
    setContent(document.content)
    setCategory(document.category ?? "")
    setTags((document.tags ?? []).join(", "))
    setShowOnAbout(document.showOnAbout === true)
    setIsEditing(false)
  }, [document])

  const handleSave = () => {
    startTransition(async () => {
      const nextTags = tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)

      const result = await updateResource({
        resourceId: document.id,
        name: title.trim(),
        description: description.trim(),
        content,
        tags: nextTags,
        metadataPatch: {
          category: category.trim() || null,
          showOnAbout,
        },
      })

      if (!result.success) {
        toast({
          title: "Failed to save document",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      const nextDocument: Document = {
        ...document,
        title: title.trim(),
        description: description.trim(),
        content,
        category: category.trim() || undefined,
        tags: nextTags,
        showOnAbout,
        updatedAt: new Date().toISOString(),
      }

      onDocumentUpdated?.(nextDocument)
      setIsEditing(false)
      router.refresh()
      toast({ title: "Document saved" })
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {/* Event handler: returns the user to the documents list view. */}
        <Button variant="ghost" onClick={onBack} className="flex items-center space-x-2">
          <ChevronLeft className="h-4 w-4" />
          <span>Back to Documents</span>
        </Button>
        <div className="flex items-center space-x-2">
          {isEditing ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setIsEditing(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={isPending || !title.trim()}>
                {isPending ? "Saving..." : "Save"}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
              Edit
            </Button>
          )}
          <Button variant="outline" size="sm">
            Share
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <FileText className="h-5 w-5 text-blue-500" />
              {/* Conditional rendering: category badge only appears when a category exists. */}
              {document.category && (
                <Badge variant="outline">{document.category}</Badge>
              )}
            </div>
            <div className="flex items-center text-sm text-muted-foreground space-x-4">
              <div className="flex items-center space-x-1">
                <Clock className="h-4 w-4" />
                <span>Updated {new Date(document.updatedAt).toLocaleDateString()}</span>
              </div>
              <div className="flex items-center space-x-2">
                <User className="h-4 w-4" />
                {/* Conditional rendering: creator details render only when a matching user is found. */}
                {creator && (
                  <div className="flex items-center space-x-1">
                    <Avatar className="h-6 w-6">
                      <AvatarImage src={creator.avatar} alt={creator.name} />
                      <AvatarFallback>{creator.name[0]}</AvatarFallback>
                    </Avatar>
                    <span>{creator.name}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
          {isEditing ? (
            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="document-title">Title</Label>
                <Input id="document-title" value={title} onChange={(event) => setTitle(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="document-description">Description</Label>
                <Textarea id="document-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="document-category">Category</Label>
                  <Input id="document-category" value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Governance" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="document-tags">Tags</Label>
                  <Input id="document-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="policy, founding, public" />
                </div>
              </div>
              <label className="flex items-center gap-3 text-sm font-medium">
                <Checkbox checked={showOnAbout} onCheckedChange={(checked) => setShowOnAbout(checked === true)} />
                Show on About page
              </label>
            </div>
          ) : (
            <>
              <CardTitle className="text-2xl mt-4">{document.title}</CardTitle>
              <p className="text-muted-foreground">{document.description}</p>
              {document.tags && document.tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                  {document.tags.map(tag => (
                    <Badge key={tag} variant="secondary" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </>
          )}
        </CardHeader>
        <CardContent>
          {isEditing ? (
            <div className="space-y-2">
              <Label htmlFor="document-content">Content</Label>
              <Textarea
                id="document-content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={24}
                className="min-h-[60vh] font-mono text-sm"
              />
            </div>
          ) : (
            <ScrollArea className="h-[60vh] w-full border rounded-md p-4">
              <div className="markdown-content prose prose-sm max-w-none">
                {renderDocumentContent(document.content)}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
