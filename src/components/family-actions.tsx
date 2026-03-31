/**
 * @fileoverview FamilyActions - Edit/delete actions for family group detail pages.
 *
 * Displayed when the current user is an admin of the family group. Provides
 * inline editing and delete confirmation using `updateGroupResource` and
 * `deleteGroupResource` server actions.
 */
import { EntityActions } from "@/components/entity-actions"

/**
 * Props for owner-only family edit/delete actions.
 */
interface FamilyActionsProps {
  familyId: string
  familyName: string
  familyDescription?: string | null
  ownerId?: string
}

/**
 * Renders owner-only family mutation controls.
 *
 * Families are agents of type 'organization' and share the same update/delete
 * server actions as groups and rings.
 *
 * @param props - Family identifiers and existing editable values.
 * @returns Edit/delete controls when current user owns the family; otherwise null.
 */
export function FamilyActions({ familyId, familyName, familyDescription, ownerId }: FamilyActionsProps) {
  return (
    <EntityActions
      entityId={familyId}
      entityName={familyName}
      entityDescription={familyDescription}
      ownerId={ownerId}
      entityLabel="family"
      redirectPath="/families"
    />
  )
}
