"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Calendar, MapPin, AlertCircle, Car, Wrench, Laptop, Home, Package, User, DollarSign } from "lucide-react"
import Image from "next/image"
import { useToast } from "@/components/ui/use-toast"
import { MutualAsset, AssetCategory, AssetStatus } from "@/lib/types"
import type { MemberInfo } from "@/types/domain"

/**
 * Asset booking/usage request dialog used in mutual asset marketplace flows.
 * This modal appears from asset detail/list actions when a member requests to
 * book or use a shared asset.
 *
 * Key props:
 * - `asset`: Selected asset to display and request against.
 * - `isOpen`: Controls dialog visibility.
 * - `onClose`: Closes the dialog.
 * - `onBook`: Callback invoked with booking payload after successful validation/submission.
 */
interface AssetBookingDialogProps {
  asset: MutualAsset | null
  isOpen: boolean
  onClose: () => void
  onBook: (assetId: string, startDate: string, endDate: string, purpose: string, notes: string) => void
  members?: MemberInfo[]
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
 * Displays asset context and collects booking request details.
 *
 * @param props - Component props.
 * @param props.asset - The active asset being booked; when null, the dialog renders nothing.
 * @param props.isOpen - Whether the dialog is currently open.
 * @param props.onClose - Called when the dialog should close.
 * @param props.onBook - Called after successful submit with booking details.
 */
const UNKNOWN_MEMBER: MemberInfo = { id: "", name: "Unknown User", username: "unknown", avatar: "/placeholder.svg" }

export function AssetBookingDialog({ asset, isOpen, onClose, onBook, members = [] }: AssetBookingDialogProps) {
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [purpose, setPurpose] = useState("")
  const [notes, setNotes] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { toast } = useToast()

  if (!asset) return null

  const owner = members.find(u => u.id === asset.ownedBy) || UNKNOWN_MEMBER
  const CategoryIcon = categoryIcons[asset.category]

  const handleSubmit = async () => {
    // Client-side validation for required booking fields.
    if (!startDate || !endDate || !purpose.trim()) {
      toast({
        title: "Missing information",
        description: "Please fill in all required fields.",
        variant: "destructive",
      })
      return
    }

    if (new Date(startDate) >= new Date(endDate)) {
      toast({
        title: "Invalid dates",
        description: "End date must be after start date.",
        variant: "destructive",
      })
      return
    }

    setIsSubmitting(true)
    
    try {
      // Side effect: simulates async booking request to a backend/server action.
      await new Promise(resolve => setTimeout(resolve, 1000))
      // Callback communicates booking data to parent state/API layer.
      onBook(asset.id, startDate, endDate, purpose, notes)
      
      // Side effect: toast confirms request submission.
      toast({
        title: "Booking request submitted!",
        description: `Your request to use "${asset.name}" has been sent to ${owner.name}.`,
      })
      
      // Reset local form state after successful submit to avoid stale input on reopen.
      setStartDate("")
      setEndDate("")
      setPurpose("")
      setNotes("")
      onClose()
    } catch (_error) {
      // Side effect: toast communicates submission failure.
      toast({
        title: "Failed to submit booking",
        description: "Please try again later.",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const getStatusColor = (status: AssetStatus) => {
    switch (status) {
      case AssetStatus.Available:
        return "bg-green-100 text-green-800"
      case AssetStatus.InUse:
        return "bg-blue-100 text-blue-800"
      case AssetStatus.Maintenance:
        return "bg-yellow-100 text-yellow-800"
      case AssetStatus.Reserved:
        return "bg-purple-100 text-purple-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const isBookingDisabled = asset.status !== AssetStatus.Available

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CategoryIcon className="h-5 w-5" />
            {asset.bookingRequired ? "Book Asset" : "Use Asset"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Asset Details */}
          <div className="space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-semibold text-lg">{asset.name}</h3>
                <p className="text-muted-foreground text-sm">{asset.description}</p>
              </div>
              <Badge className={getStatusColor(asset.status)}>
                {asset.status}
              </Badge>
            </div>

            {/* Asset Image */}
            {asset.images && asset.images.length > 0 && (
              <div className="aspect-video bg-muted rounded-md overflow-hidden">
                <Image
                  src={asset.images[0]}
                  alt={asset.name}
                  width={600}
                  height={338}
                  className="w-full h-full object-cover"
                  unoptimized
                />
              </div>
            )}

            {/* Owner Info */}
            <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
              <Avatar className="h-10 w-10">
                <AvatarImage src={owner.avatar} alt={owner.name} />
                <AvatarFallback>{owner.name.substring(0, 2)}</AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium">{owner.name}</p>
                <p className="text-sm text-muted-foreground">Asset Owner</p>
              </div>
            </div>

            {/* Asset Details */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              {asset.location && (
                <div className="flex items-center gap-2 col-span-2">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  <span>{asset.location}</span>
                </div>
              )}

              {asset.value && (
                <div className="flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                  <span>Value: ${asset.value.toLocaleString()}</span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span>Added {new Date(asset.addedAt).toLocaleDateString()}</span>
              </div>
            </div>

            {/* Usage Instructions */}
            {asset.usageInstructions && (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <h4 className="font-medium text-blue-900 mb-1">Usage Instructions</h4>
                <p className="text-sm text-blue-700">{asset.usageInstructions}</p>
              </div>
            )}

            {/* Restrictions */}
            {asset.restrictions && asset.restrictions.length > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <h4 className="font-medium text-amber-900 mb-1">Usage Restrictions</h4>
                    <ul className="text-sm text-amber-700 space-y-1">
                      {asset.restrictions.map((restriction, index) => (
                        <li key={index}>• {restriction}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Conditional rendering: booking form only appears when asset is available. */}
          {!isBookingDisabled && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="start-date">Start Date *</Label>
                  <Input
                    id="start-date"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    min={new Date().toISOString().split('T')[0]}
                  />
                </div>
                <div>
                  <Label htmlFor="end-date">End Date *</Label>
                  <Input
                    id="end-date"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    min={startDate || new Date().toISOString().split('T')[0]}
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="purpose">Purpose *</Label>
                <Input
                  id="purpose"
                  placeholder="What will you use this asset for?"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              </div>

              <div>
                <Label htmlFor="notes">Additional Notes</Label>
                <Textarea
                  id="notes"
                  placeholder="Any special requirements or additional information..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                />
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <div className="flex items-start gap-2">
                  <User className="h-4 w-4 text-blue-600 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-blue-900">
                      {asset.bookingRequired ? "Booking Process" : "Usage Process"}
                    </p>
                    <p className="text-blue-700 mt-1">
                      {asset.bookingRequired 
                        ? `${owner.name} will review your booking request and respond within 24 hours. You'll be notified once approved.`
                        : `${owner.name} will be notified of your usage. Please coordinate pickup/return details through messages.`
                      }
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Conditional rendering: unavailable notice replaces form for non-available assets. */}
          {isBookingDisabled && (
            <div className="p-4 bg-muted rounded-lg text-center">
              <AlertCircle className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="font-medium">Asset Not Available</p>
              <p className="text-sm text-muted-foreground mt-1">
                This asset is currently {asset.status.toLowerCase()}. 
                {asset.status === AssetStatus.InUse && asset.currentUseEndDate && (
                  ` Expected to be available on ${new Date(asset.currentUseEndDate).toLocaleDateString()}.`
                )}
              </p>
            </div>
          )}

          {/* Actions are gated by availability and current async submission state. */}
          <div className="flex gap-3 pt-4">
            <Button variant="outline" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            {!isBookingDisabled && (
              <Button 
                onClick={handleSubmit} 
                disabled={isSubmitting}
                className="flex-1"
              >
                {isSubmitting ? "Submitting..." : (asset.bookingRequired ? "Submit Booking" : "Request Usage")}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
