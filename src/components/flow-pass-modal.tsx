/**
 * @fileoverview FlowPassModal - Dialog for engaging or learning about the Flow Pass discount program.
 *
 * Used in the group detail page to allow eligible users (Basic members with a matching locale)
 * to activate a 10% discount on marketplace offerings from a group. Non-members are prompted
 * to join Basic membership first.
 *
 * Key props: open, onClose, groupName, isBasicMember, onEngageFlowPass, onJoinBasic
 */
"use client"

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Percent, CheckCircle2, AlertCircle } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"

interface FlowPassModalProps {
  open: boolean
  onClose: () => void
  groupName: string
  isBasicMember: boolean
  onEngageFlowPass?: () => void
  onJoinBasic?: () => void
}

/**
 * Renders a modal dialog explaining the Flow Pass program and letting eligible users activate it.
 *
 * @param {FlowPassModalProps} props
 * @param {boolean} props.open - Whether the dialog is currently visible
 * @param {() => void} props.onClose - Callback to close the dialog
 * @param {string} props.groupName - Display name of the group offering the Flow Pass
 * @param {boolean} props.isBasicMember - Whether the current user has a Basic RIVR membership
 * @param {() => void} [props.onEngageFlowPass] - Optional callback fired when the user activates Flow Pass
 * @param {() => void} [props.onJoinBasic] - Optional callback fired when the user opts to join Basic
 */
export function FlowPassModal({
  open,
  onClose,
  groupName,
  isBasicMember,
  onEngageFlowPass,
  onJoinBasic
}: FlowPassModalProps) {
  const { toast } = useToast()

  /** Activates the Flow Pass, shows a confirmation toast, invokes the optional callback, and closes the modal. */
  const handleEngageFlowPass = () => {
    toast({
      title: "Flow Pass Engaged!",
      description: `You'll now receive 10% off all marketplace offerings from ${groupName}.`,
    })
    
    if (onEngageFlowPass) {
      onEngageFlowPass()
    }
    
    onClose()
  }
  
  /** Initiates the Basic membership signup flow, shows a redirect toast, invokes the optional callback, and closes the modal. */
  const handleJoinBasic = () => {
    toast({
      title: "Joining Basic Membership",
      description: "Redirecting to membership signup...",
    })
    
    if (onJoinBasic) {
      onJoinBasic()
    }
    
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-2xl">
            <Percent className="h-6 w-6 text-green-600" />
            Flow Pass Program
          </DialogTitle>
          <DialogDescription className="text-base">
            Get 10% off all marketplace offerings from {groupName}
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          <div className="bg-green-50 p-4 rounded-lg">
            <h3 className="font-medium text-green-800 mb-2">How Flow Pass Works</h3>
            <p className="text-green-700 text-sm mb-3">
              Members who share a home locale with one of {groupName}&apos;s locales get 10% off everything
              offered by this group in the marketplace.
            </p>
            <div className="flex items-start gap-2 mb-2">
              <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5" />
              <p className="text-sm text-foreground">
                <span className="font-medium">Basic Membership Required:</span> You must be a Basic member of RIVR to use Flow Pass.
              </p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5" />
              <p className="text-sm text-foreground">
                <span className="font-medium">Locale Matching:</span> Your home locale must match one of the group&apos;s locales.
              </p>
            </div>
          </div>
          
          {isBasicMember ? (
            <div className="bg-blue-50 p-4 rounded-lg">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-5 w-5 text-blue-600 mt-0.5" />
                <div>
                  <h3 className="font-medium text-blue-800">You&apos;re eligible for Flow Pass!</h3>
                  <p className="text-sm text-foreground mt-1">
                    As a Basic member with a matching locale, you can engage the Flow Pass to receive your 10% discount.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-amber-50 p-4 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5" />
                <div>
                  <h3 className="font-medium text-amber-800">Basic Membership Required</h3>
                  <p className="text-sm text-foreground mt-1">
                    You need to be a Basic member of RIVR to use Flow Pass. Join now to get access to discounts and other benefits.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} className="mr-2">
            Cancel
          </Button>
          
          {isBasicMember ? (
            <Button variant="secondary" onClick={handleEngageFlowPass} className="bg-green-100 hover:bg-green-200 text-green-800 border-green-300">
              <Percent className="mr-2 h-4 w-4" />
              Engage Flow Pass
            </Button>
          ) : (
            <Button variant="secondary" onClick={handleJoinBasic}>
              Join Basic Membership
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
