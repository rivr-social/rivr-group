"use client"

import { useState, useTransition } from "react"
import Image from "next/image"
import Link from "next/link"
import {
  Boxes,
  Check,
  ExternalLink,
  FolderKanban,
  ListPlus,
  Loader2,
  Megaphone,
  Package,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useToast } from "@/components/ui/use-toast"
import {
  addStockNeedAction,
  createStockNeedListAction,
  postStockNeedRequestAction,
  removeStockNeedAction,
  removeStockNeedListAction,
  toggleStockNeedFulfilledAction,
  updateStockNeedAction,
  updateStockNeedListAction,
  type OrgNeedsRollupEntry,
} from "@/app/actions/stock"
import {
  GENERAL_NEEDS_LIST_ID,
  type StockInventoryItem,
  type StockNeed,
  type StockNeedList,
  type StockParentType,
} from "@/lib/stock"

/** Local subtab keys for the Stock panel. */
const STOCK_SUBTAB_INVENTORY = "inventory"
const STOCK_SUBTAB_NEEDS = "needs"

const STOCK_ITEM_PLACEHOLDER_IMAGE = "/placeholder-event.jpg"

/** Sentinel for "no project" in the connect picker (Radix forbids ""). */
const NO_PROJECT = "__none__"

export interface StockTabProps {
  parentType: StockParentType
  parentId: string
  /** Read-only inventory rows (already projected from stock resources). */
  inventory: StockInventoryItem[]
  /** Server-loaded need lists (General first). */
  initialLists: StockNeedList[]
  /** Whether the viewer may edit Needs / post requests. */
  canManage: boolean
  /** Org parents only: subgroup + project need-list rollup (read-only). */
  needsRollup?: OrgNeedsRollupEntry[]
  /** Org parents only: projects offered by the list-connect picker. */
  projectOptions?: Array<{ id: string; name: string }>
}

/** Read-only need row used by the rollup sections. */
function NeedRowReadOnly({ need }: { need: StockNeed }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className={need.fulfilled ? "text-muted-foreground line-through" : ""}>
        {need.quantity > 1 ? `${need.quantity}× ` : ""}
        {need.name}
      </span>
      <span className="flex items-center gap-1">
        {need.fulfilled ? <Badge variant="secondary">Fulfilled</Badge> : null}
        {need.requested ? <Badge variant="outline">Requested</Badge> : null}
      </span>
    </div>
  )
}

/**
 * Self-contained Stock panel with nested Inventory + Needs subtabs.
 *
 * Needs are organized into LISTS: the legacy "General" list plus named lists
 * (each optionally connected to a project). Fulfilling a need materializes it
 * into Inventory server-side. Org parents additionally show a read-only
 * rollup of every subgroup's lists and, under each, the lists of that
 * agent's projects.
 */
export function StockTab({
  parentType,
  parentId,
  inventory,
  initialLists,
  canManage,
  needsRollup = [],
  projectOptions = [],
}: StockTabProps) {
  const { toast } = useToast()
  const [activeSubTab, setActiveSubTab] = useState<string>(STOCK_SUBTAB_INVENTORY)
  const [lists, setLists] = useState<StockNeedList[]>(initialLists)
  const [isPending, startTransition] = useTransition()

  // Add-need form state (targets one list).
  const [targetListId, setTargetListId] = useState<string>(GENERAL_NEEDS_LIST_ID)
  const [newName, setNewName] = useState("")
  const [newQuantity, setNewQuantity] = useState("1")
  const [newNote, setNewNote] = useState("")

  // New-list form state.
  const [creatingList, setCreatingList] = useState(false)
  const [newListName, setNewListName] = useState("")
  const [newListProjectId, setNewListProjectId] = useState<string>(NO_PROJECT)

  // Inline-edit state (keyed by need id).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editQuantity, setEditQuantity] = useState("1")
  const [editNote, setEditNote] = useState("")

  const projectNameById = new Map(projectOptions.map((p) => [p.id, p.name]))

  const applyResult = (
    result: Awaited<ReturnType<typeof addStockNeedAction>>,
    successTitle: string,
  ): boolean => {
    if (!result.success) {
      toast({ title: successTitle + " failed", description: result.error ?? "Please try again.", variant: "destructive" })
      return false
    }
    if (result.lists) setLists(result.lists)
    return true
  }

  const handleAdd = () => {
    const name = newName.trim()
    if (!name) {
      toast({ title: "Add item failed", description: "A name is required.", variant: "destructive" })
      return
    }
    startTransition(async () => {
      const result = await addStockNeedAction(
        parentType,
        parentId,
        { name, quantity: Number(newQuantity) || 1, note: newNote.trim() },
        targetListId,
      )
      if (applyResult(result, "Add item")) {
        setNewName("")
        setNewQuantity("1")
        setNewNote("")
        toast({ title: "Item added", description: `“${name}” was added.` })
      }
    })
  }

  const handleCreateList = () => {
    const name = newListName.trim()
    if (!name) {
      toast({ title: "Create list failed", description: "A list name is required.", variant: "destructive" })
      return
    }
    startTransition(async () => {
      const result = await createStockNeedListAction(parentType, parentId, {
        name,
        ...(newListProjectId !== NO_PROJECT ? { projectId: newListProjectId } : {}),
      })
      if (applyResult(result, "Create list")) {
        setCreatingList(false)
        setNewListName("")
        setNewListProjectId(NO_PROJECT)
        toast({ title: "List created", description: `“${name}” is ready for items.` })
      }
    })
  }

  const handleConnectProject = (listId: string, projectId: string) => {
    startTransition(async () => {
      const result = await updateStockNeedListAction(parentType, parentId, listId, {
        projectId: projectId === NO_PROJECT ? null : projectId,
      })
      applyResult(result, "Connect project")
    })
  }

  const handleRemoveList = (list: StockNeedList) => {
    startTransition(async () => {
      const result = await removeStockNeedListAction(parentType, parentId, list.id)
      if (applyResult(result, "Delete list")) {
        if (targetListId === list.id) setTargetListId(GENERAL_NEEDS_LIST_ID)
        toast({ title: "List deleted", description: `“${list.name}” was removed.` })
      }
    })
  }

  const startEdit = (need: StockNeed) => {
    setEditingId(need.id)
    setEditName(need.name)
    setEditQuantity(String(need.quantity))
    setEditNote(need.note)
  }

  const handleSaveEdit = (listId: string, needId: string) => {
    const name = editName.trim()
    if (!name) {
      toast({ title: "Save failed", description: "A name is required.", variant: "destructive" })
      return
    }
    startTransition(async () => {
      const result = await updateStockNeedAction(
        parentType,
        parentId,
        needId,
        { name, quantity: Number(editQuantity) || 1, note: editNote.trim() },
        listId,
      )
      if (applyResult(result, "Save")) {
        setEditingId(null)
        toast({ title: "Item updated" })
      }
    })
  }

  const handleRemove = (listId: string, needId: string) => {
    startTransition(async () => {
      const result = await removeStockNeedAction(parentType, parentId, needId, listId)
      if (applyResult(result, "Remove")) {
        toast({ title: "Item removed" })
      }
    })
  }

  const handleToggle = (listId: string, need: StockNeed) => {
    startTransition(async () => {
      const result = await toggleStockNeedFulfilledAction(parentType, parentId, need.id, listId)
      if (applyResult(result, "Update") && !need.fulfilled) {
        toast({ title: "Fulfilled — moved to inventory", description: `“${need.name}” is now stock.` })
      }
    })
  }

  const handlePostRequest = (listId: string, need: StockNeed) => {
    startTransition(async () => {
      const result = await postStockNeedRequestAction(parentType, parentId, need.id, { listId })
      if (applyResult(result, "Post request")) {
        toast({ title: "Request posted", description: `A request for “${need.name}” was published.` })
      }
    })
  }

  const renderNeedRow = (listId: string, need: StockNeed) => (
    <Card key={need.id}>
      <CardContent className="p-4">
        {editingId === need.id ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
              <div className="space-y-1.5">
                <Label htmlFor={`edit-name-${need.id}`}>Item</Label>
                <Input id={`edit-name-${need.id}`} value={editName} onChange={(event) => setEditName(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`edit-qty-${need.id}`}>Quantity</Label>
                <Input
                  id={`edit-qty-${need.id}`}
                  type="number"
                  min={1}
                  value={editQuantity}
                  onChange={(event) => setEditQuantity(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`edit-note-${need.id}`}>Note</Label>
              <Textarea id={`edit-note-${need.id}`} value={editNote} onChange={(event) => setEditNote(event.target.value)} rows={2} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => handleSaveEdit(listId, need.id)} disabled={isPending}>
                <Check className="mr-2 h-4 w-4" />
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} disabled={isPending}>
                <X className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className={`font-medium ${need.fulfilled ? "text-muted-foreground line-through" : ""}`}>
                  {need.quantity > 1 ? `${need.quantity}× ` : ""}
                  {need.name}
                </p>
                {need.fulfilled ? <Badge variant="secondary">In inventory</Badge> : null}
                {need.requested ? <Badge variant="outline">Requested</Badge> : null}
              </div>
              {need.note ? <p className="text-sm text-muted-foreground">{need.note}</p> : null}
            </div>
            {canManage ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handlePostRequest(listId, need)}
                  disabled={isPending || need.requested}
                  title={need.requested ? "Already requested" : "Post as request"}
                >
                  <Megaphone className="mr-2 h-4 w-4" />
                  {need.requested ? "Requested" : "Post as request"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleToggle(listId, need)}
                  disabled={isPending}
                  title={need.fulfilled ? "Mark as needed" : "Mark fulfilled → inventory"}
                >
                  <Check className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => startEdit(need)} disabled={isPending} title="Edit">
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => handleRemove(listId, need.id)} disabled={isPending} title="Remove">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )

  const subgroupEntries = needsRollup.filter((entry) => !entry.isSelf)

  return (
    <div className="space-y-6">
      <Tabs value={activeSubTab} onValueChange={setActiveSubTab}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value={STOCK_SUBTAB_INVENTORY}>
            <Boxes className="mr-2 h-4 w-4" />
            Inventory
          </TabsTrigger>
          <TabsTrigger value={STOCK_SUBTAB_NEEDS}>
            <Package className="mr-2 h-4 w-4" />
            Needs
          </TabsTrigger>
        </TabsList>

        {/* ── Inventory (read-only) ──────────────────────────────────────── */}
        <TabsContent value={STOCK_SUBTAB_INVENTORY} className="mt-4 space-y-4">
          {inventory.length === 0 ? (
            <p className="text-sm text-muted-foreground">No stock items are associated with this yet.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {inventory.map((item) => (
                <Card key={item.id} className="overflow-hidden">
                  <div className="relative aspect-video bg-muted">
                    <Image
                      src={item.imageUrl || STOCK_ITEM_PLACEHOLDER_IMAGE}
                      alt={item.name}
                      fill
                      className="object-cover"
                      unoptimized
                    />
                    {item.quantity !== null ? (
                      <Badge className="absolute right-2 top-2" variant="secondary">
                        Qty {item.quantity}
                      </Badge>
                    ) : null}
                  </div>
                  <CardContent className="space-y-2 p-4">
                    <p className="font-medium leading-tight">{item.name}</p>
                    {item.href ? (
                      <Button variant="outline" size="sm" asChild>
                        <Link href={item.href}>
                          View <ExternalLink className="ml-2 h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Needs (multiple editable lists) ────────────────────────────── */}
        <TabsContent value={STOCK_SUBTAB_NEEDS} className="mt-4 space-y-4">
          {canManage ? (
            <Card>
              <CardContent className="grid gap-3 p-4 md:grid-cols-[1fr_auto]">
                <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
                  <div className="space-y-1.5">
                    <Label htmlFor="stock-need-name">Item</Label>
                    <Input
                      id="stock-need-name"
                      value={newName}
                      onChange={(event) => setNewName(event.target.value)}
                      placeholder="e.g. Folding tables"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="stock-need-qty">Quantity</Label>
                    <Input
                      id="stock-need-qty"
                      type="number"
                      min={1}
                      value={newQuantity}
                      onChange={(event) => setNewQuantity(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="stock-need-list">List</Label>
                    <Select value={targetListId} onValueChange={setTargetListId}>
                      <SelectTrigger id="stock-need-list">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {lists.map((list) => (
                          <SelectItem key={list.id} value={list.id}>
                            {list.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5 sm:col-span-3">
                    <Label htmlFor="stock-need-note">Note (optional)</Label>
                    <Textarea
                      id="stock-need-note"
                      value={newNote}
                      onChange={(event) => setNewNote(event.target.value)}
                      placeholder="Details, specs, links…"
                      rows={2}
                    />
                  </div>
                </div>
                <div className="flex items-end gap-2">
                  <Button onClick={handleAdd} disabled={isPending} className="w-full md:w-auto">
                    {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                    Add
                  </Button>
                  <Button variant="outline" onClick={() => setCreatingList((open) => !open)} className="w-full md:w-auto">
                    <ListPlus className="mr-2 h-4 w-4" />
                    New list
                  </Button>
                </div>
              </CardContent>
              {creatingList ? (
                <CardContent className="border-t p-4">
                  <div className="grid gap-3 sm:grid-cols-[2fr_2fr_auto]">
                    <div className="space-y-1.5">
                      <Label htmlFor="stock-list-name">List name</Label>
                      <Input
                        id="stock-list-name"
                        value={newListName}
                        onChange={(event) => setNewListName(event.target.value)}
                        placeholder="e.g. Fall build supplies"
                      />
                    </div>
                    {projectOptions.length > 0 ? (
                      <div className="space-y-1.5">
                        <Label htmlFor="stock-list-project">Connect to project (optional)</Label>
                        <Select value={newListProjectId} onValueChange={setNewListProjectId}>
                          <SelectTrigger id="stock-list-project">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NO_PROJECT}>No project</SelectItem>
                            {projectOptions.map((project) => (
                              <SelectItem key={project.id} value={project.id}>
                                {project.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                    <div className="flex items-end">
                      <Button onClick={handleCreateList} disabled={isPending}>
                        Create
                      </Button>
                    </div>
                  </div>
                </CardContent>
              ) : null}
            </Card>
          ) : null}

          {lists.map((list) => (
            <div key={list.id} className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">{list.name}</h3>
                  {list.projectId ? (
                    <Link href={`/projects/${list.projectId}`}>
                      <Badge variant="outline" className="gap-1">
                        <FolderKanban className="h-3 w-3" />
                        {projectNameById.get(list.projectId) ?? "Project"}
                      </Badge>
                    </Link>
                  ) : null}
                </div>
                {canManage && list.id !== GENERAL_NEEDS_LIST_ID ? (
                  <div className="flex items-center gap-1">
                    {projectOptions.length > 0 ? (
                      <Select
                        value={list.projectId ?? NO_PROJECT}
                        onValueChange={(projectId) => handleConnectProject(list.id, projectId)}
                      >
                        <SelectTrigger className="h-8 w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_PROJECT}>No project</SelectItem>
                          {projectOptions.map((project) => (
                            <SelectItem key={project.id} value={project.id}>
                              {project.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => handleRemoveList(list)} disabled={isPending} title="Delete list">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ) : null}
              </div>
              {list.needs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No items in this list yet.</p>
              ) : (
                <div className="space-y-3">{list.needs.map((need) => renderNeedRow(list.id, need))}</div>
              )}
            </div>
          ))}

          {/* ── Subgroup + project rollup (org parents, read-only) ────────── */}
          {subgroupEntries.length > 0 ? (
            <div className="space-y-4 border-t pt-4">
              <h3 className="text-base font-semibold">Subgroup needs</h3>
              {subgroupEntries.map((entry) => (
                <Card key={entry.agentId}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">
                      <Link href={`/groups/${entry.agentId}?tab=stock`} className="hover:underline">
                        {entry.agentName}
                      </Link>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {entry.lists.map((list) => (
                      <div key={list.id} className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">{list.name}</p>
                        {list.needs.map((need) => (
                          <NeedRowReadOnly key={need.id} need={need} />
                        ))}
                      </div>
                    ))}
                    {entry.projects.filter((project) => project.lists.length > 0).map((project) => (
                      <div key={project.projectId} className="space-y-1 border-l-2 pl-3">
                        <p className="text-xs font-medium">
                          <Link href={`/projects/${project.projectId}`} className="hover:underline">
                            <FolderKanban className="mr-1 inline h-3 w-3" />
                            {project.projectName}
                          </Link>
                        </p>
                        {project.lists.map((list) => (
                          <div key={list.id} className="space-y-1">
                            <p className="text-xs text-muted-foreground">{list.name}</p>
                            {list.needs.map((need) => (
                              <NeedRowReadOnly key={need.id} need={need} />
                            ))}
                          </div>
                        ))}
                      </div>
                    ))}
                    {entry.lists.length === 0 && entry.projects.every((project) => project.lists.length === 0) ? (
                      <p className="text-sm text-muted-foreground">No needs listed.</p>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : null}

          {/* ── Own projects' lists (org parents, read-only) ──────────────── */}
          {needsRollup
            .filter((entry) => entry.isSelf && entry.projects.some((project) => project.lists.length > 0))
            .map((entry) => (
              <div key={entry.agentId} className="space-y-3 border-t pt-4">
                <h3 className="text-base font-semibold">Project needs</h3>
                {entry.projects.filter((project) => project.lists.length > 0).map((project) => (
                  <Card key={project.projectId}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">
                        <Link href={`/projects/${project.projectId}`} className="hover:underline">
                          <FolderKanban className="mr-1 inline h-3 w-3" />
                          {project.projectName}
                        </Link>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1">
                      {project.lists.map((list) => (
                        <div key={list.id} className="space-y-1">
                          <p className="text-xs font-medium text-muted-foreground">{list.name}</p>
                          {list.needs.map((need) => (
                            <NeedRowReadOnly key={need.id} need={need} />
                          ))}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ))}
              </div>
            ))}
        </TabsContent>
      </Tabs>
    </div>
  )
}
