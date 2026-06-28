"use client";

/**
 * Lazy, bundle-isolated entry point for the Polotno design editor.
 *
 * Bundle policy (the whole point of this file): the heavy `polotno-editor`
 * module is loaded via `next/dynamic(..., { ssr: false })`, so the multi-hundred-KB
 * Polotno SDK is split into its own chunk and is NEVER part of the shared/main
 * bundle. It downloads only when a user actually opens this component.
 *
 * This wrapper also owns the client→server bridge: it forwards the exported
 * design to the `createDesignResource` server action (which derives identity from
 * the session) and provides user feedback / navigation on success.
 */

import { useCallback } from "react";
import nextDynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { createDesignResource } from "@/app/actions/resource-creation/designs";
import type { DesignExportPayload } from "./polotno-editor";

/** Loading placeholder shown while the heavy editor chunk downloads. */
function EditorLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
        <span className="text-sm">Loading design editor…</span>
      </div>
    </div>
  );
}

/**
 * Dynamically-imported Polotno editor. `ssr: false` guarantees the SDK never
 * runs (or bundles) on the server and is code-split out of the main bundle.
 */
const PolotnoEditor = nextDynamic(() => import("./polotno-editor"), {
  ssr: false,
  loading: () => <EditorLoading />,
});

export interface DesignEditorLazyProps {
  /** Optional initial scene JSON to resume editing an existing design. */
  initialSceneJson?: string;
  /** Optional initial design name. */
  initialName?: string;
  /**
   * Optional owning agent (a group the caller administers) whose media the
   * editor's Photos panel should surface. Defaults to the authenticated user.
   */
  ownerAgentId?: string;
}

/**
 * Client surface for the design editor. Bridges the editor's export to the
 * server-side persistence action and handles success/error UX.
 */
export function DesignEditorLazy({
  initialSceneJson,
  initialName,
  ownerAgentId,
}: DesignEditorLazyProps) {
  const router = useRouter();
  const { toast } = useToast();

  const handleSave = useCallback(
    async (payload: DesignExportPayload) => {
      const result = await createDesignResource({
        name: payload.name,
        dataUrl: payload.dataUrl,
        sceneJson: payload.sceneJson,
        width: payload.width,
        height: payload.height,
      });

      if (!result.success) {
        // Surface the specific server message and keep the editor open so the
        // user does not lose their work.
        toast({
          title: "Could not save design",
          description: result.message,
          variant: "destructive",
        });
        // Re-throw so the editor's inline error state also reflects the failure.
        throw new Error(result.message);
      }

      toast({
        title: "Design saved",
        description: "Your design is now in your library.",
      });
      router.refresh();
    },
    [router, toast],
  );

  return (
    <PolotnoEditor
      onSave={handleSave}
      initialSceneJson={initialSceneJson}
      initialName={initialName}
      ownerAgentId={ownerAgentId}
    />
  );
}
