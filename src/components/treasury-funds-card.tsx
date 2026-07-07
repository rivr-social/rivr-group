"use client"

/**
 * Treasury funds card — renders inside the group Treasury tab for admins.
 *
 * Named sub-pools of the group's main treasury ("Operations Fund",
 * "Land Fund", …): lists every fund with its internal balance, assigned
 * subgroups, FA/card status; supports creating funds, renaming/archiving,
 * assigning subgroups (one fund per subgroup), and moving money between the
 * main treasury and a fund via the internal ledger transfer.
 *
 * Dormant-flag aware like SubgroupBankingCard: while Stripe Treasury /
 * Issuing are not enabled on the platform the banking actions explain that
 * instead of surfacing dead buttons — the internal-ledger features work
 * regardless.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Archive,
  ArchiveRestore,
  Banknote,
  CreditCard,
  Landmark,
  Loader2,
  MoreHorizontal,
  PiggyBank,
  Plus,
  Users,
} from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  assignSubgroupToFundAction,
  createFundAction,
  getGroupTreasuryFundsOverviewAction,
  issueFundCardAction,
  provisionFundFinancialAccountAction,
  transferFundBalanceAction,
  unassignSubgroupFromFundAction,
  updateFundAction,
} from "@/app/actions/wallet"
import type {
  FundTransferDirection,
  GroupTreasuryFundsOverview,
  TreasuryFundRow,
} from "@/app/actions/wallet"

interface TreasuryFundsCardProps {
  groupId: string
}

type FundDialogMode = "rename" | "assign" | "move" | null

function formatUsd(cents: number | null): string {
  if (cents === null) return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

export function TreasuryFundsCard({ groupId }: TreasuryFundsCardProps) {
  const [overview, setOverview] = useState<GroupTreasuryFundsOverview | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [pendingFundId, setPendingFundId] = useState<string | null>(null)

  // Create-fund form
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [newFundName, setNewFundName] = useState("")
  const [newFundDescription, setNewFundDescription] = useState("")
  const [isCreating, setIsCreating] = useState(false)

  // Per-fund dialogs (rename / assign subgroup / move money)
  const [dialogMode, setDialogMode] = useState<FundDialogMode>(null)
  const [dialogFund, setDialogFund] = useState<TreasuryFundRow | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [assignSubgroupId, setAssignSubgroupId] = useState("")
  const [moveDirection, setMoveDirection] = useState<FundTransferDirection>("to_fund")
  const [moveAmount, setMoveAmount] = useState("")
  const [isSubmittingDialog, setIsSubmittingDialog] = useState(false)

  const { toast } = useToast()

  const loadOverview = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await getGroupTreasuryFundsOverviewAction(groupId)
      if (result.success && result.overview) {
        setOverview(result.overview)
      }
    } finally {
      setIsLoading(false)
    }
  }, [groupId])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const closeDialog = () => {
    setDialogMode(null)
    setDialogFund(null)
    setRenameValue("")
    setAssignSubgroupId("")
    setMoveDirection("to_fund")
    setMoveAmount("")
  }

  const openDialog = (mode: Exclude<FundDialogMode, null>, fund: TreasuryFundRow) => {
    setDialogFund(fund)
    setDialogMode(mode)
    if (mode === "rename") setRenameValue(fund.name)
  }

  const handleCreateFund = async () => {
    const name = newFundName.trim()
    if (!name) {
      toast({ title: "Fund name required", description: "Give the fund a name first.", variant: "destructive" })
      return
    }
    setIsCreating(true)
    try {
      const result = await createFundAction(groupId, {
        name,
        description: newFundDescription.trim() || undefined,
      })
      if (result.success) {
        toast({ title: "Fund created", description: `"${name}" is ready in the treasury.` })
        setNewFundName("")
        setNewFundDescription("")
        setIsCreateOpen(false)
        await loadOverview()
      } else {
        toast({ title: "Could not create fund", description: result.error, variant: "destructive" })
      }
    } finally {
      setIsCreating(false)
    }
  }

  const handleRename = async () => {
    if (!dialogFund) return
    const name = renameValue.trim()
    if (!name) {
      toast({ title: "Fund name required", description: "The fund needs a name.", variant: "destructive" })
      return
    }
    setIsSubmittingDialog(true)
    try {
      const result = await updateFundAction(groupId, dialogFund.fundId, { name })
      if (result.success) {
        toast({ title: "Fund renamed", description: `The fund is now "${name}".` })
        closeDialog()
        await loadOverview()
      } else {
        toast({ title: "Could not rename fund", description: result.error, variant: "destructive" })
      }
    } finally {
      setIsSubmittingDialog(false)
    }
  }

  const handleToggleArchive = async (fund: TreasuryFundRow) => {
    setPendingFundId(fund.fundId)
    try {
      const result = await updateFundAction(groupId, fund.fundId, { archived: !fund.archived })
      if (result.success) {
        toast({
          title: fund.archived ? "Fund restored" : "Fund archived",
          description: fund.archived
            ? `"${fund.name}" is active again.`
            : `"${fund.name}" is archived. Its subgroups are unassigned.`,
        })
        await loadOverview()
      } else {
        toast({
          title: fund.archived ? "Could not restore fund" : "Could not archive fund",
          description: result.error,
          variant: "destructive",
        })
      }
    } finally {
      setPendingFundId(null)
    }
  }

  const handleAssignSubgroup = async () => {
    if (!dialogFund || !assignSubgroupId) return
    setIsSubmittingDialog(true)
    try {
      const result = await assignSubgroupToFundAction(groupId, dialogFund.fundId, assignSubgroupId)
      if (result.success) {
        toast({ title: "Subgroup assigned", description: `The subgroup now belongs to "${dialogFund.name}".` })
        closeDialog()
        await loadOverview()
      } else {
        toast({ title: "Could not assign subgroup", description: result.error, variant: "destructive" })
      }
    } finally {
      setIsSubmittingDialog(false)
    }
  }

  const handleUnassignSubgroup = async (fund: TreasuryFundRow, subgroupId: string) => {
    setPendingFundId(fund.fundId)
    try {
      const result = await unassignSubgroupFromFundAction(groupId, fund.fundId, subgroupId)
      if (result.success) {
        toast({ title: "Subgroup unassigned", description: `Removed from "${fund.name}".` })
        await loadOverview()
      } else {
        toast({ title: "Could not unassign subgroup", description: result.error, variant: "destructive" })
      }
    } finally {
      setPendingFundId(null)
    }
  }

  const handleMoveMoney = async () => {
    if (!dialogFund) return
    const amountDollars = Number.parseFloat(moveAmount)
    if (!Number.isFinite(amountDollars) || amountDollars <= 0) {
      toast({ title: "Invalid amount", description: "Enter a positive dollar amount.", variant: "destructive" })
      return
    }
    const amountCents = Math.round(amountDollars * 100)
    setIsSubmittingDialog(true)
    try {
      const result = await transferFundBalanceAction(groupId, dialogFund.fundId, amountCents, moveDirection)
      if (result.success) {
        toast({
          title: "Money moved",
          description:
            moveDirection === "to_fund"
              ? `${formatUsd(amountCents)} allocated to "${dialogFund.name}".`
              : `${formatUsd(amountCents)} returned to the main treasury.`,
        })
        closeDialog()
        await loadOverview()
      } else {
        toast({ title: "Could not move money", description: result.error, variant: "destructive" })
      }
    } finally {
      setIsSubmittingDialog(false)
    }
  }

  const handleProvision = async (fund: TreasuryFundRow) => {
    setPendingFundId(fund.fundId)
    try {
      const result = await provisionFundFinancialAccountAction(groupId, fund.fundId)
      if (result.success) {
        toast({ title: "Fund account ready", description: `"${fund.name}" now has its own financial account.` })
        await loadOverview()
      } else {
        toast({ title: "Could not provision", description: result.error, variant: "destructive" })
      }
    } finally {
      setPendingFundId(null)
    }
  }

  const handleIssueCard = async (fund: TreasuryFundRow) => {
    setPendingFundId(fund.fundId)
    try {
      const result = await issueFundCardAction(groupId, fund.fundId)
      if (result.success) {
        toast({
          title: "Card issued",
          description: result.last4 ? `Virtual card ending in ${result.last4} is active.` : "Virtual card is active.",
        })
        await loadOverview()
      } else {
        toast({ title: "Could not issue card", description: result.error, variant: "destructive" })
      }
    } finally {
      setPendingFundId(null)
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading treasury funds…
        </CardContent>
      </Card>
    )
  }

  if (!overview) return null

  const activeFunds = overview.funds.filter((fund) => !fund.archived)
  const archivedFunds = overview.funds.filter((fund) => fund.archived)

  const renderFundRow = (fund: TreasuryFundRow) => {
    const isPending = pendingFundId === fund.fundId
    return (
      <div
        key={fund.fundId}
        className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate font-medium">
            {fund.name}
            {fund.archived && <Badge variant="secondary">Archived</Badge>}
          </p>
          {fund.description && (
            <p className="truncate text-xs text-muted-foreground">{fund.description}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <PiggyBank className="h-3.5 w-3.5" /> {formatUsd(fund.balanceCents)}
            </span>
            {fund.financialAccountId ? (
              <span className="flex items-center gap-1">
                <Banknote className="h-3.5 w-3.5" /> FA {formatUsd(fund.faCashCents)}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <Banknote className="h-3.5 w-3.5" /> No bank account yet
              </span>
            )}
            {fund.assignedSubgroups.map((subgroup) => (
              <Badge key={subgroup.id} variant="outline" className="flex items-center gap-1">
                <Users className="h-3 w-3" /> {subgroup.name}
              </Badge>
            ))}
            {fund.cards.map((card) => (
              <Badge key={card.id} variant="outline" className="flex items-center gap-1">
                <CreditCard className="h-3 w-3" /> •••• {card.last4}
                {card.spendingLimitCents !== null && (
                  <span className="text-muted-foreground">
                    ({formatUsd(card.spendingLimitCents)}/{card.spendingLimitInterval ?? "month"})
                  </span>
                )}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={isPending} aria-label={`Fund actions for ${fund.name}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!fund.archived && (
                <>
                  <DropdownMenuItem onClick={() => openDialog("move", fund)}>
                    Move money
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openDialog("assign", fund)}>
                    Assign subgroup
                  </DropdownMenuItem>
                  {fund.assignedSubgroups.map((subgroup) => (
                    <DropdownMenuItem
                      key={subgroup.id}
                      onClick={() => handleUnassignSubgroup(fund, subgroup.id)}
                    >
                      Unassign {subgroup.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => openDialog("rename", fund)}>
                    Rename
                  </DropdownMenuItem>
                  {overview.treasuryEnabled && !fund.financialAccountId && (
                    <DropdownMenuItem onClick={() => handleProvision(fund)}>
                      Create bank account
                    </DropdownMenuItem>
                  )}
                  {overview.treasuryEnabled && overview.issuingEnabled && fund.financialAccountId && (
                    <DropdownMenuItem onClick={() => handleIssueCard(fund)}>
                      Issue card
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={() => handleToggleArchive(fund)}>
                {fund.archived ? (
                  <span className="flex items-center gap-2">
                    <ArchiveRestore className="h-4 w-4" /> Restore
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Archive className="h-4 w-4" /> Archive
                  </span>
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Landmark className="h-4 w-4" /> Treasury funds
            </CardTitle>
            <CardDescription>
              Named sub-pools of the main treasury ({formatUsd(overview.mainTreasuryBalanceCents)} unallocated).
              Assign subgroups to a fund and move money with internal ledger transfers.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setIsCreateOpen((open) => !open)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> New fund
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isCreateOpen && (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="space-y-1">
              <Label htmlFor="treasury-fund-name">Fund name</Label>
              <Input
                id="treasury-fund-name"
                value={newFundName}
                onChange={(event) => setNewFundName(event.target.value)}
                placeholder="Operations Fund"
                maxLength={120}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="treasury-fund-description">Description (optional)</Label>
              <Input
                id="treasury-fund-description"
                value={newFundDescription}
                onChange={(event) => setNewFundDescription(event.target.value)}
                placeholder="What this fund pays for"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setIsCreateOpen(false)} disabled={isCreating}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleCreateFund} disabled={isCreating}>
                {isCreating && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                Create fund
              </Button>
            </div>
          </div>
        )}

        {!overview.treasuryEnabled && (
          <p className="text-sm text-muted-foreground">
            Stripe Treasury is not enabled on this platform yet — fund bank accounts and cards
            activate automatically once it is. Internal fund balances and transfers work today.
          </p>
        )}
        {overview.treasuryEnabled && !overview.issuingEnabled && (
          <p className="text-sm text-muted-foreground">
            Card issuing is not enabled on this platform yet; fund cards activate automatically once it is.
          </p>
        )}

        {activeFunds.length === 0 && archivedFunds.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No funds yet. Create one to earmark part of the treasury.
          </p>
        )}

        {activeFunds.map(renderFundRow)}
        {archivedFunds.map(renderFundRow)}
      </CardContent>

      {/* Rename dialog */}
      <Dialog open={dialogMode === "rename"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename fund</DialogTitle>
            <DialogDescription>Fund names are unique within the treasury.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="treasury-fund-rename">Fund name</Label>
            <Input
              id="treasury-fund-rename"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={120}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog} disabled={isSubmittingDialog}>
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={isSubmittingDialog}>
              {isSubmittingDialog && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign-subgroup dialog */}
      <Dialog open={dialogMode === "assign"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign a subgroup to {dialogFund?.name}</DialogTitle>
            <DialogDescription>
              A subgroup belongs to at most one fund — assigning it here moves it out of any other fund.
            </DialogDescription>
          </DialogHeader>
          {overview.subgroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">This group has no subgroups yet.</p>
          ) : (
            <Select value={assignSubgroupId} onValueChange={setAssignSubgroupId}>
              <SelectTrigger aria-label="Subgroup to assign">
                <SelectValue placeholder="Choose a subgroup" />
              </SelectTrigger>
              <SelectContent>
                {overview.subgroups.map((subgroup) => (
                  <SelectItem key={subgroup.id} value={subgroup.id}>
                    {subgroup.name}
                    {subgroup.assignedFundId && subgroup.assignedFundId !== dialogFund?.fundId
                      ? " (in another fund)"
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog} disabled={isSubmittingDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleAssignSubgroup}
              disabled={isSubmittingDialog || !assignSubgroupId}
            >
              {isSubmittingDialog && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move-money dialog */}
      <Dialog open={dialogMode === "move"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move money — {dialogFund?.name}</DialogTitle>
            <DialogDescription>
              Internal transfer between the main treasury ({formatUsd(overview.mainTreasuryBalanceCents)}) and this
              fund ({formatUsd(dialogFund?.balanceCents ?? 0)}).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Direction</Label>
              <Select
                value={moveDirection}
                onValueChange={(value) => setMoveDirection(value as FundTransferDirection)}
              >
                <SelectTrigger aria-label="Transfer direction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="to_fund">Main treasury → fund</SelectItem>
                  <SelectItem value="to_main">Fund → main treasury</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="treasury-fund-amount">Amount (USD)</Label>
              <Input
                id="treasury-fund-amount"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={moveAmount}
                onChange={(event) => setMoveAmount(event.target.value)}
                placeholder="100.00"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog} disabled={isSubmittingDialog}>
              Cancel
            </Button>
            <Button onClick={handleMoveMoney} disabled={isSubmittingDialog || !moveAmount}>
              {isSubmittingDialog && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Move money
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
