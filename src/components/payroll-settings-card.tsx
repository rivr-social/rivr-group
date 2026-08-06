"use client"

/**
 * Org payroll settings — Treasury tab, admins only. Two controls plus a
 * readout:
 *   - Payroll withholding: enable + rate (%, ≤50). The withheld share of every
 *     member job payout diverts into the org's reserve at pay time; the bank
 *     leg pays the net.
 *   - Payout schedule: when attested payouts release to banks (manual =
 *     attest releases immediately).
 *   - Reserve balance: what the org currently holds back.
 */
import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import {
  getPayrollSettingsAction,
  setPayrollWithholdingConfigAction,
  setPayoutScheduleConfigAction,
} from "@/app/actions/payroll"
import type { PayoutCadence } from "@/lib/payroll-withholding"

interface PayrollSettingsCardProps {
  groupId: string
}

export function PayrollSettingsCard({ groupId }: PayrollSettingsCardProps) {
  const [loaded, setLoaded] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [ratePercent, setRatePercent] = useState("0")
  const [cadence, setCadence] = useState<PayoutCadence>("manual")
  const [dayOfWeek, setDayOfWeek] = useState("5")
  const [dayOfMonth, setDayOfMonth] = useState("1")
  const [reserveCents, setReserveCents] = useState(0)
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()

  const load = useCallback(async () => {
    const result = await getPayrollSettingsAction(groupId)
    if (result.success) {
      setEnabled(result.withholding.enabled)
      setRatePercent((result.withholding.rateBps / 100).toString())
      setCadence(result.schedule.cadence)
      if (result.schedule.dayOfWeek !== undefined) setDayOfWeek(String(result.schedule.dayOfWeek))
      if (result.schedule.dayOfMonth !== undefined) setDayOfMonth(String(result.schedule.dayOfMonth))
      setReserveCents(result.reserveCents)
      setLoaded(true)
    }
  }, [groupId])

  useEffect(() => {
    void load()
  }, [load])

  if (!loaded) return null

  const save = async () => {
    setSaving(true)
    try {
      const rateBps = Math.round(Number(ratePercent || "0") * 100)
      const withholdingResult = await setPayrollWithholdingConfigAction(groupId, {
        enabled,
        rateBps,
      })
      const scheduleResult = await setPayoutScheduleConfigAction(groupId, {
        cadence,
        ...(cadence === "weekly" ? { dayOfWeek: Number(dayOfWeek) } : {}),
        ...(cadence === "monthly" ? { dayOfMonth: Number(dayOfMonth) } : {}),
      })
      if (withholdingResult.success && scheduleResult.success) {
        toast({ title: "Payroll settings saved" })
        await load()
      } else {
        const message =
          (!withholdingResult.success && withholdingResult.message) ||
          (!scheduleResult.success && scheduleResult.message) ||
          "Could not save."
        toast({ title: "Could not save", description: message, variant: "destructive" })
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payroll withholding &amp; payout schedule</CardTitle>
        <CardDescription>
          Hold back a share of member job payouts into this organization&apos;s
          withholding reserve, and choose when attested payouts release.
          Reserve balance:{" "}
          <span className="font-semibold">${(reserveCents / 100).toFixed(2)}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="payroll-withholding-enabled">Withhold from member payouts</Label>
          <Switch
            id="payroll-withholding-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
        {enabled ? (
          <div className="flex items-center gap-3">
            <Label htmlFor="payroll-withholding-rate" className="whitespace-nowrap">
              Withholding rate (%)
            </Label>
            <Input
              id="payroll-withholding-rate"
              type="number"
              min={0}
              max={50}
              step={0.25}
              value={ratePercent}
              onChange={(e) => setRatePercent(e.target.value)}
              className="w-28"
            />
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Label className="whitespace-nowrap">Payout schedule</Label>
          <Select value={cadence} onValueChange={(v) => setCadence(v as PayoutCadence)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">On attest (manual)</SelectItem>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
            </SelectContent>
          </Select>
          {cadence === "weekly" ? (
            <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
                  (name, index) => (
                    <SelectItem key={name} value={String(index)}>
                      {name}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          ) : null}
          {cadence === "monthly" ? (
            <Input
              type="number"
              min={1}
              max={28}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(e.target.value)}
              className="w-24"
              aria-label="Day of month"
            />
          ) : null}
        </div>

        <p className="text-sm text-muted-foreground">
          Withheld amounts stay in this organization&apos;s reserve — releasing or
          remitting them is the organization&apos;s responsibility. Members are paid
          the net on both their RIVR balance and bank transfers.
        </p>

        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save payroll settings"}
        </Button>
      </CardContent>
    </Card>
  )
}
