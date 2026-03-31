"use client"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  CreateOfferingForm,
  type OfferingDraftPayload,
  type SelectedAgent,
} from "@/components/create-offering-form"

interface CreateOfferingModalProps {
  open: boolean
  onClose: () => void
  onCreated?: (offering: { resourceId?: string; payload: OfferingDraftPayload }) => void
  title?: string
  description?: string
  initialValues?: Partial<OfferingDraftPayload> & {
    targetAgents?: SelectedAgent[]
  }
  onSubmitPayload?: (payload: OfferingDraftPayload) => Promise<void> | void
}

export function CreateOfferingModal({
  open,
  onClose,
  onCreated,
  title = "Create New Offering",
  description = "Compose an offering once and reuse the same source-backed flow everywhere.",
  initialValues,
  onSubmitPayload,
}: CreateOfferingModalProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) onClose()
    }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <CreateOfferingForm
          initialValues={initialValues}
          onCancel={onClose}
          onCreated={onCreated}
          onSubmitPayload={onSubmitPayload}
        />
      </DialogContent>
    </Dialog>
  )
}
