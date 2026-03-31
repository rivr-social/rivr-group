/**
 * @fileoverview GroupActions - Edit/delete actions for group detail pages.
 *
 * Displayed when the current user is an admin or creator of the group. Provides
 * inline editing and delete confirmation using `updateGroupResource` and
 * `deleteGroupResource` server actions.
 */
import { EntityActions } from "@/components/entity-actions"

/**
 * Props for owner-only group edit/delete actions.
 */
interface GroupActionsProps {
  groupId: string
  groupName: string
  groupDescription?: string | null
  ownerId?: string
}

/**
 * Renders owner-only group mutation controls.
 *
 * @param props - Group identifiers and existing editable values.
 * @returns Edit/delete controls when current user owns the group; otherwise null.
 */
export function GroupActions({ groupId, groupName, groupDescription, ownerId }: GroupActionsProps) {
  return (
    <EntityActions
      entityId={groupId}
      entityName={groupName}
      entityDescription={groupDescription}
      ownerId={ownerId}
      entityLabel="group"
      redirectPath="/groups"
    />
  )
}
