"use client"

/**
 * Crypto treasury card — the org's Safe (USDC on Base) inside the Treasury tab.
 *
 * Everything happens in-app: admins bind or deploy the officer Safe, create
 * budget/transfer proposals; OFFICERS sign each proposal with their own
 * browser wallet (EIP-712 — the signature only counts if it recovers to a
 * Safe owner); anyone can trigger execution once the threshold is met (the
 * platform's gas-only relayer pays). Budget LEADS pay members within their
 * allowance with one signature and zero officer involvement.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import { connectMetaMask, ensureBaseNetwork, getConnectedAddress, signTypedDataV4, type CryptoNetworkKey } from "@/lib/metamask"
import {
  getCryptoTreasuryOverviewAction,
  setOrgSafeAddressAction,
  deployOrgSafeAction,
  createBudgetProposalsAction,
  createTransferProposalAction,
  getProposalSigningPayloadAction,
  signSafeProposalAction,
  executeSafeProposalAction,
  buildBudgetPayoutTypedDataAction,
  submitBudgetPayoutAction,
} from "@/app/actions/wallet/crypto-treasury"

type Overview = Awaited<ReturnType<typeof getCryptoTreasuryOverviewAction>>

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export function CryptoTreasuryCard({ groupId, canManage = false }: { groupId: string; canManage?: boolean }) {
  const { toast } = useToast()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [bindAddress, setBindAddress] = useState("")
  const [officers, setOfficers] = useState("")
  const [budgetLead, setBudgetLead] = useState("")
  const [budgetAmount, setBudgetAmount] = useState("")
  const [budgetPeriodic, setBudgetPeriodic] = useState(false)
  const [payoutTo, setPayoutTo] = useState("")
  const [payoutAmount, setPayoutAmount] = useState("")

  const refresh = useCallback(async () => {
    const result = await getCryptoTreasuryOverviewAction(groupId)
    setOverview(result)
  }, [groupId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try {
      await fn()
      await refresh()
    } catch (err) {
      toast({
        title: "Treasury action failed",
        description: err instanceof Error ? err.message : "Unexpected error.",
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  if (!overview || !overview.success) return null
  const network: CryptoNetworkKey = overview.network === "base-sepolia" ? "base-sepolia" : "base"
  const networkLabel = network === "base-sepolia" ? "Base Sepolia (testnet)" : "Base"
  const explorer = network === "base-sepolia" ? "https://sepolia.basescan.org" : "https://basescan.org"

  const requireWallet = async () => {
    await connectMetaMask()
    await ensureBaseNetwork(network)
    return getConnectedAddress()
  }

  const signProposal = (proposalId: string) =>
    run(`sign:${proposalId}`, async () => {
      const address = await requireWallet()
      const payload = await getProposalSigningPayloadAction(proposalId)
      if (!payload.success) throw new Error(payload.error)
      const signature = await signTypedDataV4(address, payload.typedData)
      const result = await signSafeProposalAction(proposalId, signature)
      if (!result.success) throw new Error(result.error)
      toast({
        title: "Signature recorded",
        description: `${result.signatures}/${result.threshold} officer signatures${result.executable ? " — ready to execute" : ""}.`,
      })
    })

  const executeProposal = (proposalId: string) =>
    run(`exec:${proposalId}`, async () => {
      const result = await executeSafeProposalAction(proposalId)
      if (!result.success) throw new Error(result.error)
      toast({ title: "Executed on-chain", description: result.txHash })
    })

  const payFromBudget = () =>
    run("payout", async () => {
      const amountCents = Math.round(Number(payoutAmount) * 100)
      if (!payoutTo.trim() || !Number.isInteger(amountCents) || amountCents <= 0) {
        throw new Error("Recipient and a positive amount are required.")
      }
      const delegate = await requireWallet()
      const prepared = await buildBudgetPayoutTypedDataAction(groupId, delegate, payoutTo.trim(), amountCents)
      if (!prepared.success) throw new Error(prepared.error)
      const signature = await signTypedDataV4(delegate, prepared.typedData)
      const result = await submitBudgetPayoutAction({
        groupId,
        delegateAddress: delegate,
        toAddress: payoutTo.trim(),
        amountCents,
        signature,
      })
      if (!result.success) throw new Error(result.error)
      toast({ title: "Payout settled", description: `${usd(amountCents)} USDC sent — ${result.txHash}` })
      setPayoutTo("")
      setPayoutAmount("")
    })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Crypto treasury (USDC)
          <Badge variant="outline">{networkLabel}</Badge>
        </CardTitle>
        <CardDescription>
          The org&apos;s digital-dollar treasury lives in a Safe its officers control — RIVR never holds a key.
          Officers approve budgets in-app; leads spend within them with one signature.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!overview.configured ? (
          canManage ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="bind-safe">Bind an existing Safe address</Label>
                <div className="flex gap-2">
                  <Input id="bind-safe" placeholder="0x…" value={bindAddress} onChange={(e) => setBindAddress(e.target.value)} />
                  <Button
                    disabled={busy !== null}
                    onClick={() =>
                      run("bind", async () => {
                        const result = await setOrgSafeAddressAction(groupId, bindAddress.trim())
                        if (!result.success) throw new Error(result.error)
                        toast({ title: "Treasury Safe bound", description: `${result.owners.length} officers, ${result.threshold}-of-${result.owners.length}.` })
                      })
                    }
                  >
                    Bind
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="deploy-officers">…or deploy a new officer Safe (comma-separated officer addresses, 2-of-N)</Label>
                <div className="flex gap-2">
                  <Input id="deploy-officers" placeholder="0xChair, 0xSecretary, 0xTreasurer" value={officers} onChange={(e) => setOfficers(e.target.value)} />
                  <Button
                    disabled={busy !== null}
                    onClick={() =>
                      run("deploy", async () => {
                        const list = officers.split(",").map((s) => s.trim()).filter(Boolean)
                        const result = await deployOrgSafeAction(groupId, list, 2)
                        if (!result.success) throw new Error(result.error)
                        toast({ title: "Treasury Safe deployed", description: result.safeAddress })
                      })
                    }
                  >
                    Deploy
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No crypto treasury configured yet.</p>
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">{usd(overview.usdcCents)} USDC</span>
              <a className="underline text-muted-foreground" href={`${explorer}/address/${overview.safeAddress}`} target="_blank" rel="noreferrer">
                Safe {short(overview.safeAddress)}
              </a>
              <Badge variant="secondary">{overview.threshold}-of-{overview.owners.length} officers</Badge>
              <Badge variant={overview.allowanceModuleEnabled ? "secondary" : "outline"}>
                budgets {overview.allowanceModuleEnabled ? "enabled" : "not enabled"}
              </Badge>
            </div>

            {overview.budgets.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">Active budgets</p>
                {overview.budgets.map((b) => (
                  <div key={b.delegate} className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>Lead {short(b.delegate)}</span>
                    <span>
                      {usd(b.amountCents - b.spentCents)} of {usd(b.amountCents)} left
                      {b.resetTimeMin > 0 ? ` · refills every ${Math.round(b.resetTimeMin / 1440)}d` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {overview.proposals.some((p) => p.status === "pending") && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Pending officer approvals</p>
                {overview.proposals
                  .filter((p) => p.status === "pending")
                  .map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                      <div>
                        <p>{p.summary}</p>
                        <p className="text-xs text-muted-foreground">{p.signatures}/{overview.threshold} signatures</p>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => signProposal(p.id)}>
                          Sign as officer
                        </Button>
                        {p.signatures >= overview.threshold && (
                          <Button size="sm" disabled={busy !== null} onClick={() => executeProposal(p.id)}>
                            Execute
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            )}

            {canManage && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">Approve a budget (officers sign, lead spends within it)</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Input placeholder="Lead wallet 0x…" value={budgetLead} onChange={(e) => setBudgetLead(e.target.value)} />
                  <Input placeholder="Amount USD" inputMode="decimal" value={budgetAmount} onChange={(e) => setBudgetAmount(e.target.value)} />
                  <Button
                    disabled={busy !== null}
                    onClick={() =>
                      run("budget", async () => {
                        const amountCents = Math.round(Number(budgetAmount) * 100)
                        const result = await createBudgetProposalsAction(groupId, budgetLead.trim(), amountCents, budgetPeriodic ? 43_200 : 0)
                        if (!result.success) throw new Error(result.error)
                        toast({ title: "Budget proposals created", description: `${result.proposals.length} item(s) await officer signatures.` })
                        setBudgetLead("")
                        setBudgetAmount("")
                      })
                    }
                  >
                    Propose
                  </Button>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={budgetPeriodic} onChange={(e) => setBudgetPeriodic(e.target.checked)} />
                  Monthly refill (otherwise a one-time depleting budget)
                </label>
              </div>
            )}

            {overview.allowanceModuleEnabled && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">Pay from your budget (leads — one signature, no gas)</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Input placeholder="Recipient wallet 0x…" value={payoutTo} onChange={(e) => setPayoutTo(e.target.value)} />
                  <Input placeholder="Amount USD" inputMode="decimal" value={payoutAmount} onChange={(e) => setPayoutAmount(e.target.value)} />
                  <Button disabled={busy !== null} onClick={payFromBudget}>
                    Pay
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
