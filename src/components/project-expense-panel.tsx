/**
 * @fileoverview ProjectExpensePanel - records and lists first-class project
 * expenses (debits out of the project treasury to external payees).
 *
 * Renders on the project detail page's Treasury tab. Project controllers (owner
 * or write-capable members of the owning group/org) can record an expense, which
 * debits the project treasury via `recordProjectExpenseAction`
 * (`type = 'project_expense'`, no receiving internal wallet). Non-controllers and
 * everyone see the recent-expenses list (read-only).
 *
 * Key props: projectId, currency, balanceCents, canManage, initialExpenses
 */
"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Receipt, Loader2, ArrowLeftRight } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { recordProjectExpenseAction } from "@/app/actions/wallet/expenses"
import {
  transferProjectBalanceAction,
  type ProjectFundingDirection,
} from "@/app/actions/wallet/project-funding"

/** A recorded expense transaction as shown in the list. */
export interface ProjectExpenseView {
  id: string
  amountCents: number
  description: string | null
  createdAt: string | Date
  status: string
}

interface ProjectExpensePanelProps {
  projectId: string
  /**
   * The owning group agent id, enabling the treasury ⇄ project Move-money
   * controls; null hides them (personally-owned projects have no group
   * treasury to apportion from).
   */
  groupId: string | null
  currency: string
  /** Current treasury balance, used to client-validate affordability. */
  balanceCents: number
  /** Whether the viewer may record expenses (project controller). */
  canManage: boolean
  initialExpenses: ProjectExpenseView[]
}

/** Smallest recordable expense in cents (mirrors MIN_TRANSFER_CENTS server-side). */
const MIN_EXPENSE_CENTS = 50

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "USD").toUpperCase(),
  }).format(cents / 100)
}

function formatDate(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
}

export function ProjectExpensePanel({
  projectId,
  groupId,
  currency,
  balanceCents,
  canManage,
  initialExpenses,
}: ProjectExpensePanelProps) {
  const router = useRouter()
  const { toast } = useToast()

  const [amount, setAmount] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState("")
  const [payee, setPayee] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  // Treasury ⇄ project Move-money controls.
  const [moveAmount, setMoveAmount] = useState("")
  const [moveDirection, setMoveDirection] = useState<ProjectFundingDirection>("to_project")
  const [isMoving, setIsMoving] = useState(false)

  const parsedMoveDollars = Number.parseFloat(moveAmount)
  const moveAmountCents =
    Number.isFinite(parsedMoveDollars) && parsedMoveDollars > 0 ? Math.round(parsedMoveDollars * 100) : 0
  const moveExceedsProject = moveDirection === "to_main" && moveAmountCents > balanceCents
  const moveBelowMinimum = moveAmountCents > 0 && moveAmountCents < MIN_EXPENSE_CENTS
  const canMove =
    canManage && !!groupId && !isMoving && moveAmountCents >= MIN_EXPENSE_CENTS && !moveExceedsProject

  async function handleMove() {
    if (!canMove || !groupId) return
    setIsMoving(true)
    try {
      const result = await transferProjectBalanceAction(groupId, projectId, moveAmountCents, moveDirection)
      if (!result.success) {
        toast({
          title: "Could not move money",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        })
        return
      }
      toast({
        title: "Money moved",
        description:
          moveDirection === "to_project"
            ? `${formatMoney(moveAmountCents, currency)} allocated from the group treasury.`
            : `${formatMoney(moveAmountCents, currency)} returned to the group treasury.`,
      })
      setMoveAmount("")
      router.refresh()
    } catch (error) {
      console.error("transferProjectBalanceAction error:", error)
      toast({ title: "Could not move money", description: "An unexpected error occurred.", variant: "destructive" })
    } finally {
      setIsMoving(false)
    }
  }

  const parsedDollars = Number.parseFloat(amount)
  const amountCents =
    Number.isFinite(parsedDollars) && parsedDollars > 0 ? Math.round(parsedDollars * 100) : 0
  const exceedsBalance = amountCents > balanceCents
  const belowMinimum = amountCents > 0 && amountCents < MIN_EXPENSE_CENTS
  const canSubmit =
    canManage &&
    !isSaving &&
    amountCents >= MIN_EXPENSE_CENTS &&
    !exceedsBalance &&
    description.trim().length > 0

  async function handleSubmit() {
    if (!canSubmit) return
    setIsSaving(true)
    try {
      const result = await recordProjectExpenseAction(projectId, amountCents, {
        description: description.trim(),
        category: category.trim() || undefined,
        payee: payee.trim() || undefined,
      })
      if (!result.success) {
        toast({
          title: "Could not record expense",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        })
        return
      }
      toast({ title: "Expense recorded", description: `${formatMoney(amountCents, currency)} debited from the treasury.` })
      setAmount("")
      setDescription("")
      setCategory("")
      setPayee("")
      router.refresh()
    } catch (error) {
      console.error("recordProjectExpenseAction error:", error)
      toast({ title: "Could not record expense", description: "An unexpected error occurred.", variant: "destructive" })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Receipt className="h-4 w-4" />
          Expenses
        </CardTitle>
        <CardDescription>
          Debits out of the project treasury to external payees (materials, contractors, fees).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {canManage && groupId ? (
          <div className="space-y-3 rounded-md border p-4">
            <div className="flex items-center gap-2">
              <ArrowLeftRight className="h-4 w-4" />
              <p className="text-sm font-medium">Move money</p>
            </div>
            <p className="text-xs text-muted-foreground">
              Apportion funds between the group treasury and this project&apos;s wallet.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="project-move-direction">Direction</Label>
                <select
                  id="project-move-direction"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={moveDirection}
                  onChange={(e) => setMoveDirection(e.target.value as ProjectFundingDirection)}
                >
                  <option value="to_project">Group treasury → project</option>
                  <option value="to_main">Project → group treasury</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="project-move-amount">Amount</Label>
                <Input
                  id="project-move-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={moveAmount}
                  onChange={(e) => setMoveAmount(e.target.value)}
                />
                {moveExceedsProject ? (
                  <p className="text-xs text-destructive">Exceeds project balance ({formatMoney(balanceCents, currency)}).</p>
                ) : moveBelowMinimum ? (
                  <p className="text-xs text-destructive">Minimum transfer is {formatMoney(MIN_EXPENSE_CENTS, currency)}.</p>
                ) : null}
              </div>
              <div className="flex items-end">
                <Button onClick={handleMove} disabled={!canMove} className="w-full">
                  {isMoving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ArrowLeftRight className="h-4 w-4 mr-2" />}
                  Move money
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {canManage ? (
          <div className="space-y-3 rounded-md border p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="expense-amount">Amount</Label>
                <Input
                  id="expense-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                {exceedsBalance ? (
                  <p className="text-xs text-destructive">Exceeds treasury balance ({formatMoney(balanceCents, currency)}).</p>
                ) : belowMinimum ? (
                  <p className="text-xs text-destructive">Minimum expense is {formatMoney(MIN_EXPENSE_CENTS, currency)}.</p>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="expense-payee">Payee (optional)</Label>
                <Input
                  id="expense-payee"
                  placeholder="Vendor or contractor"
                  value={payee}
                  onChange={(e) => setPayee(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="expense-description">Description</Label>
                <Input
                  id="expense-description"
                  placeholder="What was this for?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="expense-category">Category (optional)</Label>
                <Input
                  id="expense-category"
                  placeholder="e.g. materials"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Receipt className="h-4 w-4 mr-2" />}
                Record expense
              </Button>
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          <p className="text-sm font-medium">Recent expenses</p>
          {initialExpenses.length === 0 ? (
            <p className="text-sm text-muted-foreground">No expenses recorded yet.</p>
          ) : (
            <div className="divide-y rounded-md border">
              {initialExpenses.map((expense) => (
                <div key={expense.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="text-sm truncate">{expense.description || "Expense"}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(expense.createdAt)}</p>
                  </div>
                  <span className="font-medium whitespace-nowrap text-destructive">
                    -{formatMoney(expense.amountCents, currency)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
