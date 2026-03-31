/**
 * @fileoverview RingActions - Edit/delete actions for ring detail pages.
 *
 * Displayed when the current user is a ring admin. Provides inline editing
 * and delete confirmation using `updateGroupResource` and `deleteGroupResource`
 * server actions.
 */
import { EntityActions } from "@/components/entity-actions"

/**
 * Props for owner-only ring edit/delete actions.
 */
interface RingActionsProps {
  ringId: string
  ringName: string
  ringDescription?: string | null
  ownerId?: string
}

/**
 * Renders owner-only ring mutation controls.
 *
 * @param props - Ring identifiers and existing editable values.
 * @returns Edit/delete controls when current user owns the ring; otherwise null.
 */
export function RingActions({ ringId, ringName, ringDescription, ownerId }: RingActionsProps) {
  return (
    <EntityActions
      entityId={ringId}
      entityName={ringName}
      entityDescription={ringDescription}
      ownerId={ownerId}
      entityLabel="ring"
      redirectPath="/rings"
    />
  )
}
