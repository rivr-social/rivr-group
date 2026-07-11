"use client"

/**
 * TreasuryFlowChart — the Allocations sub-tab's funds-flow diagram
 * (2026-07-10). Plain-SVG layered flow: PROJECT wallets on the left flow
 * through EXPENSES and completion sweeps into the GROUP TREASURY (center),
 * which flows out to FUNDS, MEMBER PAYOUTS, and the configured
 * NET-ALLOCATION splits (right); SUBGROUP treasuries sit beneath the org
 * feeding upward. Realized amounts label the edges; node boxes show live
 * balances. No chart library — a deterministic column layout in SVG.
 */

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { getTreasuryFlowData, type TreasuryFlowData } from "@/app/actions/wallet/flow-chart"

const W = 860
const NODE_W = 200
const NODE_H = 44
const GAP_Y = 14
const COL_X = { projects: 10, center: 330, right: 650 }

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`

interface Box {
  x: number
  y: number
  label: string
  sub?: string
  tone: "project" | "treasury" | "expense" | "fund" | "member" | "subgroup" | "alloc"
}

const TONE: Record<Box["tone"], { fill: string; stroke: string }> = {
  project: { fill: "#eff6ff", stroke: "#3b82f6" },
  treasury: { fill: "#ecfdf5", stroke: "#10b981" },
  expense: { fill: "#fef2f2", stroke: "#ef4444" },
  fund: { fill: "#f5f3ff", stroke: "#8b5cf6" },
  member: { fill: "#fffbeb", stroke: "#f59e0b" },
  subgroup: { fill: "#f0fdfa", stroke: "#14b8a6" },
  alloc: { fill: "#fdf2f8", stroke: "#ec4899" },
}

function Node({ box }: { box: Box }) {
  const tone = TONE[box.tone]
  return (
    <g>
      <rect x={box.x} y={box.y} width={NODE_W} height={NODE_H} rx={8} fill={tone.fill} stroke={tone.stroke} strokeWidth={1.5} />
      <text x={box.x + 10} y={box.y + 18} fontSize={12} fontWeight={600} fill="#111827">
        {box.label.length > 26 ? `${box.label.slice(0, 25)}…` : box.label}
      </text>
      {box.sub && (
        <text x={box.x + 10} y={box.y + 34} fontSize={11} fill="#6b7280">
          {box.sub}
        </text>
      )}
    </g>
  )
}

function Edge({ from, to, label, dashed, reverse }: { from: Box; to: Box; label?: string; dashed?: boolean; reverse?: boolean }) {
  // `reverse` draws a right-to-left flow (e.g. treasury funding a project):
  // the path leaves the source's LEFT edge and enters the target's RIGHT edge.
  const x1 = reverse ? from.x : from.x + NODE_W
  const y1 = from.y + NODE_H / 2
  const x2 = reverse ? to.x + NODE_W : to.x
  const y2 = to.y + NODE_H / 2
  const mx = (x1 + x2) / 2
  return (
    <g>
      <path
        d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
        fill="none"
        stroke="#9ca3af"
        strokeWidth={1.5}
        strokeDasharray={dashed ? "5 4" : undefined}
        markerEnd="url(#flow-arrow)"
      />
      {label && (
        <text x={mx} y={(y1 + y2) / 2 - 6} fontSize={10.5} fill="#374151" textAnchor="middle">
          {label}
        </text>
      )}
    </g>
  )
}

export function TreasuryFlowChart({ groupId }: { groupId: string }) {
  const [data, setData] = useState<TreasuryFlowData | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    getTreasuryFlowData(groupId)
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setLoaded(true)
        }
      })
      .catch(() => setLoaded(true))
    return () => {
      cancelled = true
    }
  }, [groupId])

  if (!loaded) return <p className="text-sm text-muted-foreground p-4">Loading allocation flows…</p>
  if (!data) return <p className="text-sm text-muted-foreground p-4">Allocation flows are visible to group members.</p>

  // ── Layout ────────────────────────────────────────────────────────────────
  const projects = data.projects.slice(0, 8)
  const projectBoxes: Box[] = projects.map((p, i) => ({
    x: COL_X.projects,
    y: 20 + i * (NODE_H + GAP_Y),
    label: p.name,
    sub: `${fmt(p.balanceCents)}${p.completed ? " · completed" : ""}`,
    tone: "project",
  }))

  const centerTop = 20
  const expenseBox: Box = {
    x: COL_X.center,
    y: centerTop,
    label: "Expenses",
    sub: fmt(projects.reduce((s, p) => s + p.expenseCents, 0)),
    tone: "expense",
  }
  const treasuryBox: Box = {
    x: COL_X.center,
    y: centerTop + NODE_H + GAP_Y * 2,
    label: `${data.group.name} Treasury`,
    sub: fmt(data.group.balanceCents),
    tone: "treasury",
  }

  const rightItems: Box[] = []
  let ry = 20
  for (const fund of data.funds.slice(0, 4)) {
    rightItems.push({ x: COL_X.right, y: ry, label: fund.name, sub: fmt(fund.balanceCents), tone: "fund" })
    ry += NODE_H + GAP_Y
  }
  const memberBox: Box = { x: COL_X.right, y: ry, label: "Member payouts", sub: fmt(data.toMembersCents), tone: "member" }
  ry += NODE_H + GAP_Y
  const allocBoxes: Box[] = data.allocations.slice(0, 5).map((a) => {
    const box: Box = {
      x: COL_X.right,
      y: ry,
      label: a.label,
      sub: `${(a.bps / 100).toFixed(1)}% of net`,
      tone: "alloc",
    }
    ry += NODE_H + GAP_Y
    return box
  })

  const subgroupStartY = Math.max(
    treasuryBox.y + NODE_H + GAP_Y * 2,
    projectBoxes.length > 0 ? (projectBoxes.at(-1)!.y + NODE_H + GAP_Y * 2) : 0,
  )
  const subgroupBoxes: Box[] = data.subgroups.slice(0, 8).map((s, i) => ({
    x: COL_X.projects,
    y: subgroupStartY + i * (NODE_H + GAP_Y),
    label: s.name,
    sub: fmt(s.balanceCents),
    tone: "subgroup",
  }))

  const height =
    Math.max(
      ry,
      subgroupBoxes.length > 0 ? subgroupBoxes.at(-1)!.y + NODE_H : 0,
      treasuryBox.y + NODE_H,
    ) + 24

  return (
    <Card>
      <CardContent className="p-2 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${height}`} width="100%" style={{ minWidth: 720 }} role="img" aria-label="Treasury allocation flow chart">
          <defs>
            <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#9ca3af" />
            </marker>
          </defs>

          {projectBoxes.map((box, i) => {
            const p = projects[i]
            return (
              <g key={p.id}>
                {p.fundedCents > 0 && (
                  <Edge from={treasuryBox} to={box} label={`fund ${fmt(p.fundedCents)}`} reverse />
                )}
                {p.expenseCents > 0 && <Edge from={box} to={expenseBox} label={fmt(p.expenseCents)} />}
                <Edge
                  from={box}
                  to={treasuryBox}
                  label={p.sweptCents > 0 ? `net ${fmt(p.sweptCents)}` : "net on completion"}
                  dashed={p.sweptCents === 0}
                />
              </g>
            )
          })}

          {data.funds.slice(0, 4).map((fund, i) => (
            <Edge key={fund.id} from={treasuryBox} to={rightItems[i]} label={i === 0 && data.toFundsCents > 0 ? fmt(data.toFundsCents) : undefined} />
          ))}
          <Edge from={treasuryBox} to={memberBox} label={data.toMembersCents > 0 ? fmt(data.toMembersCents) : undefined} dashed={data.toMembersCents === 0} />
          {allocBoxes.map((box) => (
            <Edge key={box.label + box.y} from={treasuryBox} to={box} dashed />
          ))}

          {subgroupBoxes.map((box) => (
            <Edge key={box.label + box.y} from={box} to={treasuryBox} label="net cascade" dashed />
          ))}

          {projectBoxes.map((box) => (
            <Node key={`p-${box.y}`} box={box} />
          ))}
          <Node box={expenseBox} />
          <Node box={treasuryBox} />
          {rightItems.map((box) => (
            <Node key={`f-${box.y}`} box={box} />
          ))}
          <Node box={memberBox} />
          {allocBoxes.map((box) => (
            <Node key={`a-${box.y}`} box={box} />
          ))}
          {subgroupBoxes.map((box) => (
            <Node key={`s-${box.y}`} box={box} />
          ))}
        </svg>
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          Solid arrows are realized transfers; dashed arrows are configured or pending flows
          (project nets sweep on completion; subgroup nets cascade upward; allocation splits
          apply at net distribution).
        </p>
      </CardContent>
    </Card>
  )
}
