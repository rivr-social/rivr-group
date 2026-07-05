"use client"

import { useState, useTransition } from "react"
import Image from "next/image"
import Link from "next/link"
import { Boxes, Check, ExternalLink, Loader2, Megaphone, Package, Pencil, Plus, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useToast } from "@/components/ui/use-toast"
import {
  addStockNeedAction,
  postStockNeedRequestAction,
  removeStockNeedAction,
  toggleStockNeedFulfilledAction,
  updateStockNeedAction,
} from "@/app/actions/stock"
import type { StockInventoryItem, StockNeed, StockParentType } from "@/lib/stock"

/** Local subtab keys for the Stock panel. */
const STOCK_SUBTAB_INVENTORY = "inventory"
const STOCK_SUBTAB_NEEDS = "needs"

const STOCK_ITEM_PLACEHOLDER_IMAGE = "/placeholder-event.jpg"

export interface StockTabProps {
  parentType: StockParentType
  parentId: string
  /** Read-only inventory rows (already projected from stock resources). */
  inventory: StockInventoryItem[]
  /** Server-loaded initial Needs list. */
  initialNeeds: StockNeed[]
  /** Whether the viewer may edit Needs / post requests. */
  canManage: boolean
}

/**
 * Self-contained Stock panel with nested Inventory + Needs subtabs. Mirrors the
 * `press-tab` pattern: a local `activeSubTab` useState drives a nested `<Tabs>`.
 *
 * Inventory is read-only; Needs is an editable shopping list persisted to the
 * parent's `metadata.stockNeeds` via the stock server actions.
 */
export function StockTab({ parentType, parentId, inventory, initialNeeds, canManage }: StockTabProps) {
  const { toast } = useToast()
  const [activeSubTab, setActiveSubTab] = useState<string>(STOCK_SUBTAB_INVENTORY)
  const [needs, setNeeds] = useState<StockNeed[]>(initialNeeds)
  const [isPending, startTransition] = useTransition()

  // Add-need form state.
  const [newName, setNewName] = useState("")
  const [newQuantity, setNewQuantity] = useState("1")
  const [newNote, setNewNote] = useState("")

  // Inline-edit state (keyed by need id).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editQuantity, setEditQuantity] = useState("1")
  const [editNote, setEditNote] = useState("")

  const applyResult = (
    result: Awaited<ReturnType<typeof addStockNeedAction>>,
    successTitle: string,
  ): boolean => {
    if (!result.success) {
      toast({ title: successTitle + " failed", description: result.error ?? "Please try again.", variant: "destructive" })
      return false
    }
    if (result.needs) setNeeds(result.needs)
    return true
  }

  const handleAdd = () => {
    const name = newName.trim()
    if (!name) {
      toast({ title: "Add item failed", description: "A name is required.", variant: "destructive" })
      return
    }
    startTransition(async () => {
      const result = await addStockNeedAction(parentType, parentId, {
        name,
        quantity: Number(newQuantity) || 1,
        note: newNote.trim(),
      })
      if (applyResult(result, "Add item")) {
        setNewName("")
        setNewQuantity("1")
        setNewNote("")
        toast({ title: "Item added", description: `“${name}” was added to the needs list.` })
      }
    })
  }

  const startEdit = (need: StockNeed) => {
    setEditingId(need.id)
    setEditName(need.name)
    setEditQuantity(String(need.quantity))
    setEditNote(need.note)
  }

  const cancelEdit = () => {
    setEditingId(null)
  }

  const handleSaveEdit = (needId: string) => {
    const name = editName.trim()
    if (!name) {
      toast({ title: "Save failed", description: "A name is required.", variant: "destructive" })
      return
    }
    startTransition(async () => {
      const result = await updateStockNeedAction(parentType, parentId, needId, {
        name,
        quantity: Number(editQuantity) || 1,
        note: editNote.trim(),
      })
      if (applyResult(result, "Save")) {
        setEditingId(null)
        toast({ title: "Item updated" })
      }
    })
  }

  const handleRemove = (needId: string) => {
    startTransition(async () => {
      const result = await removeStockNeedAction(parentType, parentId, needId)
      if (applyResult(result, "Remove")) {
        toast({ title: "Item removed" })
      }
    })
  }

  const handleToggle = (needId: string) => {
    startTransition(async () => {
      const result = await toggleStockNeedFulfilledAction(parentType, parentId, needId)
      applyResult(result, "Update")
    })
  }

  const handlePostRequest = (need: StockNeed) => {
    startTransition(async () => {
      const result = await postStockNeedRequestAction(parentType, parentId, need.id)
      if (applyResult(result, "Post request")) {
        toast({ title: "Request posted", description: `A request for “${need.name}” was published.` })
      }
    })
  }

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

        {/* ── Needs (editable shopping list) ─────────────────────────────── */}
        <TabsContent value={STOCK_SUBTAB_NEEDS} className="mt-4 space-y-4">
          {canManage ? (
            <Card>
              <CardContent className="grid gap-3 p-4 md:grid-cols-[1fr_auto]">
                <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
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
                  <div className="space-y-1.5 sm:col-span-2">
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
                <div className="flex items-end">
                  <Button onClick={handleAdd} disabled={isPending} className="w-full md:w-auto">
                    {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {needs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No needs have been listed yet.</p>
          ) : (
            <div className="space-y-3">
              {needs.map((need) => (
                <Card key={need.id}>
                  <CardContent className="p-4">
                    {editingId === need.id ? (
                      <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
                          <div className="space-y-1.5">
                            <Label htmlFor={`edit-name-${need.id}`}>Item</Label>
                            <Input
                              id={`edit-name-${need.id}`}
                              value={editName}
                              onChange={(event) => setEditName(event.target.value)}
                            />
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
                          <Textarea
                            id={`edit-note-${need.id}`}
                            value={editNote}
                            onChange={(event) => setEditNote(event.target.value)}
                            rows={2}
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => handleSaveEdit(need.id)} disabled={isPending}>
                            <Check className="mr-2 h-4 w-4" />
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={isPending}>
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
                            {need.fulfilled ? <Badge variant="secondary">Fulfilled</Badge> : null}
                            {need.requested ? <Badge variant="outline">Requested</Badge> : null}
                          </div>
                          {need.note ? <p className="text-sm text-muted-foreground">{need.note}</p> : null}
                        </div>
                        {canManage ? (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handlePostRequest(need)}
                              disabled={isPending || need.requested}
                              title={need.requested ? "Already requested" : "Post as request"}
                            >
                              <Megaphone className="mr-2 h-4 w-4" />
                              {need.requested ? "Requested" : "Post as request"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleToggle(need.id)}
                              disabled={isPending}
                              title={need.fulfilled ? "Mark as needed" : "Mark fulfilled"}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => startEdit(need)}
                              disabled={isPending}
                              title="Edit"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleRemove(need.id)}
                              disabled={isPending}
                              title="Remove"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
