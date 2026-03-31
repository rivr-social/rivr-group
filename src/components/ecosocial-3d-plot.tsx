"use client"

/**
 * Ecosocial 3D Plot - Combined radar chart overlay of all three sunburst dials.
 *
 * Renders a wireframe-style polar radar chart with three colored mesh layers
 * aligned to 6 hextants. Capital axes use variable widths (macro/micro).
 * Hextant labels (Biosphere, Sustenance, etc.) are rendered around the outside.
 */

import { useMemo } from "react"

const MAX_LEVEL = 5
const PLOT_SIZE = 320
const PLOT_CENTER = PLOT_SIZE / 2
const PLOT_RADIUS = 120
const RING_COUNT = 5

const DEG = Math.PI / 180
const HEXTANT_OFFSET = -30 * DEG

// ---------------------------------------------------------------------------
// Hextant-ordered keys (independent of sunburst wheel order)
// ---------------------------------------------------------------------------

// H1 Biosphere:    Life, Regen
// H2 Sustenance:   Water, Food
// H3 Sociosphere:  Wellness, Community
// H4 Noosphere:    Art, Education
// H5 Technosphere: Technology, Travel
// H6 Econosphere:  Housing, Clothing
const EFT_KEYS = [
  "life", "regen", "water", "food", "wellness", "community",
  "art", "education", "technology", "travel", "housing", "clothing",
]

// H1: Living(M) | H2: Experiential(M) | H3: Spiritual(m),Social(m)
// H4: Cultural(m),Intellectual(m) | H5: Material(M) | H6: Financial(M)
const CAPITAL_KEYS = [
  "living", "experiential", "spiritual", "social",
  "cultural", "intellectual", "material", "financial",
]
const CAPITAL_WIDTHS_DEG = [60, 60, 30, 30, 30, 30, 60, 60]

// H1: Condition | H2: Wellbeing | H3: Community
// H4: Knowledge | H5: Technology | H6: Value
const AUDIT_KEYS = [
  "condition", "wellbeing", "community", "knowledge", "technology", "value",
]

// Hextant metadata for outer labels
const HEXTANTS = [
  { label: "Biosphere",    color: "#16a34a" },
  { label: "Sustenance",   color: "#ec4899" },
  { label: "Sociosphere",  color: "#8b5cf6" },
  { label: "Noosphere",    color: "#3b82f6" },
  { label: "Technosphere", color: "#f59e0b" },
  { label: "Econosphere",  color: "#22c55e" },
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Ecosocial3dPlotProps {
  capitalValues: Record<string, number>
  auditValues: Record<string, number>
  eftValues: Record<string, number>
}

interface LayerConfig {
  keys: string[]
  values: Record<string, number>
  color: string
  label: string
  widthsDeg?: number[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function polarToXY(angle: number, radius: number): { x: number; y: number } {
  return {
    x: PLOT_CENTER + radius * Math.cos(angle - Math.PI / 2),
    y: PLOT_CENTER + radius * Math.sin(angle - Math.PI / 2),
  }
}

function getAxisAngles(count: number, widthsDeg?: number[]): number[] {
  const widths = widthsDeg
    ? widthsDeg.map((d) => d * DEG)
    : Array.from({ length: count }, () => (2 * Math.PI) / count)

  const angles: number[] = []
  let cursor = HEXTANT_OFFSET
  for (let i = 0; i < count; i++) {
    angles.push(cursor + widths[i] / 2)
    cursor += widths[i]
  }
  return angles
}

function buildPolygonPoints(keys: string[], values: Record<string, number>, widthsDeg?: number[]): string {
  const axisAngles = getAxisAngles(keys.length, widthsDeg)
  return keys
    .map((key, i) => {
      const level = values[key] ?? 0
      const r = (level / MAX_LEVEL) * PLOT_RADIUS
      const { x, y } = polarToXY(axisAngles[i], r)
      return `${x},${y}`
    })
    .join(" ")
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Ecosocial3dPlot({ capitalValues, auditValues, eftValues }: Ecosocial3dPlotProps) {
  const hasAnyValue = useMemo(() => {
    const allValues = [
      ...Object.values(capitalValues),
      ...Object.values(auditValues),
      ...Object.values(eftValues),
    ]
    return allValues.some((v) => v > 0)
  }, [capitalValues, auditValues, eftValues])

  const layers: LayerConfig[] = useMemo(
    () => [
      { keys: CAPITAL_KEYS, values: capitalValues, color: "#16a34a", label: "Capital", widthsDeg: CAPITAL_WIDTHS_DEG },
      { keys: AUDIT_KEYS, values: auditValues, color: "#8b5cf6", label: "Audit" },
      { keys: EFT_KEYS, values: eftValues, color: "#ec4899", label: "Life Essentials" },
    ],
    [capitalValues, auditValues, eftValues],
  )

  if (!hasAnyValue) return null

  // Hextant boundary angles for labels (center of each 60deg sector)
  const hextantCenters = Array.from({ length: 6 }, (_, i) =>
    HEXTANT_OFFSET + (i + 0.5) * (60 * DEG),
  )

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide text-center">
        Ecosocial Profile
      </p>
      <div className="flex justify-center">
        <svg
          width={PLOT_SIZE}
          height={PLOT_SIZE}
          viewBox={`0 0 ${PLOT_SIZE} ${PLOT_SIZE}`}
          className="select-none"
        >
          {/* Concentric grid rings */}
          {Array.from({ length: RING_COUNT }, (_, i) => {
            const r = ((i + 1) / RING_COUNT) * PLOT_RADIUS
            return (
              <circle
                key={`ring-${i}`}
                cx={PLOT_CENTER}
                cy={PLOT_CENTER}
                r={r}
                fill="none"
                stroke="hsl(var(--border))"
                strokeWidth={0.5}
                opacity={0.4}
              />
            )
          })}

          {/* Hextant boundary lines (every 60deg) */}
          {Array.from({ length: 6 }, (_, i) => {
            const angle = HEXTANT_OFFSET + i * (60 * DEG)
            const { x, y } = polarToXY(angle, PLOT_RADIUS)
            return (
              <line
                key={`hextant-line-${i}`}
                x1={PLOT_CENTER}
                y1={PLOT_CENTER}
                x2={x}
                y2={y}
                stroke="hsl(var(--border))"
                strokeWidth={0.8}
                opacity={0.3}
                strokeDasharray="3,3"
              />
            )
          })}

          {/* Hextant labels around the outside */}
          {HEXTANTS.map((h, i) => {
            const angle = hextantCenters[i]
            const { x, y } = polarToXY(angle, PLOT_RADIUS + 28)

            const angleDeg = ((angle - Math.PI / 2) * 180) / Math.PI + 90
            let textAnchor: "start" | "middle" | "end" = "middle"
            if (angleDeg > 30 && angleDeg < 150) textAnchor = "start"
            else if (angleDeg > 210 && angleDeg < 330) textAnchor = "end"

            return (
              <text
                key={`hextant-label-${i}`}
                x={x}
                y={y}
                textAnchor={textAnchor}
                dominantBaseline="central"
                fontSize={8}
                fontWeight={600}
                fill={h.color}
                opacity={0.8}
                className="pointer-events-none"
              >
                {h.label}
              </text>
            )
          })}

          {/* Render each data layer */}
          {layers.map((layer) => {
            const hasValues = Object.values(layer.values).some((v) => v > 0)
            if (!hasValues) return null

            const axisAngles = getAxisAngles(layer.keys.length, layer.widthsDeg)
            const points = buildPolygonPoints(layer.keys, layer.values, layer.widthsDeg)

            return (
              <g key={layer.label}>
                {/* Axis lines */}
                {layer.keys.map((key, i) => {
                  const angle = axisAngles[i]
                  const { x, y } = polarToXY(angle, PLOT_RADIUS)
                  return (
                    <line
                      key={`axis-${key}`}
                      x1={PLOT_CENTER}
                      y1={PLOT_CENTER}
                      x2={x}
                      y2={y}
                      stroke={layer.color}
                      strokeWidth={0.3}
                      opacity={0.25}
                    />
                  )
                })}

                {/* Wireframe polygon */}
                <polygon
                  points={points}
                  fill={layer.color}
                  fillOpacity={0.06}
                  stroke={layer.color}
                  strokeWidth={1.5}
                  strokeOpacity={0.8}
                  strokeLinejoin="round"
                />

                {/* Vertex dots */}
                {layer.keys.map((key, i) => {
                  const level = layer.values[key] ?? 0
                  if (level === 0) return null
                  const r = (level / MAX_LEVEL) * PLOT_RADIUS
                  const { x, y } = polarToXY(axisAngles[i], r)
                  return (
                    <circle
                      key={`dot-${key}`}
                      cx={x}
                      cy={y}
                      r={2.5}
                      fill={layer.color}
                      opacity={0.9}
                    />
                  )
                })}

                {/* Axis labels at edge */}
                {layer.keys.map((key, i) => {
                  const angle = axisAngles[i]
                  const { x, y } = polarToXY(angle, PLOT_RADIUS + 14)
                  const level = layer.values[key] ?? 0
                  if (level === 0) return null

                  const angleDeg = ((angle - Math.PI / 2) * 180) / Math.PI + 90
                  let textAnchor: "start" | "middle" | "end" = "middle"
                  if (angleDeg > 30 && angleDeg < 150) textAnchor = "start"
                  else if (angleDeg > 210 && angleDeg < 330) textAnchor = "end"

                  return (
                    <text
                      key={`label-${key}`}
                      x={x}
                      y={y}
                      textAnchor={textAnchor}
                      dominantBaseline="central"
                      fontSize={6}
                      fill={layer.color}
                      opacity={0.7}
                      className="pointer-events-none"
                    >
                      {key}
                    </text>
                  )
                })}
              </g>
            )
          })}
        </svg>
      </div>

      {/* Legend */}
      <div className="flex justify-center gap-4">
        {layers.map((layer) => {
          const hasValues = Object.values(layer.values).some((v) => v > 0)
          if (!hasValues) return null
          return (
            <div key={layer.label} className="flex items-center gap-1.5">
              <div
                className="w-3 h-0.5 rounded-full"
                style={{ backgroundColor: layer.color }}
              />
              <span className="text-[10px] text-muted-foreground">{layer.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
