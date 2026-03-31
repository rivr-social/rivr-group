/**
 * @fileoverview VoucherClaimDialog - Dialog for claiming/redeeming vouchers.
 *
 * Used in the marketplace and voucher pool views. Allows users to enter a
 * voucher code or scan a QR code to claim a voucher, with validation and
 * confirmation feedback.
 */
"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Calendar, Clock, MapPin, Star, Heart, MessageSquare } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Voucher, VoucherCategory } from "@/lib/types"
import type { MemberInfo } from "@/types/domain"

interface VoucherClaimDialogProps {
  voucher: Voucher | null
  isOpen: boolean
  onClose: () => void
  onClaim: (voucherId: string, notes: string) => void
  members?: MemberInfo[]
}

const UNKNOWN_MEMBER: MemberInfo = { id: "", name: "Unknown User", username: "unknown", avatar: "/placeholder.svg" }

export function VoucherClaimDialog({ voucher, isOpen, onClose, onClaim, members = [] }: VoucherClaimDialogProps) {
  const [notes, setNotes] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { toast } = useToast()

  if (!voucher) return null

  const offerer = members.find(u => u.id === voucher.offeredBy) || UNKNOWN_MEMBER

  const getCategoryIcon = (category: VoucherCategory) => {
    switch (category) {
      case VoucherCategory.Service:
        return <Heart className="h-4 w-4" />
      case VoucherCategory.Goods:
        return <Star className="h-4 w-4" />
      case VoucherCategory.Skill:
        return <Star className="h-4 w-4" />
      case VoucherCategory.Experience:
        return <Heart className="h-4 w-4" />
      case VoucherCategory.Resource:
        return <Star className="h-4 w-4" />
      default:
        return <Star className="h-4 w-4" />
    }
  }

  const getCategoryColor = (category: VoucherCategory) => {
    switch (category) {
      case VoucherCategory.Service:
        return "bg-blue-100 text-blue-800"
      case VoucherCategory.Goods:
        return "bg-green-100 text-green-800"
      case VoucherCategory.Skill:
        return "bg-purple-100 text-purple-800"
      case VoucherCategory.Experience:
        return "bg-pink-100 text-pink-800"
      case VoucherCategory.Resource:
        return "bg-orange-100 text-orange-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const handleSubmit = async () => {
    setIsSubmitting(true)
    
    try {
      await new Promise(resolve => setTimeout(resolve, 1000)) // Simulate API call
      onClaim(voucher.id, notes)
      
      toast({
        title: "Voucher claimed successfully!",
        description: `You've claimed "${voucher.title}". ${offerer.name} will be notified.`,
      })
      
      setNotes("")
      onClose()
    } catch (_error) {
      toast({
        title: "Failed to claim voucher",
        description: "Please try again later.",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Claim Voucher</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Voucher Details */}
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex items-center gap-2">
                {getCategoryIcon(voucher.category)}
                <Badge className={getCategoryColor(voucher.category)}>
                  {voucher.category}
                </Badge>
              </div>
            </div>

            <div>
              <h3 className="font-semibold text-lg mb-2">{voucher.title}</h3>
              <p className="text-muted-foreground text-sm">{voucher.description}</p>
            </div>

            {/* Offerer Info */}
            <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
              <Avatar className="h-10 w-10">
                <AvatarImage src={offerer.avatar} alt={offerer.name} />
                <AvatarFallback>{offerer.name.substring(0, 2)}</AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium">{offerer.name}</p>
                <p className="text-sm text-muted-foreground">Voucher Offerer</p>
              </div>
            </div>

            {/* Voucher Details */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              {voucher.estimatedValue && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Value:</span>
                  <span className="font-medium">${voucher.estimatedValue}</span>
                </div>
              )}

              {voucher.timeCommitment && (
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span>{voucher.timeCommitment}</span>
                </div>
              )}

              {voucher.location && (
                <div className="flex items-center gap-2 col-span-2">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  <span>{voucher.location}</span>
                </div>
              )}

              {voucher.expiresAt && (
                <div className="flex items-center gap-2 col-span-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span>Expires {new Date(voucher.expiresAt).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          </div>

          {/* Claim Form */}
          <div className="space-y-4">
            <div>
              <Label htmlFor="claim-notes">Message to {offerer.name} (optional)</Label>
              <Textarea
                id="claim-notes"
                placeholder="Let them know when you'd like to use this voucher or any special requests..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <MessageSquare className="h-4 w-4 text-blue-600 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-blue-900">What happens next?</p>
                  <p className="text-blue-700 mt-1">
                    {offerer.name} will be notified of your claim and can accept or decline. 
                    You&apos;ll be able to coordinate details through messages.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-4">
            <Button variant="outline" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit} 
              disabled={isSubmitting}
              className="flex-1"
            >
              {isSubmitting ? "Claiming..." : "Claim Voucher"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}