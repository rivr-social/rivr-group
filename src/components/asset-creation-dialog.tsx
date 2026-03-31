"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Car, Wrench, Laptop, Home, Package, Plus, X, Upload } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { AssetCategory } from "@/lib/types"

/**
 * Asset creation dialog for adding shared assets to a ring's mutual asset catalog.
 * This modal is used in asset management/list pages where members contribute new
 * assets with metadata, tags, and usage restrictions.
 *
 * Key props:
 * - `isOpen`: Controls dialog visibility.
 * - `onClose`: Closes the dialog and exits the creation flow.
 * - `onSubmit`: Callback receiving normalized asset payload.
 * - `ringId`: Ring identifier attached to new asset records.
 */
interface AssetCreationDialogProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (assetData: Record<string, unknown>) => void
  ringId: string
}

const categoryIcons = {
  [AssetCategory.Vehicle]: Car,
  [AssetCategory.Tool]: Wrench,
  [AssetCategory.Equipment]: Package,
  [AssetCategory.Property]: Home,
  [AssetCategory.Technology]: Laptop,
  [AssetCategory.Other]: Package,
}

/**
 * Collects new mutual asset details and submits normalized asset data.
 *
 * @param props - Component props.
 * @param props.isOpen - Whether the creation dialog is visible.
 * @param props.onClose - Called when the dialog should close.
 * @param props.onSubmit - Called with prepared asset payload after successful submission.
 * @param props.ringId - Ring ID assigned to the new asset.
 */
export function AssetCreationDialog({ isOpen, onClose, onSubmit, ringId }: AssetCreationDialogProps) {
  // Centralized form state for all user-entered asset fields.
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    category: AssetCategory.Other,
    value: "",
    location: "",
    usageInstructions: "",
    tags: [] as string[],
    restrictions: [] as string[],
    bookingRequired: false,
  })
  // Local input state for staged tag/restriction entries before committing to formData arrays.
  const [newTag, setNewTag] = useState("")
  const [newRestriction, setNewRestriction] = useState("")
  // Submission state prevents duplicate submits and drives button loading label.
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { toast } = useToast()

  const handleSubmit = async () => {
    // Required-field validation before any async work.
    if (!formData.name.trim() || !formData.description.trim()) {
      toast({
        title: "Missing information",
        description: "Please fill in the asset name and description.",
        variant: "destructive",
      })
      return
    }

    setIsSubmitting(true)
    
    try {
      // Side effect: simulates asynchronous API/server-action creation request.
      await new Promise(resolve => setTimeout(resolve, 1000))
      
      // Normalize payload shape and enrich with generated/system-managed metadata.
      const assetData = {
        ...formData,
        value: formData.value ? parseFloat(formData.value) : undefined,
        ringId,
        addedAt: new Date().toISOString(),
        ownedBy: "user1", // Current user ID
        status: "available",
      }
      
      // Emit created asset payload to parent state/data layer.
      onSubmit(assetData)
      
      // Side effect: toast confirms successful asset creation.
      toast({
        title: "Asset added successfully!",
        description: `"${formData.name}" has been added to the ring's mutual assets.`,
      })
      
      // Reset local state so subsequent opens start with a clean form.
      setFormData({
        name: "",
        description: "",
        category: AssetCategory.Other,
        value: "",
        location: "",
        usageInstructions: "",
        tags: [],
        restrictions: [],
        bookingRequired: false,
      })
      setNewTag("")
      setNewRestriction("")
      onClose()
    } catch (_error) {
      // Side effect: toast communicates submission error.
      toast({
        title: "Failed to add asset",
        description: "Please try again later.",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const addTag = () => {
    // Event handler: only add unique, non-empty tags.
    if (newTag.trim() && !formData.tags.includes(newTag.trim())) {
      setFormData(prev => ({
        ...prev,
        tags: [...prev.tags, newTag.trim()]
      }))
      setNewTag("")
    }
  }

  const removeTag = (tagToRemove: string) => {
    // Event handler: remove selected tag from formData.tags.
    setFormData(prev => ({
      ...prev,
      tags: prev.tags.filter(tag => tag !== tagToRemove)
    }))
  }

  const addRestriction = () => {
    // Event handler: only add unique, non-empty usage restrictions.
    if (newRestriction.trim() && !formData.restrictions.includes(newRestriction.trim())) {
      setFormData(prev => ({
        ...prev,
        restrictions: [...prev.restrictions, newRestriction.trim()]
      }))
      setNewRestriction("")
    }
  }

  const removeRestriction = (restrictionToRemove: string) => {
    // Event handler: remove selected restriction from formData.restrictions.
    setFormData(prev => ({
      ...prev,
      restrictions: prev.restrictions.filter(restriction => restriction !== restrictionToRemove)
    }))
  }

  const CategoryIcon = categoryIcons[formData.category]

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Add Mutual Asset
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Basic Information */}
          <div className="space-y-4">
            <div>
              <Label htmlFor="asset-name">Asset Name *</Label>
              <Input
                id="asset-name"
                placeholder="e.g., Honda Civic, Power Drill, MacBook Pro"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              />
            </div>

            <div>
              <Label htmlFor="asset-description">Description *</Label>
              <Textarea
                id="asset-description"
                placeholder="Describe the asset, its condition, and any important details..."
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="asset-category">Category</Label>
                <Select
                  value={formData.category}
                  onValueChange={(value) => setFormData(prev => ({ ...prev, category: value as AssetCategory }))}
                >
                  <SelectTrigger>
                    <div className="flex items-center gap-2">
                      <CategoryIcon className="h-4 w-4" />
                      <SelectValue />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AssetCategory.Vehicle}>
                      <div className="flex items-center gap-2">
                        <Car className="h-4 w-4" />
                        Vehicle
                      </div>
                    </SelectItem>
                    <SelectItem value={AssetCategory.Tool}>
                      <div className="flex items-center gap-2">
                        <Wrench className="h-4 w-4" />
                        Tool
                      </div>
                    </SelectItem>
                    <SelectItem value={AssetCategory.Equipment}>
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4" />
                        Equipment
                      </div>
                    </SelectItem>
                    <SelectItem value={AssetCategory.Property}>
                      <div className="flex items-center gap-2">
                        <Home className="h-4 w-4" />
                        Property
                      </div>
                    </SelectItem>
                    <SelectItem value={AssetCategory.Technology}>
                      <div className="flex items-center gap-2">
                        <Laptop className="h-4 w-4" />
                        Technology
                      </div>
                    </SelectItem>
                    <SelectItem value={AssetCategory.Other}>
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4" />
                        Other
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="asset-value">Estimated Value ($)</Label>
                <Input
                  id="asset-value"
                  type="number"
                  placeholder="0"
                  value={formData.value}
                  onChange={(e) => setFormData(prev => ({ ...prev, value: e.target.value }))}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="asset-location">Current Location</Label>
              <Input
                id="asset-location"
                placeholder="Where is this asset currently stored?"
                value={formData.location}
                onChange={(e) => setFormData(prev => ({ ...prev, location: e.target.value }))}
              />
            </div>
          </div>

          {/* Usage Instructions */}
          <div>
            <Label htmlFor="usage-instructions">Usage Instructions</Label>
            <Textarea
              id="usage-instructions"
              placeholder="How to use this asset safely and properly..."
              value={formData.usageInstructions}
              onChange={(e) => setFormData(prev => ({ ...prev, usageInstructions: e.target.value }))}
              rows={2}
            />
          </div>

          {/* Tags */}
          <div>
            <Label>Tags</Label>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  placeholder="Add a tag"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      addTag()
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={addTag}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {/* Conditional rendering: only show badge list when at least one tag exists. */}
              {formData.tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {formData.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="flex items-center gap-1">
                      {tag}
                      <X 
                        className="h-3 w-3 cursor-pointer" 
                        onClick={() => removeTag(tag)}
                      />
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Restrictions */}
          <div>
            <Label>Usage Restrictions</Label>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  placeholder="Add a restriction or requirement"
                  value={newRestriction}
                  onChange={(e) => setNewRestriction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      addRestriction()
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={addRestriction}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {/* Conditional rendering: only show restriction list when entries exist. */}
              {formData.restrictions.length > 0 && (
                <div className="space-y-1">
                  {formData.restrictions.map((restriction, index) => (
                    <div key={index} className="flex items-center justify-between p-2 bg-muted rounded">
                      <span className="text-sm">{restriction}</span>
                      <X 
                        className="h-4 w-4 cursor-pointer text-muted-foreground hover:text-foreground" 
                        onClick={() => removeRestriction(restriction)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Booking Requirements */}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="booking-required"
              checked={formData.bookingRequired}
              onCheckedChange={(checked) => 
                setFormData(prev => ({ ...prev, bookingRequired: !!checked }))
              }
            />
            <Label htmlFor="booking-required" className="text-sm">
              Advance booking required (users must request approval before use)
            </Label>
          </div>

          {/* Image Upload Placeholder */}
          <div>
            <Label>Photos</Label>
            <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-6 text-center">
              <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                Click to upload photos or drag and drop
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                PNG, JPG up to 10MB each
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-4">
            <Button variant="outline" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit} 
              disabled={isSubmitting || !formData.name.trim() || !formData.description.trim()}
              className="flex-1"
            >
              {isSubmitting ? "Adding Asset..." : "Add Asset"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
