"use client"

import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement } from "react"
import { cloneElement, isValidElement, useEffect, useState } from "react"
import { useSession } from "next-auth/react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Heart,
  DollarSign,
  Gift,
  Package,
  Wrench,
  GraduationCap,
  Send,
  User,
  Clock,
  MapPin,
} from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { getMyWalletAction, sendMoneyAction } from "@/app/actions/wallet"
import { fetchResourcesByOwner } from "@/app/actions/graph"
import type { SerializedResource } from "@/lib/graph-serializers"
import { sendThanksTokensAction, sendVoucherAction } from "@/app/actions/interactions"
import { SearchableMultiSelect } from "@/components/searchable-select"

interface ThankModuleProps {
  recipientId: string
  recipientName: string
  recipientAvatar?: string
  triggerButton?: React.ReactNode
  context?: string
  contextId?: string
  /** When true, renders the thank form inline without a Dialog wrapper. */
  inline?: boolean
}

type ThankAssetType = "thanks" | "money" | "voucher"
type VoucherType = "product" | "service" | "skill" | "voucher"

interface Voucher {
  id: string
  title: string
  description: string
  type: VoucherType
  category: string
  value?: number
  duration?: string
  location?: string
}

interface ThanksToken {
  id: string
  enteredAccountAt?: string
  createdAt: string
}

interface PendingThanksVoucherFlow {
  recipientId: string
  recipientName: string
  recipientAvatar?: string
  returnPath: string
  selectedVoucherIds: string[]
  thanksMessage: string
  createdVoucherId?: string
  reopen?: boolean
}

const THANKS_VOUCHER_FLOW_KEY = "rivr:thanks-voucher-flow"

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export function ThankModule({
  recipientId,
  recipientName,
  recipientAvatar,
  triggerButton,
  context: _context,
  contextId,
  inline = false,
}: ThankModuleProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isOpen, setIsOpen] = useState(false)
  const [assetType, setAssetType] = useState<ThankAssetType>("thanks")
  const [selectedVoucherIds, setSelectedVoucherIds] = useState<string[]>([])
  const [moneyAmount, setMoneyAmount] = useState<string>("")
  const [thanksMessage, setThanksMessage] = useState<string>("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [myVouchers, setMyVouchers] = useState<Voucher[]>([])
  const [myThanksTokens, setMyThanksTokens] = useState<ThanksToken[]>([])
  const [thanksQuantity, setThanksQuantity] = useState<string>("1")
  const [walletBalanceDollars, setWalletBalanceDollars] = useState<number>(0)
  const { toast } = useToast()
  const { data: session } = useSession()

  const currentPath = `${pathname}${searchParams?.toString() ? `?${searchParams.toString()}` : ""}`

  useEffect(() => {
    let cancelled = false

    async function loadVouchers() {
      if (!session?.user?.id) {
        if (!cancelled) setMyVouchers([])
        return
      }

      const resources = await fetchResourcesByOwner(session.user.id).catch(() => [] as SerializedResource[])
      if (cancelled) return

      const vouchers = resources
        .filter((resource) => {
          const metadata = asRecord(resource.metadata)
          const kind = String(metadata.resourceKind ?? "").toLowerCase()
          return resource.type === "voucher" || kind === "voucher"
        })
        .map((resource) => {
          const metadata = asRecord(resource.metadata)
          const rawType = String(metadata.voucherType ?? metadata.offerType ?? resource.type).toLowerCase()
          const normalizedType: VoucherType =
            rawType === "product" || rawType === "service" || rawType === "skill"
              ? (rawType as VoucherType)
              : "voucher"

          return {
            id: resource.id,
            title: resource.name,
            description: resource.description ?? resource.content ?? "",
            type: normalizedType,
            category: String(metadata.category ?? "General"),
            value: typeof metadata.value === "number" ? metadata.value : undefined,
            duration: typeof metadata.duration === "string" ? metadata.duration : undefined,
            location: typeof metadata.location === "string" ? metadata.location : undefined,
          }
        })

      const thanksTokens = resources
        .filter((resource) => resource.type === "thanks_token" || String(asRecord(resource.metadata).entityType ?? "").toLowerCase() === "thanks_token")
        .map((resource) => {
          const metadata = asRecord(resource.metadata)
          return {
            id: resource.id,
            enteredAccountAt: typeof metadata.enteredAccountAt === "string"
              ? metadata.enteredAccountAt
              : typeof metadata.lastTransferredAt === "string"
                ? metadata.lastTransferredAt
                : undefined,
            createdAt: resource.createdAt,
          }
        })
        .sort((a, b) => {
          const aTime = new Date(a.enteredAccountAt ?? a.createdAt).getTime()
          const bTime = new Date(b.enteredAccountAt ?? b.createdAt).getTime()
          return aTime - bTime
        })

      setMyVouchers(vouchers)
      setMyThanksTokens(thanksTokens)

      const walletResult = await getMyWalletAction().catch(() => null)
      if (!cancelled && walletResult?.success && walletResult.wallet) {
        setWalletBalanceDollars(walletResult.wallet.balanceDollars)
      }
    }

    void loadVouchers()
    return () => {
      cancelled = true
    }
  }, [session?.user?.id])

  useEffect(() => {
    if (typeof window === "undefined") return
    const raw = window.sessionStorage.getItem(THANKS_VOUCHER_FLOW_KEY)
    if (!raw) return

    try {
      const pending = JSON.parse(raw) as PendingThanksVoucherFlow
      if (!pending.reopen || pending.recipientId !== recipientId || pending.returnPath !== currentPath) {
        return
      }

      setAssetType("voucher")
      setThanksMessage(pending.thanksMessage ?? "")
      setSelectedVoucherIds(
        Array.from(
          new Set([
            ...(pending.selectedVoucherIds ?? []),
            ...(pending.createdVoucherId ? [pending.createdVoucherId] : []),
          ]),
        ),
      )
      setIsOpen(true)

      window.sessionStorage.removeItem(THANKS_VOUCHER_FLOW_KEY)
    } catch {
      window.sessionStorage.removeItem(THANKS_VOUCHER_FLOW_KEY)
    }
  }, [currentPath, recipientId])

  useEffect(() => {
    if (!isOpen && !inline) return
    if (myThanksTokens.length > 0) {
      setAssetType("thanks")
      setThanksQuantity((current) => {
        const numeric = Number.parseInt(current, 10)
        if (Number.isFinite(numeric) && numeric > 0 && numeric <= myThanksTokens.length) return current
        return "1"
      })
      return
    }
    if (walletBalanceDollars > 0) {
      setAssetType("money")
      return
    }
      if (myVouchers.length > 0) {
        setAssetType("voucher")
      }
  }, [isOpen, inline, myThanksTokens.length, myVouchers.length, walletBalanceDollars])

  const handleSubmit = async () => {
    if (isSubmitting) return
    setIsSubmitting(true)

    try {
      if (assetType === "money") {
        const dollars = parseFloat(moneyAmount)
        if (isNaN(dollars) || dollars <= 0) {
          toast({
            title: "Invalid amount",
            description: "Please enter a valid dollar amount.",
            variant: "destructive",
          })
          setIsSubmitting(false)
          return
        }

        const amountCents = Math.round(dollars * 100)
        const result = await sendMoneyAction(recipientId, amountCents, thanksMessage || undefined)
        if (!result.success) {
          toast({
            title: "Transfer failed",
            description: result.error ?? "Unable to send money. Please try again.",
            variant: "destructive",
          })
          setIsSubmitting(false)
          return
        }

        toast({
          title: "Gift sent successfully",
          description: `$${dollars.toFixed(2)} sent to ${recipientName}!`,
        })
      } else if (assetType === "thanks") {
        const quantity = Number.parseInt(thanksQuantity, 10)
        if (!Number.isFinite(quantity) || quantity <= 0) {
          toast({
            title: "Choose a quantity",
            description: "Select how many thanks tokens to send.",
            variant: "destructive",
          })
          setIsSubmitting(false)
          return
        }

        const result = await sendThanksTokensAction(recipientId, quantity, thanksMessage || undefined, contextId)
        if (!result.success) {
          toast({
            title: "Transfer failed",
            description: result.message,
            variant: "destructive",
          })
          setIsSubmitting(false)
          return
        }

        toast({
          title: "Thanks sent",
          description: `${quantity} thanks token${quantity === 1 ? "" : "s"} ${quantity === 1 ? "was" : "were"} sent to ${recipientName}.`,
        })
      } else if (assetType === "voucher") {
        if (selectedVoucherIds.length === 0) {
          toast({
            title: "Choose a voucher",
            description: "Select at least one voucher to send.",
            variant: "destructive",
          })
          setIsSubmitting(false)
          return
        }

        for (const voucherId of selectedVoucherIds) {
          const giftResult = await sendVoucherAction(voucherId, recipientId, thanksMessage || undefined, contextId)
          if (!giftResult.success) {
            toast({
              title: "Voucher send failed",
              description: giftResult.message,
              variant: "destructive",
            })
            setIsSubmitting(false)
            return
          }
        }

        const selectedTitles = myVouchers
          .filter((voucher) => selectedVoucherIds.includes(voucher.id))
          .map((voucher) => voucher.title)
        toast({
          title: "Gift sent successfully",
          description:
            selectedTitles.length > 1
              ? `${selectedTitles.length} vouchers sent to ${recipientName}!`
              : `${selectedTitles[0] || "Voucher"} sent to ${recipientName}!`,
        })
      }

      setIsOpen(false)
      setAssetType("thanks")
      setThanksQuantity("1")
      setSelectedVoucherIds([])
      setMoneyAmount("")
      setThanksMessage("")
    } catch {
      toast({
        title: "Something went wrong",
        description: "An unexpected error occurred. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const getVoucherIcon = (type: VoucherType) => {
    switch (type) {
      case "product":
        return <Package className="h-4 w-4" />
      case "service":
        return <Wrench className="h-4 w-4" />
      case "skill":
        return <GraduationCap className="h-4 w-4" />
      default:
        return <Gift className="h-4 w-4" />
    }
  }

  const isFormValid = () => {
    if (assetType === "thanks") {
      const quantity = Number.parseInt(thanksQuantity, 10)
      return Number.isFinite(quantity) && quantity > 0 && quantity <= myThanksTokens.length
    }
    if (assetType === "money") return moneyAmount !== "" && parseFloat(moneyAmount) > 0
    if (assetType === "voucher") return selectedVoucherIds.length > 0
    return false
  }

  const handleCreateVoucher = () => {
    if (typeof window !== "undefined") {
      const pending: PendingThanksVoucherFlow = {
        recipientId,
        recipientName,
        recipientAvatar,
        returnPath: currentPath,
        selectedVoucherIds,
        thanksMessage,
        reopen: true,
      }
      window.sessionStorage.setItem(THANKS_VOUCHER_FLOW_KEY, JSON.stringify(pending))
    }

    router.push(`/create?offering=voucher&returnToThanks=1&returnPath=${encodeURIComponent(currentPath)}`)
  }

  const voucherOptions = myVouchers.map((voucher) => ({
    value: voucher.id,
    label: voucher.title,
    description: voucher.description || voucher.category,
    keywords: [voucher.category, voucher.type, voucher.location ?? "", voucher.duration ?? ""],
  }))

  const openDialog = (event?: { stopPropagation?: () => void; preventDefault?: () => void }) => {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    setIsOpen(true)
  }

  const trigger = isValidElement(triggerButton)
    ? cloneElement(triggerButton as ReactElement<Record<string, unknown>>, {
        ...(((triggerButton as ReactElement<Record<string, unknown>>).props ?? {}) as Record<string, unknown>),
        onClick: (event: ReactMouseEvent) => {
          ;((triggerButton as ReactElement<{ onClick?: (event: ReactMouseEvent) => void }>).props?.onClick)?.(event)
          openDialog(event)
        },
        onMouseDown: (event: ReactMouseEvent) => {
          ;((triggerButton as ReactElement<{ onMouseDown?: (event: ReactMouseEvent) => void }>).props?.onMouseDown)?.(event)
          event.stopPropagation()
        },
        onPointerDown: (event: ReactPointerEvent) => {
          ;((triggerButton as ReactElement<{ onPointerDown?: (event: ReactPointerEvent) => void }>).props?.onPointerDown)?.(event)
          event.stopPropagation()
        },
      })
    : (
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={openDialog}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Heart className="h-4 w-4 mr-2" />
          Thank
        </Button>
      )

  const thankContent = (
    <div className="space-y-4">
      {!inline && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Avatar className="h-12 w-12">
                <AvatarImage src={recipientAvatar || "/placeholder.svg"} alt={recipientName} />
                <AvatarFallback>{recipientName.substring(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div>
                <h3 className="font-semibold">{recipientName}</h3>
                <p className="text-sm text-muted-foreground">Send thanks, money, or a voucher.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-3 gap-2">
        <Button
          variant={assetType === "thanks" ? "default" : "outline"}
          size="sm"
          type="button"
          onClick={() => setAssetType("thanks")}
          className="flex flex-col h-auto py-3"
        >
          <Heart className="h-4 w-4 mb-1" />
          <span className="text-xs">Thanks</span>
        </Button>
        <Button
          variant={assetType === "money" ? "default" : "outline"}
          size="sm"
          type="button"
          onClick={() => setAssetType("money")}
          className="flex flex-col h-auto py-3"
        >
          <DollarSign className="h-4 w-4 mb-1" />
          <span className="text-xs">Money</span>
        </Button>
        <Button
          variant={assetType === "voucher" ? "default" : "outline"}
          size="sm"
          type="button"
          onClick={() => setAssetType("voucher")}
          className="flex flex-col h-auto py-3"
        >
          <Gift className="h-4 w-4 mb-1" />
          <span className="text-xs">Voucher</span>
        </Button>
      </div>

      {assetType === "thanks" && (
        <div className="space-y-3">
          <Label htmlFor="thanks-quantity">How many Thanks</Label>
          {myThanksTokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">You don&apos;t have any thanks tokens yet.</p>
          ) : (
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{myThanksTokens.length} available</p>
                    <p className="text-xs text-muted-foreground">
                      Oldest tokens in your account are sent first.
                    </p>
                  </div>
                  <Badge variant="secondary">Thanks</Badge>
                </div>
                <Input
                  id="thanks-quantity"
                  type="number"
                  min="1"
                  max={String(myThanksTokens.length)}
                  step="1"
                  value={thanksQuantity}
                  onChange={(event) => setThanksQuantity(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Based on demurrage order, the oldest {Number.parseInt(thanksQuantity, 10) === 1 ? "token" : "tokens"} in your account will be delivered first.
                </p>
              </CardContent>
            </Card>
          )}
          <Label htmlFor="thanks-message">Message</Label>
          <Textarea
            id="thanks-message"
            placeholder="What are you grateful for?"
            value={thanksMessage}
            onChange={(e) => setThanksMessage(e.target.value)}
            rows={3}
          />
        </div>
      )}

      {assetType === "money" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Available wallet balance: ${walletBalanceDollars.toFixed(2)}
          </p>
          <div>
            <Label htmlFor="money-amount">Amount</Label>
            <div className="relative mt-1">
              <DollarSign className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="money-amount"
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                className="pl-9"
                value={moneyAmount}
                onChange={(e) => setMoneyAmount(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="money-message">Message</Label>
            <Textarea
              id="money-message"
              placeholder="Add a note with your gift..."
              value={thanksMessage}
              onChange={(e) => setThanksMessage(e.target.value)}
              rows={2}
            />
          </div>
        </div>
      )}

      {assetType === "voucher" && (
        <div className="space-y-3">
          <Label>Select Voucher</Label>
          {myVouchers.length === 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">You don&apos;t have any vouchers to send yet.</p>
              <Button type="button" variant="outline" onClick={handleCreateVoucher}>
                Create Voucher
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <SearchableMultiSelect
                value={selectedVoucherIds}
                onChange={setSelectedVoucherIds}
                options={voucherOptions}
                placeholder="Select one or more vouchers"
                searchPlaceholder="Search vouchers..."
                emptyLabel="No vouchers found."
              />
              <div className="flex justify-end">
                <Button type="button" variant="outline" onClick={handleCreateVoucher}>
                  Create Voucher
                </Button>
              </div>
              <div className="space-y-2">
                {myVouchers
                  .filter((voucher) => selectedVoucherIds.includes(voucher.id))
                  .map((voucher) => (
                    <Card key={voucher.id}>
                      <CardContent className="p-3">
                        <div className="flex items-start gap-3">
                          <div className="mt-1 rounded-full bg-muted p-2">
                            {getVoucherIcon(voucher.type)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <h4 className="font-medium truncate">{voucher.title}</h4>
                              <Badge variant="outline" className="shrink-0">
                                {voucher.category}
                              </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                              {voucher.description}
                            </p>
                            <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                              {voucher.value ? (
                                <span className="flex items-center gap-1">
                                  <DollarSign className="h-3 w-3" />
                                  {voucher.value}
                                </span>
                              ) : null}
                              {voucher.duration ? (
                                <span className="flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  {voucher.duration}
                                </span>
                              ) : null}
                              {voucher.location ? (
                                <span className="flex items-center gap-1 truncate">
                                  <MapPin className="h-3 w-3" />
                                  {voucher.location}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="voucher-message">Message (optional)</Label>
            <Textarea
              id="voucher-message"
              placeholder="Add a note with your voucher..."
              value={thanksMessage}
              onChange={(e) => setThanksMessage(e.target.value)}
              rows={2}
            />
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        {!inline && (
          <Button type="button" variant="outline" onClick={() => setIsOpen(false)} className="flex-1">
            Cancel
          </Button>
        )}
        <Button type="button" onClick={() => void handleSubmit()} disabled={!isFormValid() || isSubmitting || !session} className="flex-1">
          <Send className="h-4 w-4 mr-2" />
          {isSubmitting ? "Sending..." : `Send ${assetType === "thanks" ? "Thanks" : assetType === "money" ? "Gift" : "Voucher"}`}
        </Button>
      </div>

      {!session && (
        <p className="text-sm text-center text-muted-foreground">
          <User className="h-4 w-4 inline mr-1" />
          Sign in to send thanks, money, or vouchers.
        </p>
      )}
    </div>
  )

  if (inline) {
    return thankContent
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {trigger}
      <DialogContent
        className="sm:max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Heart className="h-5 w-5 text-primary" />
            Thank {recipientName}
          </DialogTitle>
        </DialogHeader>
        {thankContent}
      </DialogContent>
    </Dialog>
  )
}
