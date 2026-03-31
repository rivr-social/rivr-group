"use client";

/**
 * PersonaBanner component.
 *
 * Renders a sticky banner below the header when the user is operating as a persona.
 * Shows the persona name and a "Switch back" button.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Drama, X } from "lucide-react";
import { getActivePersonaInfo, switchActivePersona } from "@/app/actions/personas";
import type { SerializedAgent } from "@/lib/graph-serializers";

export function PersonaBanner() {
  const router = useRouter();
  const [persona, setPersona] = useState<SerializedAgent | null>(null);
  const [loading, setLoading] = useState(false);

  const checkPersona = useCallback(async () => {
    try {
      const info = await getActivePersonaInfo();
      setPersona(info.active && info.persona ? info.persona : null);
    } catch {
      setPersona(null);
    }
  }, []);

  useEffect(() => {
    checkPersona();
  }, [checkPersona]);

  const handleSwitchBack = async () => {
    setLoading(true);
    try {
      await switchActivePersona(null);
      setPersona(null);
      router.refresh();
    } finally {
      setLoading(false);
    }
  };

  if (!persona) return null;

  return (
    <div className="fixed top-16 left-0 right-0 z-40 flex items-center justify-center gap-3 border-b bg-primary/10 px-4 py-1.5 text-sm">
      <Drama className="h-4 w-4 text-primary shrink-0" />
      <span>
        Operating as <strong>{persona.name}</strong>
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={handleSwitchBack}
        disabled={loading}
      >
        <X className="h-3 w-3 mr-1" />
        Switch Back
      </Button>
    </div>
  );
}
