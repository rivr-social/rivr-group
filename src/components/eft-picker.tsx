"use client"

/**
 * EFT Picker — Ecological Footprint Tracker
 *
 * Three sunburst charts aligned by 6 hextants (60 degree sectors):
 *   LEFT  — "Forms of Capital Input" (8 segments: 4 macro 60deg + 4 micro 30deg)
 *   CENTER — "Impact on Life Essentials" (12 segments x 30deg)
 *   RIGHT — "Integral Audit" (6 segments x 60deg)
 *
 * All wheels share the same -30deg start offset so hextant boundaries align.
 * Click-and-drag to paint values across segments.
 */

import { useMemo, useCallback, useRef } from "react"
import { arc as d3Arc } from "d3"
import {
  Utensils,
  Home,
  Shirt,
  Smile,
  Car,
  Droplets,
  Sprout,
  Recycle,
  Cpu,
  Paintbrush,
  GraduationCap,
  Users,
  DollarSign,
  Heart,
  Wrench,
  Palette,
  Lightbulb,
  Sparkles,
  BookOpen,
  Activity,
  TrendingUp,
  type LucideIcon,
} from "lucide-react"
import { Label } from "@/components/ui/label"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LEVEL = 5
const INNER_RADIUS = 22
const OUTER_RADIUS = 72
const RING_WIDTH = (OUTER_RADIUS - INNER_RADIUS) / MAX_LEVEL
const ICON_RADIUS = OUTER_RADIUS + 15
const LABEL_RADIUS = OUTER_RADIUS + 30
const CHART_WIDTH = 300
const CHART_HEIGHT = 250
const CENTER_X = CHART_WIDTH / 2
const CENTER_Y = CHART_HEIGHT / 2

interface EftCategory {
  key: string
  color: string
  icon: LucideIcon
  label: string
}

// ---------------------------------------------------------------------------
// Category arrays — original rainbow color order for sunburst wheels
// ---------------------------------------------------------------------------

const EFT_CATEGORIES: EftCategory[] = [
  { key: "food",       color: "#FF73EA", icon: Utensils,       label: "Food" },
  { key: "housing",    color: "#B785E1", icon: Home,           label: "Housing" },
  { key: "clothing",   color: "#6b0fb9", icon: Shirt,          label: "Clothing" },
  { key: "wellness",   color: "#0000f7", icon: Smile,          label: "Wellness" },
  { key: "travel",     color: "#00ddff", icon: Car,            label: "Travel" },
  { key: "water",      color: "#00ffc3", icon: Droplets,       label: "Water" },
  { key: "life",       color: "#148023", icon: Sprout,         label: "Life" },
  { key: "regen",      color: "#35ca2d", icon: Recycle,        label: "Regen" },
  { key: "technology", color: "#ffff00", icon: Cpu,            label: "Technology" },
  { key: "art",        color: "#ffd000", icon: Paintbrush,     label: "Art" },
  { key: "education",  color: "#ff6f00", icon: GraduationCap,  label: "Education" },
  { key: "community",  color: "#FF0000", icon: Users,          label: "Community" },
]

// Rainbow order: red → orange → yellow → green → cyan → blue → purple → magenta
export const CAPITAL_CATEGORIES: EftCategory[] = [
  { key: "living",        color: "#ef4444", icon: Sprout,         label: "Living" },
  { key: "material",      color: "#f97316", icon: Wrench,         label: "Material" },
  { key: "financial",     color: "#eab308", icon: DollarSign,     label: "Financial" },
  { key: "social",        color: "#22c55e", icon: Heart,          label: "Social" },
  { key: "intellectual",  color: "#06b6d4", icon: Lightbulb,      label: "Intellectual" },
  { key: "experiential",  color: "#3b82f6", icon: BookOpen,       label: "Experiential" },
  { key: "cultural",      color: "#8b5cf6", icon: Palette,        label: "Cultural" },
  { key: "spiritual",     color: "#ec4899", icon: Sparkles,       label: "Spiritual" },
]

// Rainbow order: red → yellow → green → cyan → blue → magenta
export const AUDIT_CATEGORIES: EftCategory[] = [
  { key: "condition",   color: "#ef4444", icon: Activity,    label: "Condition" },
  { key: "community",   color: "#eab308", icon: Users,       label: "Community" },
  { key: "knowledge",   color: "#22c55e", icon: BookOpen,    label: "Knowledge" },
  { key: "value",       color: "#06b6d4", icon: TrendingUp,  label: "Value" },
  { key: "technology",  color: "#3b82f6", icon: Cpu,         label: "Technology" },
  { key: "wellbeing",   color: "#ec4899", icon: Heart,       label: "Wellbeing" },
]

const GAP_ANGLE = 0.03

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EftValues = Record<string, number>
export type CapitalValues = Record<string, number>
export type AuditValues = Record<string, number>

export interface EftPickerProps {
  value: EftValues
  onChange: (values: EftValues) => void
  capitalValue?: CapitalValues
  onCapitalChange?: (values: CapitalValues) => void
  auditValue?: AuditValues
  onAuditChange?: (values: AuditValues) => void
}

export function defaultEftValues(): EftValues {
  const values: EftValues = {}
  for (const cat of EFT_CATEGORIES) {
    values[cat.key] = 0
  }
  return values
}

export function defaultCapitalValues(): CapitalValues {
  const values: CapitalValues = {}
  for (const cat of CAPITAL_CATEGORIES) {
    values[cat.key] = 0
  }
  return values
}

export function defaultAuditValues(): AuditValues {
  const values: AuditValues = {}
  for (const cat of AUDIT_CATEGORIES) {
    values[cat.key] = 0
  }
  return values
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a point relative to center into polar coordinates. */
function toPolar(x: number, y: number): { angle: number; radius: number } {
  const radius = Math.sqrt(x * x + y * y)
  let angle = Math.atan2(x, -y)
  if (angle < 0) angle += 2 * Math.PI
  return { angle, radius }
}

/** Convert d3-style angle (CW from top) to (cx, cy) offset for SVG positioning. */
function angleToXY(angle: number, radius: number): { x: number; y: number } {
  return {
    x: radius * Math.sin(angle),
    y: -radius * Math.cos(angle),
  }
}

/** Precompute cumulative start angles from variable slice widths. */
function buildSliceBounds(widths: number[], offset: number): Array<{ start: number; end: number; mid: number }> {
  const bounds: Array<{ start: number; end: number; mid: number }> = []
  let cursor = offset
  for (const w of widths) {
    const s = cursor + GAP_ANGLE / 2
    const e = cursor + w - GAP_ANGLE / 2
    bounds.push({ start: s, end: e, mid: cursor + w / 2 })
    cursor += w
  }
  return bounds
}

// ---------------------------------------------------------------------------
// SunburstWheel — reusable inner component
// ---------------------------------------------------------------------------

interface SunburstWheelProps {
  categories: EftCategory[]
  values: Record<string, number>
  onChange: (values: Record<string, number>) => void
  title: string
  startOffset?: number
  sliceWidths?: number[]
}

function SunburstWheel({ categories, values, onChange, title, startOffset = 0, sliceWidths }: SunburstWheelProps) {
  const arcGen = useMemo(
    () => d3Arc<{ innerRadius: number; outerRadius: number; startAngle: number; endAngle: number }>(),
    [],
  )

  const catCount = categories.length

  // Compute uniform widths if not provided
  const effectiveWidths = useMemo(() => {
    if (sliceWidths && sliceWidths.length === catCount) return sliceWidths
    const uniform = (2 * Math.PI) / catCount
    return Array.from({ length: catCount }, () => uniform)
  }, [sliceWidths, catCount])

  const sliceBounds = useMemo(
    () => buildSliceBounds(effectiveWidths, startOffset),
    [effectiveWidths, startOffset],
  )

  const arcs = useMemo(() => {
    const result: Array<{
      d: string
      fill: string
      opacity: number
      catIndex: number
      ring: number
    }> = []

    categories.forEach((cat, i) => {
      const level = values[cat.key] ?? 0
      const { start: startAngle, end: endAngle } = sliceBounds[i]

      for (let ring = 0; ring < MAX_LEVEL; ring++) {
        const innerR = INNER_RADIUS + ring * RING_WIDTH
        const outerR = innerR + RING_WIDTH - 0.8

        const isActive = ring < level
        const d = arcGen({ innerRadius: innerR, outerRadius: outerR, startAngle, endAngle })

        if (d) {
          result.push({
            d,
            fill: cat.color,
            opacity: isActive ? 0.85 - ring * 0.08 : 0.08,
            catIndex: i,
            ring,
          })
        }
      }
    })

    return result
  }, [values, arcGen, categories, sliceBounds])

  // Drag state
  const isDragging = useRef(false)
  const dragValues = useRef<Record<string, number>>({})

  const hitTest = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = e.currentTarget
      const rect = svg.getBoundingClientRect()
      const px = ((e.clientX - rect.left) / rect.width) * CHART_WIDTH - CENTER_X
      const py = ((e.clientY - rect.top) / rect.height) * CHART_HEIGHT - CENTER_Y

      const { angle, radius } = toPolar(px, py)
      if (radius < INNER_RADIUS || radius > OUTER_RADIUS) return null

      // Find which slice the angle falls in using cumulative bounds
      let catIndex = -1
      let cursor = startOffset
      for (let i = 0; i < catCount; i++) {
        const sliceEnd = cursor + effectiveWidths[i]
        // Normalize angle to compare
        let a = angle
        let c = cursor
        let ce = sliceEnd
        // Handle wrap-around
        if (c < 0) { c += 2 * Math.PI; ce += 2 * Math.PI }
        if (a < c) a += 2 * Math.PI
        if (a >= c && a < ce) {
          catIndex = i
          break
        }
        cursor += effectiveWidths[i]
      }

      if (catIndex < 0 || catIndex >= catCount) return null

      const ringIndex = Math.floor((radius - INNER_RADIUS) / RING_WIDTH)
      const clickedLevel = Math.min(ringIndex + 1, MAX_LEVEL)

      return { catIndex, clickedLevel }
    },
    [catCount, startOffset, effectiveWidths],
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      e.preventDefault()
      isDragging.current = true
      dragValues.current = { ...values }
      const hit = hitTest(e)
      if (!hit) return
      const cat = categories[hit.catIndex]
      const currentLevel = dragValues.current[cat.key] ?? 0
      const newLevel = hit.clickedLevel === currentLevel ? currentLevel - 1 : hit.clickedLevel
      dragValues.current[cat.key] = Math.max(0, newLevel)
      onChange({ ...dragValues.current })
    },
    [values, onChange, categories, hitTest],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!isDragging.current) return
      const hit = hitTest(e)
      if (!hit) return
      const cat = categories[hit.catIndex]
      const prev = dragValues.current[cat.key] ?? 0
      if (prev !== hit.clickedLevel) {
        dragValues.current[cat.key] = hit.clickedLevel
        onChange({ ...dragValues.current })
      }
    },
    [onChange, categories, hitTest],
  )

  const handleMouseUp = useCallback(() => {
    isDragging.current = false
  }, [])

  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide text-center block">
        {title}
      </Label>
      <div className="flex justify-center">
        <svg
          width={CHART_WIDTH}
          height={CHART_HEIGHT}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          className="cursor-pointer select-none"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <g transform={`translate(${CENTER_X},${CENTER_Y})`}>
            {arcs.map((p, idx) => (
              <path
                key={idx}
                d={p.d}
                fill={p.fill}
                opacity={p.opacity}
                stroke="hsl(var(--background))"
                strokeWidth={0.5}
                className="transition-opacity duration-150"
              />
            ))}

            {categories.map((cat, i) => {
              const { mid } = sliceBounds[i]
              const { x, y } = angleToXY(mid, ICON_RADIUS)
              const Icon = cat.icon
              const isActive = (values[cat.key] ?? 0) > 0
              return (
                <g key={cat.key} transform={`translate(${x},${y})`}>
                  <Icon
                    x={-5}
                    y={-5}
                    width={10}
                    height={10}
                    style={{ color: isActive ? cat.color : "hsl(var(--muted-foreground))" }}
                    className="transition-colors duration-150"
                  />
                </g>
              )
            })}

            {categories.map((cat, i) => {
              const { mid } = sliceBounds[i]
              const { x, y } = angleToXY(mid, LABEL_RADIUS)
              const isActive = (values[cat.key] ?? 0) > 0

              const midDeg = (mid * 180) / Math.PI
              let textAnchor: "start" | "middle" | "end" = "middle"
              if (midDeg > 30 && midDeg < 150) textAnchor = "start"
              else if (midDeg > 210 && midDeg < 330) textAnchor = "end"

              return (
                <text
                  key={cat.key}
                  x={x}
                  y={y}
                  textAnchor={textAnchor}
                  dominantBaseline="central"
                  fontSize={8}
                  fontWeight={isActive ? 600 : 400}
                  fill={isActive ? cat.color : "hsl(var(--muted-foreground))"}
                  className="transition-colors duration-150 pointer-events-none"
                >
                  {cat.label}
                  {isActive && (
                    <tspan fontSize={7} opacity={0.7}>
                      {" "}{values[cat.key]}
                    </tspan>
                  )}
                </text>
              )
            })}
          </g>
        </svg>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function EftPicker({ value, onChange, capitalValue, onCapitalChange, auditValue, onAuditChange }: EftPickerProps) {
  const showCapital = capitalValue !== undefined && onCapitalChange !== undefined
  const showAudit = auditValue !== undefined && onAuditChange !== undefined

  if (!showCapital && !showAudit) {
    return (
      <SunburstWheel
        categories={EFT_CATEGORIES}
        values={value}
        onChange={onChange}
        title="Impact on Life Essentials"
      />
    )
  }

  return (
    <div className="flex flex-col sm:flex-row gap-4">
      {showCapital && (
        <div className="flex-1">
          <SunburstWheel
            categories={CAPITAL_CATEGORIES}
            values={capitalValue}
            onChange={onCapitalChange}
            title="Forms of Capital Input"
          />
        </div>
      )}
      <div className="flex-1">
        <SunburstWheel
          categories={EFT_CATEGORIES}
          values={value}
          onChange={onChange}
          title="Impact on Life Essentials"
        />
      </div>
      {showAudit && (
        <div className="flex-1">
          <SunburstWheel
            categories={AUDIT_CATEGORIES}
            values={auditValue}
            onChange={onAuditChange}
            title="Integral Audit"
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mini chart for feed cards (no icons, no labels -- just the sunburst)
// ---------------------------------------------------------------------------

const MINI_SIZE = 32
const MINI_CENTER = MINI_SIZE / 2
const MINI_INNER = 4
const MINI_OUTER = 15
const MINI_RING = (MINI_OUTER - MINI_INNER) / MAX_LEVEL

function MiniSunburst({ categories, values }: { categories: EftCategory[]; values: Record<string, number> }) {
  const arcGen = d3Arc<{ innerRadius: number; outerRadius: number; startAngle: number; endAngle: number }>()
  const miniSlice = (2 * Math.PI) / categories.length

  const paths: Array<{ d: string; fill: string; opacity: number }> = []
  categories.forEach((cat, i) => {
    const level = values[cat.key] ?? 0
    const startAngle = i * miniSlice + GAP_ANGLE / 2
    const endAngle = (i + 1) * miniSlice - GAP_ANGLE / 2

    for (let ring = 0; ring < MAX_LEVEL; ring++) {
      const innerR = MINI_INNER + ring * MINI_RING
      const outerR = innerR + MINI_RING - 0.3
      const isActive = ring < level
      const d = arcGen({ innerRadius: innerR, outerRadius: outerR, startAngle, endAngle })
      if (d) {
        paths.push({ d, fill: cat.color, opacity: isActive ? 0.85 - ring * 0.08 : 0.06 })
      }
    }
  })

  return (
    <svg width={MINI_SIZE} height={MINI_SIZE} viewBox={`0 0 ${MINI_SIZE} ${MINI_SIZE}`} className="flex-shrink-0">
      <g transform={`translate(${MINI_CENTER},${MINI_CENTER})`}>
        {paths.map((p, idx) => (
          <path key={idx} d={p.d} fill={p.fill} opacity={p.opacity} />
        ))}
      </g>
    </svg>
  )
}

export function EftMiniChart({ values, capitalValues, auditValues }: { values: Record<string, number>; capitalValues?: Record<string, number>; auditValues?: Record<string, number> }) {
  const hasEftValues = Object.values(values).some((v) => v > 0)
  const hasCapitalValues = capitalValues ? Object.values(capitalValues).some((v) => v > 0) : false
  const hasAuditValues = auditValues ? Object.values(auditValues).some((v) => v > 0) : false

  if (!hasEftValues && !hasCapitalValues && !hasAuditValues) return null

  if (hasCapitalValues || hasAuditValues) {
    return (
      <div className="flex gap-1">
        {hasCapitalValues && capitalValues && <MiniSunburst categories={CAPITAL_CATEGORIES} values={capitalValues} />}
        {hasAuditValues && auditValues && <MiniSunburst categories={AUDIT_CATEGORIES} values={auditValues} />}
        {hasEftValues && <MiniSunburst categories={EFT_CATEGORIES} values={values} />}
      </div>
    )
  }

  return <MiniSunburst categories={EFT_CATEGORIES} values={values} />
}
