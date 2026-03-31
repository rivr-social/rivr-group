/**
 * @fileoverview VoucherPoolTab - Displays and manages a group's voucher pool.
 *
 * Shown on the group detail page. Lists available vouchers, their redemption
 * status, and allows admins to create new vouchers or manage existing ones.
 */
"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Gift, Clock, MapPin, Star, Plus, Filter, Heart, CheckCircle, Calendar, DollarSign, Users } from "lucide-react"
import type { MemberInfo } from "@/types/domain"
import { fetchVouchersForGroup } from "@/app/actions/graph"
import { type Voucher, VoucherCategory, VoucherStatus } from "@/lib/types"
import { createVoucherAction, claimVoucherAction, redeemVoucherAction } from "@/app/actions/interactions"
import { useToast } from "@/components/ui/use-toast"
import { CreateOfferingModal } from "@/components/create-offering-modal"
import { VoucherClaimDialog } from "@/components/voucher-claim-dialog"
import type { OfferingDraftPayload } from "@/components/create-offering-form"

interface VoucherPoolTabProps {
  ringId: string
  ringName?: string
  localeIds?: string[]
  currentUserId?: string
  members?: MemberInfo[]
}

const UNKNOWN_MEMBER: MemberInfo = { id: "", name: "Unknown User", username: "unknown", avatar: "/placeholder.svg" }

export function VoucherPoolTab({ ringId, ringName = "This Ring", localeIds = [], currentUserId, members = [] }: VoucherPoolTabProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>("all")
  const [selectedStatus, setSelectedStatus] = useState<string>("all")
  const [vouchers, setVouchers] = useState<Voucher[]>([])
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [claimDialogVoucher, setClaimDialogVoucher] = useState<Voucher | null>(null)
  const [claimingId, setClaimingId] = useState<string | null>(null)
  const [redeemingId, setRedeemingId] = useState<string | null>(null)
  const { toast } = useToast()

  const mapVoucher = (r: Awaited<ReturnType<typeof fetchVouchersForGroup>>[number]): Voucher => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return {
      id: r.id,
      title: r.name,
      description: r.description ?? "",
      category: (meta.category as VoucherCategory) ?? VoucherCategory.Service,
      offeredBy: r.ownerId,
      ringId,
      createdAt: r.createdAt,
      expiresAt: meta.expiresAt as string,
      status: (meta.status as VoucherStatus) ?? VoucherStatus.Available,
      claimedBy: meta.claimedBy as string | undefined,
      claimedAt: meta.claimedAt as string | undefined,
      completedAt: meta.completedAt as string | undefined,
      tags: (r.tags ?? []) as string[],
      estimatedValue: (meta.estimatedValue as number) ?? 0,
      timeCommitment: meta.timeCommitment as string,
      location: meta.location as string,
      maxClaims: (meta.maxClaims as number) ?? 1,
      currentClaims: (meta.currentClaims as number) ?? 0,
    }
  }

  const refreshVouchers = () => {
    fetchVouchersForGroup(ringId).then((resources) => {
      setVouchers(resources.map(mapVoucher))
    })
  }

  useEffect(() => {
    refreshVouchers()
  }, [ringId])
  const resolvedCurrentUserId = currentUserId || ""

  // Filter vouchers
  const filteredVouchers = vouchers.filter((voucher) => {
    const categoryMatch = selectedCategory === "all" || voucher.category === selectedCategory
    const statusMatch = selectedStatus === "all" || voucher.status === selectedStatus
    return categoryMatch && statusMatch
  })

  // Statistics
  const totalVouchers = vouchers.length
  const availableVouchers = vouchers.filter((v) => v.status === VoucherStatus.Available).length
  const myVouchers = vouchers.filter((v) => v.offeredBy === resolvedCurrentUserId).length
  const totalValue = vouchers.reduce((sum, v) => sum + (v.estimatedValue || 0), 0)

  const handleCreateFromComposer = async (payload: OfferingDraftPayload) => {
    const normalizedGroupIds = payload.scopedGroupIds ?? []
    const normalizedLocaleIds = payload.scopedLocaleIds ?? localeIds

    if (payload.offeringType === "voucher") {
      const voucherValues = payload.voucherValues
      const result = await createVoucherAction({
        title: payload.title,
        description: payload.description,
        category: payload.category ?? VoucherCategory.Service,
        ringId,
        ownerId: payload.ownerId,
        scopedLocaleIds: normalizedLocaleIds.length > 0 ? normalizedLocaleIds : undefined,
        postToFeed: payload.postToFeed,
        estimatedValue: voucherValues?.thanksValue,
        maxClaims: payload.quantityAvailable ?? 1,
        timeCommitment: voucherValues
          ? `${voucherValues.timeHours}h ${voucherValues.timeMinutes}m`
          : undefined,
        location: payload.ticketVenue ?? payload.tripOrigin ?? undefined,
      })

      if (!result.success) {
        toast({
          title: "Failed to create voucher",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      toast({
        title: "Voucher created",
        description: `Your voucher "${payload.title}" has been added to the pool.`,
      })
    } else {
      const { createOfferingResource } = await import("@/app/actions/create-resources")
      const result = await createOfferingResource({
        ...payload,
        scopedGroupIds: normalizedGroupIds.length > 0 ? normalizedGroupIds : [ringId],
        scopedLocaleIds: normalizedLocaleIds.length > 0 ? normalizedLocaleIds : undefined,
        postToFeed: payload.postToFeed,
      })

      if (!result.success) {
        toast({
          title: "Failed to create offering",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      toast({
        title: "Offering created",
        description: `Your ${payload.offeringType ?? "offering"} is now available in ${ringName}.`,
      })
    }

    setCreateModalOpen(false)
    refreshVouchers()
  }

  const handleOpenClaimDialog = (voucher: Voucher) => {
    setClaimDialogVoucher(voucher)
  }

  const handleClaimFromDialog = (voucherId: string, _notes: string) => {
    setClaimingId(voucherId)
    claimVoucherAction(voucherId).then((result) => {
      setClaimingId(null)
      if (result.success) {
        toast({
          title: "Voucher claimed",
          description: result.message,
        })
        refreshVouchers()
      } else {
        toast({
          title: "Failed to claim voucher",
          description: result.message,
          variant: "destructive",
        })
      }
    })
  }

  const handleClaimVoucher = (voucherId: string) => {
    setClaimingId(voucherId)
    claimVoucherAction(voucherId).then((result) => {
      setClaimingId(null)
      if (result.success) {
        toast({
          title: "Voucher claimed",
          description: result.message,
        })
        refreshVouchers()
      } else {
        toast({
          title: "Failed to claim voucher",
          description: result.message,
          variant: "destructive",
        })
      }
    })
  }

  const handleRedeemVoucher = (voucherId: string) => {
    setRedeemingId(voucherId)
    redeemVoucherAction(voucherId).then((result) => {
      setRedeemingId(null)
      if (result.success) {
        toast({
          title: "Voucher redeemed",
          description: result.message,
        })
        refreshVouchers()
      } else {
        toast({
          title: "Failed to redeem voucher",
          description: result.message,
          variant: "destructive",
        })
      }
    })
  }

  const getCategoryIcon = (category: VoucherCategory) => {
    switch (category) {
      case VoucherCategory.Service:
        return <Users className="h-4 w-4" />
      case VoucherCategory.Goods:
        return <Gift className="h-4 w-4" />
      case VoucherCategory.Skill:
        return <Star className="h-4 w-4" />
      case VoucherCategory.Experience:
        return <Heart className="h-4 w-4" />
      case VoucherCategory.Resource:
        return <DollarSign className="h-4 w-4" />
      default:
        return <Gift className="h-4 w-4" />
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
        return "bg-muted text-foreground"
    }
  }

  const getStatusColor = (status: VoucherStatus) => {
    switch (status) {
      case VoucherStatus.Available:
        return "bg-green-100 text-green-800"
      case VoucherStatus.Claimed:
        return "bg-yellow-100 text-yellow-800"
      case VoucherStatus.Completed:
        return "bg-blue-100 text-blue-800"
      case VoucherStatus.Expired:
        return "bg-red-100 text-red-800"
      default:
        return "bg-muted text-foreground"
    }
  }

  return (
    <div className="space-y-6">
      {/* Statistics Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total Vouchers</p>
                <p className="text-2xl font-bold">{totalVouchers}</p>
              </div>
              <Gift className="h-8 w-8 text-blue-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Available</p>
                <p className="text-2xl font-bold">{availableVouchers}</p>
              </div>
              <CheckCircle className="h-8 w-8 text-green-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">My Offers</p>
                <p className="text-2xl font-bold">{myVouchers}</p>
              </div>
              <Heart className="h-8 w-8 text-pink-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total Value</p>
                <p className="text-2xl font-bold">${totalValue}</p>
              </div>
              <DollarSign className="h-8 w-8 text-orange-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="browse" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="browse">Browse Vouchers</TabsTrigger>
          <TabsTrigger value="my-offers">My Offers</TabsTrigger>
          <TabsTrigger value="my-claims">My Claims</TabsTrigger>
        </TabsList>

        <TabsContent value="browse" className="space-y-4">
          {/* Filters and Create Button */}
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
            <div className="flex gap-2">
              <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                <SelectTrigger className="w-40">
                  <Filter className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  <SelectItem value={VoucherCategory.Service}>Services</SelectItem>
                  <SelectItem value={VoucherCategory.Goods}>Goods</SelectItem>
                  <SelectItem value={VoucherCategory.Skill}>Skills</SelectItem>
                  <SelectItem value={VoucherCategory.Experience}>Experiences</SelectItem>
                  <SelectItem value={VoucherCategory.Resource}>Resources</SelectItem>
                </SelectContent>
              </Select>

              <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value={VoucherStatus.Available}>Available</SelectItem>
                  <SelectItem value={VoucherStatus.Claimed}>Claimed</SelectItem>
                  <SelectItem value={VoucherStatus.Completed}>Completed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button onClick={() => setCreateModalOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Offer Voucher
            </Button>
          </div>

          <CreateOfferingModal
            open={createModalOpen}
            onClose={() => setCreateModalOpen(false)}
            onSubmitPayload={handleCreateFromComposer}
            title={`Offer in ${ringName}`}
            description="Start with a voucher for this ring, or switch to another offering type while keeping the ring and locale context prefilled."
            initialValues={{
              offeringType: "voucher",
              ownerId: ringId,
              scopedGroupIds: [ringId],
              scopedLocaleIds: localeIds,
              targetAgents: [{ id: ringId, name: ringName, type: "ring" }],
              postToFeed: false,
            }}
          />

          {/* Vouchers Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredVouchers.map((voucher) => {
              const offerer = members.find((u) => u.id === voucher.offeredBy) || UNKNOWN_MEMBER
              const claims = { length: voucher.currentClaims }
              const isMyVoucher = voucher.offeredBy === resolvedCurrentUserId

              return (
                <Card key={voucher.id} className="hover:shadow-md transition-shadow">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {getCategoryIcon(voucher.category)}
                        <Badge className={getCategoryColor(voucher.category)}>{voucher.category}</Badge>
                      </div>
                      <Badge className={getStatusColor(voucher.status)}>{voucher.status}</Badge>
                    </div>
                    <CardTitle className="text-lg">{voucher.title}</CardTitle>
                  </CardHeader>

                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground line-clamp-2">{voucher.description}</p>

                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={offerer.avatar || "/placeholder.svg"} alt={offerer.name} />
                        <AvatarFallback>{offerer.name.substring(0, 2)}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-medium">{offerer.name}</span>
                    </div>

                    <div className="space-y-2 text-xs text-muted-foreground">
                      {voucher.estimatedValue && (
                        <div className="flex items-center gap-1">
                          <DollarSign className="h-3 w-3" />
                          <span>Est. value: ${voucher.estimatedValue}</span>
                        </div>
                      )}

                      {voucher.timeCommitment && (
                        <div className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          <span>{voucher.timeCommitment}</span>
                        </div>
                      )}

                      {voucher.location && (
                        <div className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          <span>{voucher.location}</span>
                        </div>
                      )}

                      {voucher.maxClaims && voucher.maxClaims > 1 && (
                        <div className="flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          <span>
                            {voucher.currentClaims || 0}/{voucher.maxClaims} claimed
                          </span>
                        </div>
                      )}

                      {voucher.expiresAt && (
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          <span>Expires {new Date(voucher.expiresAt).toLocaleDateString()}</span>
                        </div>
                      )}
                    </div>

                    {!isMyVoucher && voucher.status === VoucherStatus.Available && (
                      <Button
                        onClick={() => handleOpenClaimDialog(voucher)}
                        className="w-full"
                        size="sm"
                        disabled={claimingId === voucher.id}
                      >
                        {claimingId === voucher.id ? "Claiming..." : "Claim Voucher"}
                      </Button>
                    )}

                    {isMyVoucher && (
                      <div className="text-xs text-center text-muted-foreground">
                        Your voucher • {claims.length} claims
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>

          {filteredVouchers.length === 0 && (
            <Card>
              <CardContent className="p-8 text-center">
                <Gift className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No vouchers found matching your filters.</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="my-offers" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {vouchers
              .filter((voucher) => voucher.offeredBy === resolvedCurrentUserId)
              .map((voucher) => {
                const claims = { length: voucher.currentClaims }

                return (
                  <Card key={voucher.id}>
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <Badge className={getCategoryColor(voucher.category)}>{voucher.category}</Badge>
                        <Badge className={getStatusColor(voucher.status)}>{voucher.status}</Badge>
                      </div>
                      <CardTitle className="text-lg">{voucher.title}</CardTitle>
                    </CardHeader>

                    <CardContent className="space-y-3">
                      <p className="text-sm text-muted-foreground line-clamp-2">{voucher.description}</p>

                      <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">Claims: {claims.length}</span>
                        {voucher.estimatedValue && <span className="font-medium">${voucher.estimatedValue}</span>}
                      </div>

                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" className="flex-1 bg-transparent">
                          Edit
                        </Button>
                        <Button variant="outline" size="sm" className="flex-1 bg-transparent">
                          View Claims
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
          </div>
        </TabsContent>

        <TabsContent value="my-claims" className="space-y-4">
          <div className="space-y-4">
            {vouchers
              .filter((voucher) => voucher.claimedBy === resolvedCurrentUserId)
              .map((voucher) => {
                const offerer = members.find((u) => u.id === voucher.offeredBy) || UNKNOWN_MEMBER

                return (
                  <Card key={voucher.id}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <h3 className="font-semibold">{voucher.title}</h3>
                            <Badge className={getStatusColor(voucher.status)}>{voucher.status}</Badge>
                          </div>

                          <p className="text-sm text-muted-foreground mb-3">{voucher.description}</p>

                          <div className="flex items-center gap-2">
                            <Avatar className="h-6 w-6">
                              <AvatarImage src={offerer.avatar || "/placeholder.svg"} alt={offerer.name} />
                              <AvatarFallback>{offerer.name.substring(0, 2)}</AvatarFallback>
                            </Avatar>
                            <span className="text-sm">Offered by {offerer.name}</span>
                          </div>

                          {voucher.claimedAt && (
                            <p className="text-xs text-muted-foreground mt-2">
                              Claimed on {new Date(voucher.claimedAt).toLocaleDateString()}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-col gap-2">
                          <Button variant="outline" size="sm">
                            Contact
                          </Button>
                          {voucher.status === VoucherStatus.Claimed && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={redeemingId === voucher.id}
                              onClick={() => handleRedeemVoucher(voucher.id)}
                            >
                              {redeemingId === voucher.id ? "Redeeming..." : "Redeem"}
                            </Button>
                          )}
                          {voucher.status === VoucherStatus.Completed && (
                            <Button variant="outline" size="sm">
                              Rate
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
          </div>
        </TabsContent>
      </Tabs>

      {/* Voucher claim dialog */}
      <VoucherClaimDialog
        voucher={claimDialogVoucher}
        isOpen={!!claimDialogVoucher}
        onClose={() => setClaimDialogVoucher(null)}
        onClaim={handleClaimFromDialog}
        members={members}
      />
    </div>
  )
}
