/**
 * @fileoverview ManageAffiliations - Dialog content for managing group affiliations.
 *
 * Used within the group admin settings to add/remove affiliated groups.
 * Provides a searchable group list and affiliation type selection.
 */
"use client"

import { useState } from "react"
import type { Group } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { SearchableSelect } from "@/components/searchable-select"

interface ManageAffiliationsProps {
  currentGroup: Group
  allGroups: Group[]
  onAddAffiliation: (groupId: string) => void
  onCancel: () => void
}

export function ManageAffiliations({ currentGroup, allGroups, onAddAffiliation, onCancel }: ManageAffiliationsProps) {
  const [selectedGroupId, setSelectedGroupId] = useState("")

  // Filter out groups that are already affiliated, the current group, and any parent/child groups
  const availableGroups = allGroups.filter(
    (g) =>
      g.id !== currentGroup.id &&
      g.id !== currentGroup.parentGroupId &&
      g.parentGroupId !== currentGroup.id &&
      !currentGroup.affiliatedGroupIds?.includes(g.id) &&
      !g.affiliatedGroupIds?.includes(currentGroup.id),
  )
  const availableGroupOptions = availableGroups.map((group) => ({
    value: group.id,
    label: group.name,
    description: group.description ?? undefined,
  }))

  return (
    <div className="space-y-4 mt-4">
      <div className="space-y-2">
        <Label htmlFor="group">Select Group to Affiliate With</Label>
        {availableGroups.length > 0 ? (
          <SearchableSelect
            value={selectedGroupId}
            onChange={setSelectedGroupId}
            options={availableGroupOptions}
            placeholder="Select a group..."
            searchPlaceholder="Search groups..."
            emptyLabel="No groups found."
          />
        ) : (
          <p className="text-sm text-muted-foreground">No available groups to affiliate with.</p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          onClick={() => onAddAffiliation(selectedGroupId)}
          disabled={!selectedGroupId || availableGroups.length === 0}
        >
          Add Affiliation
        </Button>
      </div>
    </div>
  )
}
