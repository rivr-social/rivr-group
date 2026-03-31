/**
 * @fileoverview TagEditor - Editable tag management component.
 *
 * Used in forms (create post, create listing, group settings) to allow users
 * to add, remove, and manage tags using the TagSelector sub-component.
 */
"use client"

import { useState } from "react"
import { TagSelector } from "./tag-selector"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface TagEditorProps {
  objectId?: string
  objectType?: string
  initialChapterTags?: string[]
  initialGroupTags?: string[]
  onSave?: (chapterTags: string[], groupTags: string[]) => void
  onCancel?: () => void
  tags?: string[]
  setTags?: (tags: string[]) => void
  placeholder?: string
  suggestions?: string[]
}

export function TagEditor({
  objectId: _objectId,
  objectType,
  initialChapterTags = [],
  initialGroupTags = [],
  onSave,
  onCancel,
  tags,
  setTags,
  placeholder,
  suggestions: _suggestions,
}: TagEditorProps) {
  const [chapterTags, setChapterTags] = useState<string[]>(initialChapterTags)
  const [groupTags, setGroupTags] = useState<string[]>(initialGroupTags)
  const [activeTab, setActiveTab] = useState<string>("chapters")

  const handleSave = () => {
    onSave?.(chapterTags, groupTags)
  }

  // Simple mode for marketplace form
  if (tags !== undefined && setTags) {
    return (
      <div className="border rounded-md p-2">
        <input
          type="text"
          placeholder={placeholder || "Add tags..."}
          className="w-full px-2 py-1 text-sm outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              const input = e.currentTarget
              const newTag = input.value.trim()
              if (newTag && !tags.includes(newTag)) {
                setTags([...tags, newTag])
                input.value = ''
              }
            }
          }}
        />
        <div className="flex flex-wrap gap-1 mt-2">
          {tags.map((tag, index) => (
            <span key={index} className="bg-primary/10 text-primary text-xs px-2 py-1 rounded flex items-center gap-1">
              {tag}
              <button
                type="button"
                onClick={() => setTags(tags.filter((_, i) => i !== index))}
                className="hover:text-destructive"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <Card className="w-full max-w-md mx-auto">
      <CardHeader>
        <CardTitle>Edit Tags</CardTitle>
        <CardDescription>
          Add or remove tags for this {objectType}. Tags help organize content and make it easier to find.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="chapters" value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="chapters">Chapters</TabsTrigger>
            <TabsTrigger value="groups">Groups</TabsTrigger>
          </TabsList>
          <TabsContent value="chapters" className="pt-4">
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium mb-2">Chapter Tags</h3>
                <p className="text-xs text-muted-foreground mb-4">
                  Select the chapters this {objectType} belongs to or is relevant for.
                </p>
                <TagSelector type="chapter" selectedTags={chapterTags} onChange={setChapterTags} maxTags={10} />
              </div>
            </div>
          </TabsContent>
          <TabsContent value="groups" className="pt-4">
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium mb-2">Group Tags</h3>
                <p className="text-xs text-muted-foreground mb-4">
                  Select the groups this {objectType} belongs to or is relevant for.
                </p>
                <TagSelector type="group" selectedTags={groupTags} onChange={setGroupTags} maxTags={10} />
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
      <CardFooter className="flex justify-between">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSave}>Save Tags</Button>
      </CardFooter>
    </Card>
  )
}
