"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PAYOUT_COUNTRY_OPTIONS,
  payoutRailNote,
  railForCountry,
} from "@/lib/payout-countries";

export function PayoutCountryDialog({
  open,
  onOpenChange,
  onConfirm,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (country: string) => void;
  disabled?: boolean;
}) {
  const [country, setCountry] = useState("US");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Where is your bank?</DialogTitle>
          <DialogDescription>
            Choose the country of the bank account you want to be paid into.
            This cannot be changed after payout setup begins.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={country} onValueChange={setCountry}>
            <SelectTrigger>
              <SelectValue placeholder="Select country" />
            </SelectTrigger>
            <SelectContent>
              {PAYOUT_COUNTRY_OPTIONS.map((option) => (
                <SelectItem key={option.code} value={option.code}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            {payoutRailNote(railForCountry(country))}
          </p>
        </div>
        <DialogFooter>
          <Button
            disabled={disabled}
            onClick={() => {
              onOpenChange(false);
              onConfirm(country);
            }}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
