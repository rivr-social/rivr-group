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
      <DialogContent className="max-w-4xl max-h-[90vh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto px-6 pb-6">
          <CreateOfferingForm
            initialValues={initialValues}
            onCancel={onClose}
            onCreated={onCreated}
            onSubmitPayload={onSubmitPayload}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
