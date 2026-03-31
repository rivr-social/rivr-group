"use client"

import { useState, use } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ChevronLeft, Plus, Trash2, DollarSign, Send, Download } from "lucide-react"
import { useRouter } from "next/navigation"
import { useToast } from "@/components/ui/use-toast"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

export default function EventFinancialsPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params)
  const router = useRouter()
  const { toast } = useToast()

  const [financialData] = useState({
    revenue: 0,
    expenses: 0,
    profit: 0,
    payouts: 0,
    remaining: 0,
  })

  const [expenses, setExpenses] = useState<{ id: string; description: string; amount: string; recipient: string }[]>([])
  const [payouts, setPayouts] = useState<{ id: string; recipient: string; description: string; amount: string; status: string }[]>([])

  const [newPayout, setNewPayout] = useState({ recipient: "", amount: "", description: "" })
  const [newExpense, setNewExpense] = useState({ description: "", amount: "", recipient: "" })
  const [payoutDialogOpen, setPayoutDialogOpen] = useState(false)
  const [expenseDialogOpen, setExpenseDialogOpen] = useState(false)

  const handleAddExpense = () => {
    if (!newExpense.description || !newExpense.amount || !newExpense.recipient) {
      toast({ title: "Invalid expense", description: "Please provide description, amount, and recipient.", variant: "destructive" })
      return
    }
    setExpenses([...expenses, { id: String(expenses.length + 1), ...newExpense }])
    setNewExpense({ description: "", amount: "", recipient: "" })
    setExpenseDialogOpen(false)
    toast({ title: "Expense added" })
  }

  const handleRemoveExpense = (id: string) => {
    setExpenses(expenses.filter((e) => e.id !== id))
  }

  const handleAddPayout = () => {
    if (!newPayout.recipient || !newPayout.amount || Number.parseFloat(newPayout.amount) <= 0) {
      toast({ title: "Invalid payout", description: "Please provide a valid recipient and amount.", variant: "destructive" })
      return
    }
    setPayouts([...payouts, { id: String(payouts.length + 1), ...newPayout, status: "pending" }])
    setNewPayout({ recipient: "", amount: "", description: "" })
    setPayoutDialogOpen(false)
    toast({ title: "Payout added" })
  }

  const handleSendPayouts = () => {
    setPayouts(payouts.map((p) => ({ ...p, status: "sent" })))
    toast({ title: "Payouts sent", description: "All pending payouts have been sent." })
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 pb-20">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" className="p-0" onClick={() => router.back()} aria-label="Go back">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-2xl font-bold">Event Financials</h1>
      </div>

      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="bg-gray-50 p-4 rounded-md mb-6">
            <h3 className="text-lg font-medium mb-4">Summary</h3>
            <div className="space-y-2">
              <div className="flex justify-between py-2 border-b"><span>Revenue</span><span className="font-medium">${financialData.revenue.toFixed(2)}</span></div>
              <div className="flex justify-between py-2 border-b"><span>Expenses</span><span className="font-medium">${financialData.expenses.toFixed(2)}</span></div>
              <div className="flex justify-between py-2 border-b"><span className="font-medium">Profit</span><span className="font-medium">${financialData.profit.toFixed(2)}</span></div>
              <div className="flex justify-between py-2 border-b"><span>Payouts</span><span className="font-medium">${financialData.payouts.toFixed(2)}</span></div>
              <div className="flex justify-between py-2"><span className="font-medium">Remaining</span><span className="font-medium">${financialData.remaining.toFixed(2)}</span></div>
            </div>
          </div>

          <div className="flex justify-between mb-4">
            <Button variant="outline" onClick={() => toast({ title: "Report exported" })}>
              <Download className="h-4 w-4 mr-2" />Export Report
            </Button>
            <Button onClick={handleSendPayouts} disabled={payouts.length === 0}>
              <Send className="h-4 w-4 mr-2" />Send Payouts
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium">Expenses</h3>
          <Dialog open={expenseDialogOpen} onOpenChange={setExpenseDialogOpen}>
            <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4 mr-2" />Add Expense</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Expense</DialogTitle>
                <DialogDescription>Record a new expense for this event.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Description</label>
                  <Input value={newExpense.description} onChange={(e) => setNewExpense({ ...newExpense, description: e.target.value })} placeholder="What is this expense for?" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Amount</label>
                  <div className="relative">
                    <DollarSign className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input value={newExpense.amount} onChange={(e) => setNewExpense({ ...newExpense, amount: e.target.value })} type="number" step="0.01" min="0" className="pl-8" placeholder="0.00" />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Paid to</label>
                  <Input value={newExpense.recipient} onChange={(e) => setNewExpense({ ...newExpense, recipient: e.target.value })} placeholder="Recipient name" />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setExpenseDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleAddExpense}>Add</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {expenses.length > 0 ? (
          <div className="space-y-3">
            {expenses.map((expense) => (
              <div key={expense.id} className="border rounded-md p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center">
                    <div className="font-medium">{expense.description}</div>
                    <div className="ml-2 text-sm text-muted-foreground">to {expense.recipient}</div>
                  </div>
                  <div className="font-medium">${Number(expense.amount).toFixed(2)}</div>
                </div>
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-700 h-8 px-2" onClick={() => handleRemoveExpense(expense.id)}>
                    <Trash2 className="h-4 w-4 mr-1" />Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-center text-muted-foreground py-4">No expenses yet</p>
        )}
      </div>

      <Separator className="my-6" />

      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium">Payouts</h3>
          <Dialog open={payoutDialogOpen} onOpenChange={setPayoutDialogOpen}>
            <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4 mr-2" />Add Payout</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Payout</DialogTitle>
                <DialogDescription>Create a new payout for event contributors.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Recipient</label>
                  <Input value={newPayout.recipient} onChange={(e) => setNewPayout({ ...newPayout, recipient: e.target.value })} placeholder="Recipient name" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Amount</label>
                  <div className="relative">
                    <DollarSign className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input value={newPayout.amount} onChange={(e) => setNewPayout({ ...newPayout, amount: e.target.value })} type="number" step="0.01" min="0" className="pl-8" placeholder="0.00" />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Description</label>
                  <Textarea value={newPayout.description} onChange={(e) => setNewPayout({ ...newPayout, description: e.target.value })} placeholder="What is this payment for?" />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPayoutDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleAddPayout}>Add</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          Payouts can be sent 3 days after the event. All refunds must happen within this time before a payout can be sent.
        </p>

        {payouts.length > 0 ? (
          <div className="space-y-4">
            {payouts.map((payout) => (
              <div key={payout.id} className="border rounded-md p-4">
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback>{payout.recipient.substring(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div>
                      <h4 className="font-medium">{payout.recipient}</h4>
                      <p className="text-sm text-muted-foreground">{payout.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">${Number.parseFloat(payout.amount).toFixed(2)}</span>
                    <span className={`text-xs px-2 py-1 rounded-full ${payout.status === "sent" ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"}`}>
                      {payout.status === "sent" ? "Sent" : "Pending"}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-center text-muted-foreground py-4">No payouts yet</p>
        )}
      </div>
    </div>
  )
}
