"use client"

/**
 * Compact D3 force-directed relationship graph for agent pages.
 *
 * Renders the given agent as a center node with its connections (members,
 * subgroups, events, posts, offerings for groups; groups, posts, events for
 * people) radiating outward. Clicking a connected node navigates to that
 * agent's page.
 *
 * Props:
 * - agentId   — the focal agent's UUID
 * - agentName — display name for center node
 * - agentType — "person" | "group" | "organization" | "ring" | "family"
 *
 * Uses entity-style.ts colors/radii and the same visual language as
 * ExploreGraphCanvas (colored shapes, white lineal SVG icons, labeled edges).
 */

import { useEffect, useRef, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import * as d3 from "d3"
import {
  fetchGroupDetail,
  fetchProfileData,
} from "@/app/actions/graph"
import {
  agentToUser,
  agentToGroup,
  agentToEvent,
  resourceToPost,
  resourceToMarketplaceListing,
} from "@/lib/graph-adapters"
import {
  GRAPH_CATEGORY_COLORS,
  GRAPH_CATEGORY_RADII,
  type GraphNodeCategory,
} from "@/lib/entity-style"

// ─── Constants ──────────────────────────────────────────────────────────────

const NODE_TYPE = {
  PERSON: "person",
  GROUP: "group",
  EVENT: "event",
  POST: "post",
  OFFERING: "offering",
} as const

type NodeType = (typeof NODE_TYPE)[keyof typeof NODE_TYPE]

const NODE_COLORS: Record<NodeType, string> = GRAPH_CATEGORY_COLORS
const NODE_RADII: Record<NodeType, number> = GRAPH_CATEGORY_RADII

/** Compact radii — scaled down for the mini graph. */
const MINI_SCALE = 0.7
const scaledRadius = (type: NodeType): number => Math.round(NODE_RADII[type] * MINI_SCALE)

const MAX_LABEL_LENGTH = 14
const GRAPH_HEIGHT = 300
const FORCE_CHARGE = -120
const FORCE_LINK_DISTANCE = 90
const FORCE_COLLISION_PAD = 8

// ─── Types ──────────────────────────────────────────────────────────────────

interface MiniNode extends d3.SimulationNodeDatum {
  id: string
  label: string
  type: NodeType
  href: string
  isCenter?: boolean
}

interface MiniLink extends d3.SimulationLinkDatum<MiniNode> {
  id: string
  label?: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncateLabel(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH) return label
  return label.slice(0, MAX_LABEL_LENGTH - 1) + "\u2026"
}

function makeLinkId(a: string, b: string): string {
  return a < b ? `${a}--${b}` : `${b}--${a}`
}

function agentTypeToNodeType(type: string): NodeType {
  if (type === "person") return NODE_TYPE.PERSON
  if (["organization", "group", "ring", "family"].includes(type)) return NODE_TYPE.GROUP
  if (type === "event") return NODE_TYPE.EVENT
  if (["post", "note"].includes(type)) return NODE_TYPE.POST
  return NODE_TYPE.OFFERING
}

// ─── Component ──────────────────────────────────────────────────────────────

interface AgentGraphProps {
  agentId: string
  agentName: string
  agentType: string
}

export function AgentGraph({ agentId, agentName, agentType }: AgentGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  const [nodes, setNodes] = useState<MiniNode[]>([])
  const [links, setLinks] = useState<MiniLink[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  // ─── Fetch connections ──────────────────────────────────────────────────

  const fetchConnections = useCallback(async () => {
    setLoading(true)
    setError(false)

    const centerType = agentTypeToNodeType(agentType)
    const centerNode: MiniNode = {
      id: agentId,
      label: agentName,
      type: centerType,
      href: centerType === NODE_TYPE.PERSON
        ? `/profile/${agentId}`
        : `/groups/${agentId}`,
      isCenter: true,
    }

    const newNodes: MiniNode[] = [centerNode]
    const newLinks: MiniLink[] = []
    const seen = new Set<string>([agentId])

    try {
      if (centerType === NODE_TYPE.GROUP) {
        const detail = await fetchGroupDetail(agentId)
        if (detail) {
          // Members
          for (const member of detail.members.slice(0, 20)) {
            const user = agentToUser(member)
            if (seen.has(user.id)) continue
            seen.add(user.id)
            newNodes.push({
              id: user.id,
              label: user.name || user.username || "Unknown",
              type: NODE_TYPE.PERSON,
              href: user.profileHref || `/profile/${user.username || user.id}`,
            })
            newLinks.push({
              id: makeLinkId(agentId, user.id),
              source: agentId,
              target: user.id,
              label: "member",
            })
          }

          // Subgroups
          for (const sub of detail.subgroups.slice(0, 10)) {
            const group = agentToGroup(sub)
            if (seen.has(group.id)) continue
            seen.add(group.id)
            newNodes.push({
              id: group.id,
              label: group.name || "Subgroup",
              type: NODE_TYPE.GROUP,
              href: `/groups/${group.id}`,
            })
            newLinks.push({
              id: makeLinkId(agentId, group.id),
              source: agentId,
              target: group.id,
              label: "contains",
            })
          }

          // Events
          for (const evt of detail.events.slice(0, 10)) {
            const event = agentToEvent(evt)
            if (seen.has(event.id)) continue
            seen.add(event.id)
            newNodes.push({
              id: event.id,
              label: event.name || event.title || "Event",
              type: NODE_TYPE.EVENT,
              href: `/events/${event.id}`,
            })
            newLinks.push({
              id: makeLinkId(agentId, event.id),
              source: agentId,
              target: event.id,
              label: "hosts",
            })
          }

          // Resources (posts + offerings)
          for (const res of detail.resources.slice(0, 15)) {
            const meta = (res.metadata ?? {}) as Record<string, unknown>
            const entityType = String(meta.entityType ?? res.type ?? "")
            if (entityType === "post" || res.type === "post" || res.type === "note") {
              const post = resourceToPost(res)
              if (seen.has(post.id)) continue
              seen.add(post.id)
              newNodes.push({
                id: post.id,
                label: post.title || post.content?.slice(0, 20) || "Post",
                type: NODE_TYPE.POST,
                href: `/posts/${post.id}`,
              })
              newLinks.push({
                id: makeLinkId(agentId, post.id),
                source: agentId,
                target: post.id,
                label: "posted",
              })
            } else if (meta.listingType) {
              const listing = resourceToMarketplaceListing(res)
              if (seen.has(listing.id)) continue
              seen.add(listing.id)
              newNodes.push({
                id: listing.id,
                label: listing.title || "Offering",
                type: NODE_TYPE.OFFERING,
                href: `/marketplace/${listing.id}`,
              })
              newLinks.push({
                id: makeLinkId(agentId, listing.id),
                source: agentId,
                target: listing.id,
                label: "offers",
              })
            }
          }
        }
      } else if (centerType === NODE_TYPE.PERSON) {
        const profile = await fetchProfileData(agentId)
        if (profile) {
          // Resources owned by person
          for (const res of profile.resources.slice(0, 20)) {
            const meta = (res.metadata ?? {}) as Record<string, unknown>
            const entityType = String(meta.entityType ?? res.type ?? "")
            if (entityType === "post" || res.type === "post" || res.type === "note") {
              const post = resourceToPost(res)
              if (seen.has(post.id)) continue
              seen.add(post.id)
              newNodes.push({
                id: post.id,
                label: post.title || post.content?.slice(0, 20) || "Post",
                type: NODE_TYPE.POST,
                href: `/posts/${post.id}`,
              })
              newLinks.push({
                id: makeLinkId(agentId, post.id),
                source: agentId,
                target: post.id,
                label: "posted",
              })
            } else if (meta.listingType) {
              const listing = resourceToMarketplaceListing(res)
              if (seen.has(listing.id)) continue
              seen.add(listing.id)
              newNodes.push({
                id: listing.id,
                label: listing.title || "Offering",
                type: NODE_TYPE.OFFERING,
                href: `/marketplace/${listing.id}`,
              })
              newLinks.push({
                id: makeLinkId(agentId, listing.id),
                source: agentId,
                target: listing.id,
                label: "offers",
              })
            }
          }

          // Activity — groups/events the person is connected to
          for (const activity of profile.recentActivity) {
            if (!activity.objectId || seen.has(activity.objectId)) continue
            const obj = activity.object as { id: string; name: string; kind: string; type: string } | null
            if (!obj) continue
            seen.add(activity.objectId)
            const objNodeType = agentTypeToNodeType(obj.type)
            const href = objNodeType === NODE_TYPE.PERSON
              ? `/profile/${activity.objectId}`
              : objNodeType === NODE_TYPE.GROUP
                ? `/groups/${activity.objectId}`
                : objNodeType === NODE_TYPE.EVENT
                  ? `/events/${activity.objectId}`
                  : `/posts/${activity.objectId}`
            newNodes.push({
              id: activity.objectId,
              label: obj.name || "Unknown",
              type: objNodeType,
              href,
            })
            newLinks.push({
              id: makeLinkId(agentId, activity.objectId),
              source: agentId,
              target: activity.objectId,
              label: activity.verb?.replace("_", " ") || "related",
            })
          }
        }
      }
    } catch (err) {
      console.error("[AgentGraph] Failed to fetch connections:", err)
      setError(true)
    }

    setNodes(newNodes)
    setLinks(newLinks)
    setLoading(false)
  }, [agentId, agentName, agentType])

  useEffect(() => {
    fetchConnections()
  }, [fetchConnections])

  // ─── D3 Rendering ─────────────────────────────────────────────────────

  useEffect(() => {
    const svg = svgRef.current
    const container = containerRef.current
    if (!svg || !container || nodes.length === 0) return

    const width = container.clientWidth
    const height = GRAPH_HEIGHT

    d3.select(svg).selectAll("*").remove()

    const svgSel = d3
      .select(svg)
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`)

    const g = svgSel.append("g")

    // Zoom
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 3])
      .on("zoom", (event) => {
        g.attr("transform", event.transform)
      })
    svgSel.call(zoom)

    // Clone data for D3 mutation
    const simNodes: MiniNode[] = nodes.map((n) => ({ ...n }))
    const simLinks: MiniLink[] = links.map((l) => ({
      ...l,
      source: typeof l.source === "object" ? (l.source as MiniNode).id : l.source,
      target: typeof l.target === "object" ? (l.target as MiniNode).id : l.target,
    }))

    // Pin center node
    const centerNode = simNodes.find((n) => n.isCenter)
    if (centerNode) {
      centerNode.fx = width / 2
      centerNode.fy = height / 2
    }

    // Force simulation
    const simulation = d3
      .forceSimulation(simNodes)
      .force(
        "link",
        d3
          .forceLink<MiniNode, MiniLink>(simLinks)
          .id((d) => d.id)
          .distance(FORCE_LINK_DISTANCE)
      )
      .force("charge", d3.forceManyBody().strength(FORCE_CHARGE).distanceMax(200))
      .force("center", d3.forceCenter(width / 2, height / 2).strength(0.1))
      .force("x", d3.forceX(width / 2).strength(0.08))
      .force("y", d3.forceY(height / 2).strength(0.08))
      .force(
        "collision",
        d3.forceCollide<MiniNode>().radius((d) => scaledRadius(d.type) + FORCE_COLLISION_PAD)
      )
      .velocityDecay(0.45)
      .alphaDecay(0.06)

    // Links
    const link = g
      .append("g")
      .attr("class", "links")
      .selectAll("line")
      .data(simLinks)
      .join("line")
      .attr("stroke", (d) => {
        const sourceNode = simNodes.find((n) => n.id === (typeof d.source === "object" ? (d.source as MiniNode).id : d.source))
        return sourceNode ? NODE_COLORS[sourceNode.type] : "currentColor"
      })
      .attr("stroke-opacity", 0.3)
      .attr("stroke-width", 1.5)

    // Edge labels
    const edgeLabels = g
      .append("g")
      .attr("class", "edge-labels")
      .selectAll("text")
      .data(simLinks)
      .join("text")
      .text((d) => d.label ?? "")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .attr("fill", "currentColor")
      .attr("font-size", "8px")
      .attr("font-weight", "500")
      .attr("opacity", 0.45)
      .attr("pointer-events", "none")
      .style("text-shadow", "0 1px 2px rgba(0,0,0,0.8)")

    // Node groups
    const nodeGroup = g
      .append("g")
      .attr("class", "nodes")
      .selectAll<SVGGElement, MiniNode>("g")
      .data(simNodes)
      .join("g")
      .attr("cursor", "pointer")
      .call(
        d3
          .drag<SVGGElement, MiniNode>()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.1).restart()
            d.fx = d.x
            d.fy = d.y
          })
          .on("drag", (event, d) => {
            d.fx = event.x
            d.fy = event.y
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0)
            if (!d.isCenter) {
              d.fx = null
              d.fy = null
            }
          })
      )

    // Click — navigate to agent page
    nodeGroup.on("click", (event, d) => {
      event.stopPropagation()
      if (d.isCenter) return // don't navigate away from current page
      router.push(d.href)
    })

    // Draw shapes
    nodeGroup.each(function (d) {
      const el = d3.select(this)
      const r = scaledRadius(d.type)
      const color = NODE_COLORS[d.type]
      const isCenter = d.isCenter === true

      if (d.type === NODE_TYPE.GROUP) {
        const w = r * 2
        const h = r * 1.6
        el.append("rect")
          .attr("x", -w / 2)
          .attr("y", -h / 2)
          .attr("width", w)
          .attr("height", h)
          .attr("rx", 5)
          .attr("ry", 5)
          .attr("fill", color)
          .attr("fill-opacity", isCenter ? 1 : 0.85)
          .attr("stroke", isCenter ? "#fff" : color)
          .attr("stroke-width", isCenter ? 3 : 1.5)
          .attr("stroke-opacity", isCenter ? 1 : 0.5)
      } else if (d.type === NODE_TYPE.EVENT) {
        const pts = [
          [0, -r],
          [r, 0],
          [0, r],
          [-r, 0],
        ]
          .map(([px, py]) => `${px},${py}`)
          .join(" ")
        el.append("polygon")
          .attr("points", pts)
          .attr("fill", color)
          .attr("fill-opacity", isCenter ? 1 : 0.85)
          .attr("stroke", isCenter ? "#fff" : color)
          .attr("stroke-width", isCenter ? 3 : 1.5)
          .attr("stroke-opacity", isCenter ? 1 : 0.5)
      } else {
        el.append("circle")
          .attr("r", r)
          .attr("fill", color)
          .attr("fill-opacity", isCenter ? 1 : 0.85)
          .attr("stroke", isCenter ? "#fff" : color)
          .attr("stroke-width", isCenter ? 3 : 1.5)
          .attr("stroke-opacity", isCenter ? 1 : 0.5)
      }

      // Label
      el.append("text")
        .text(truncateLabel(d.label))
        .attr("text-anchor", "middle")
        .attr("dy", r + 12)
        .attr("fill", "currentColor")
        .attr("font-size", isCenter ? "11px" : "9px")
        .attr("font-weight", isCenter ? "600" : "400")
        .attr("pointer-events", "none")
        .style("text-shadow", "0 1px 3px rgba(0,0,0,0.3)")

      // Inline SVG icon (white lineal/outline style)
      const iconScale = r * 0.05
      const iconG = el.append("g")
        .attr("fill", "none")
        .attr("stroke", "white")
        .attr("stroke-width", 1.5)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .attr("pointer-events", "none")
        .attr("transform", `scale(${iconScale})`)

      if (d.type === NODE_TYPE.PERSON) {
        iconG.append("circle").attr("cx", 0).attr("cy", -5).attr("r", 5)
        iconG.append("path").attr("d", "M-10 12 C-10 4 10 4 10 12")
      } else if (d.type === NODE_TYPE.GROUP) {
        iconG.append("circle").attr("cx", -4).attr("cy", -5).attr("r", 4)
        iconG.append("path").attr("d", "M-12 10 C-12 4 4 4 4 10")
        iconG.append("circle").attr("cx", 5).attr("cy", -5).attr("r", 4)
        iconG.append("path").attr("d", "M-3 10 C-3 4 13 4 13 10")
      } else if (d.type === NODE_TYPE.EVENT) {
        iconG.append("rect").attr("x", -8).attr("y", -5).attr("width", 16).attr("height", 14).attr("rx", 2)
        iconG.append("line").attr("x1", -4).attr("y1", -8).attr("x2", -4).attr("y2", -3)
        iconG.append("line").attr("x1", 4).attr("y1", -8).attr("x2", 4).attr("y2", -3)
        iconG.append("line").attr("x1", -8).attr("y1", 0).attr("x2", 8).attr("y2", 0)
      } else if (d.type === NODE_TYPE.POST) {
        iconG.append("rect").attr("x", -7).attr("y", -9).attr("width", 14).attr("height", 18).attr("rx", 2)
        iconG.append("line").attr("x1", -3).attr("y1", -3).attr("x2", 3).attr("y2", -3)
        iconG.append("line").attr("x1", -3).attr("y1", 1).attr("x2", 3).attr("y2", 1)
        iconG.append("line").attr("x1", -3).attr("y1", 5).attr("x2", 1).attr("y2", 5)
      } else if (d.type === NODE_TYPE.OFFERING) {
        iconG.append("path").attr("d", "M-8 -2 L0 -10 L8 -2 L8 8 L-8 8 Z")
        iconG.append("circle").attr("cx", 0).attr("cy", -4).attr("r", 2)
      }
    })

    // Hover effects
    nodeGroup
      .on("mouseenter", function (_, d) {
        d3.select(this).select("circle, rect, polygon")
          .attr("fill-opacity", 1)
          .attr("stroke", "#fff")
          .attr("stroke-width", 2.5)
        link.attr("stroke-opacity", (l) => {
          const sId = typeof l.source === "object" ? (l.source as MiniNode).id : l.source
          const tId = typeof l.target === "object" ? (l.target as MiniNode).id : l.target
          return sId === d.id || tId === d.id ? 0.7 : 0.1
        })
        edgeLabels.attr("opacity", (l) => {
          const sId = typeof l.source === "object" ? (l.source as MiniNode).id : l.source
          const tId = typeof l.target === "object" ? (l.target as MiniNode).id : l.target
          return sId === d.id || tId === d.id ? 1 : 0.15
        })
      })
      .on("mouseleave", function () {
        d3.select(this).select("circle, rect, polygon")
          .attr("fill-opacity", 0.85)
          .attr("stroke-width", 1.5)
        link.attr("stroke-opacity", 0.3)
        edgeLabels.attr("opacity", 0.45)
      })

    // Tick
    simulation.on("tick", () => {
      link
        .attr("x1", (d) => ((d.source as MiniNode).x ?? 0))
        .attr("y1", (d) => ((d.source as MiniNode).y ?? 0))
        .attr("x2", (d) => ((d.target as MiniNode).x ?? 0))
        .attr("y2", (d) => ((d.target as MiniNode).y ?? 0))

      edgeLabels
        .attr("x", (d) => {
          const sx = (d.source as MiniNode).x ?? 0
          const tx = (d.target as MiniNode).x ?? 0
          return (sx + tx) / 2
        })
        .attr("y", (d) => {
          const sy = (d.source as MiniNode).y ?? 0
          const ty = (d.target as MiniNode).y ?? 0
          return (sy + ty) / 2 - 5
        })

      nodeGroup.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    return () => {
      simulation.stop()
    }
  }, [nodes, links, router])

  // ─── Resize ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current
    const svg = svgRef.current
    if (!container || !svg) return

    const observer = new ResizeObserver(() => {
      const w = container.clientWidth
      d3.select(svg).attr("width", w).attr("viewBox", `0 0 ${w} ${GRAPH_HEIGHT}`)
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border bg-background text-sm text-muted-foreground"
        style={{ height: GRAPH_HEIGHT }}
      >
        Loading relationship graph...
      </div>
    )
  }

  if (error || nodes.length <= 1) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border bg-background text-sm text-muted-foreground"
        style={{ height: GRAPH_HEIGHT }}
      >
        {error ? "Could not load relationships." : "No connections to display."}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded-lg border bg-background overflow-hidden"
      style={{ height: GRAPH_HEIGHT }}
    >
      <svg
        ref={svgRef}
        className="w-full text-foreground"
        style={{ height: GRAPH_HEIGHT }}
      />
      <div className="absolute bottom-2 left-0 right-0 text-center">
        <p className="text-[10px] text-muted-foreground/60">
          Click a node to visit. Drag to rearrange. Scroll to zoom.
        </p>
      </div>
    </div>
  )
}
