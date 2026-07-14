"use client";

/**
 * Polotno canvas/design editor (HEAVY client bundle).
 *
 * ⚠️ Bundle policy: this module statically imports the full Polotno SDK
 * (`polotno/*`, `mobx`, `blueprint`), which is large. It MUST ONLY ever be
 * reached through `design-editor-lazy.tsx`, which loads it via
 * `next/dynamic(..., { ssr: false })`. Do NOT import this file directly from a
 * page/server component or it will be pulled into the shared/main bundle.
 *
 * Responsibility:
 * - Render the Polotno workspace (canvas + toolbar + side panel).
 * - On "Save", export the canvas to a PNG data URL + scene JSON and hand them to
 *   the parent via `onSave`. It does NOT talk to the server itself — persistence
 *   is the parent's job (server action), keeping identity server-derived.
 */

import { useMemo, useState, useCallback, useEffect } from "react";
import { createStore } from "polotno/model/store";
import type { StoreType } from "polotno/model/store";
import { PolotnoContainer, SidePanelWrap, WorkspaceWrap } from "polotno/polotno-app";
import { Workspace } from "polotno/canvas/workspace";
import { Toolbar } from "polotno/toolbar/toolbar";
import { ZoomButtons } from "polotno/toolbar/zoom-buttons";
import {
  SidePanel,
  DEFAULT_SECTIONS,
  SectionTab,
  ImagesGrid,
  type Section,
} from "polotno/side-panel/side-panel";
import { getImageSize } from "polotno/utils/image";
import "polotno/polotno.blueprint.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Image as ImageIcon, Loader2, Save } from "lucide-react";

/** Export pixel ratio for the saved raster (1 = canvas resolution). */
const EXPORT_PIXEL_RATIO = 1;
/** Default canvas size for a fresh design (social-card friendly). */
const DEFAULT_CANVAS_WIDTH = 1080;
const DEFAULT_CANVAS_HEIGHT = 1080;
/**
 * Polotno license key.
 *
 * The editor renders and exports fully without a key (no paywall per the product
 * decision), but an unlicensed store logs a "license key missing" warning and
 * may show a small credit. Supply a key to silence it: set
 * `NEXT_PUBLIC_POLOTNO_KEY` (a public build-time env var — the value is baked
 * into the client bundle, which is fine for Polotno's client-side key). When the
 * var is absent we fall back to an empty key and the editor still works, just
 * with the SDK's default unlicensed behavior. Cameron must supply the key (see
 * CLAUDE.md "Design editor / Polotno"). We do NOT suppress the watermark beyond
 * Polotno's own `showCredit: false` option below.
 */
const POLOTNO_KEY = process.env.NEXT_PUBLIC_POLOTNO_KEY ?? "";

/** Fallback canvas placement size when an image's natural size can't be read. */
const FALLBACK_IMAGE_SIZE = 200;

/** One image offered to the owner-media ("My Photos") panel. */
interface OwnerMediaImage {
  key: string;
  src: string;
  label: string;
}

/**
 * Builds the editor's "My Photos" side-panel section, backed by the OWNING
 * agent's own media (`GET /api/design/media`) instead of a third-party stock
 * service. Replaces Polotno's default Unsplash-backed Photos section. The owner
 * is derived server-side from the session; `ownerAgentId` only names a group the
 * caller may manage and is authorized (never trusted) by the route.
 */
function buildOwnerPhotosSection(ownerAgentId?: string): Section {
  const OwnerPhotosPanel = ({ store }: { store: StoreType }) => {
    const [images, setImages] = useState<OwnerMediaImage[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      let cancelled = false;
      const url = ownerAgentId
        ? `/api/design/media?ownerAgentId=${encodeURIComponent(ownerAgentId)}`
        : "/api/design/media";
      setIsLoading(true);
      setError(null);
      fetch(url, { credentials: "same-origin" })
        .then(async (res) => {
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as
              | { error?: string }
              | null;
            throw new Error(body?.error ?? `Failed to load media (${res.status})`);
          }
          return res.json() as Promise<{ items: OwnerMediaImage[] }>;
        })
        .then((data) => {
          if (!cancelled) setImages(data.items ?? []);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "Failed to load media");
          }
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, []);

    const onSelect = useCallback(
      async (image: OwnerMediaImage) => {
        const page = store.activePage;
        if (!page) return;
        let width = FALLBACK_IMAGE_SIZE;
        let height = FALLBACK_IMAGE_SIZE;
        try {
          const size = await getImageSize(image.src);
          if (size?.width && size?.height) {
            width = size.width;
            height = size.height;
          }
        } catch {
          // Keep fallback square; placement should still succeed.
        }
        page.addElement({
          type: "image",
          src: image.src,
          width,
          height,
          x: Math.max(0, store.width / 2 - width / 2),
          y: Math.max(0, store.height / 2 - height / 2),
        });
      },
      [store],
    );

    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        {error && (
          <div style={{ padding: "8px 4px", color: "#c23030", fontSize: 13 }}>
            {error}
          </div>
        )}
        <ImagesGrid
          images={images}
          isLoading={isLoading}
          getPreview={(image) => image.src}
          getAlt={(image) => image.label}
          onSelect={(image) => {
            void onSelect(image);
          }}
          rowsNumber={2}
          hideNoResults={isLoading}
        />
        {!isLoading && !error && images.length === 0 && (
          <div
            style={{
              padding: "12px 4px",
              color: "#5c7080",
              fontSize: 13,
              textAlign: "center",
            }}
          >
            No photos yet. Upload images to your profile or gallery and they will
            appear here.
          </div>
        )}
      </div>
    );
  };

  return {
    name: "photos",
    Tab: (props) => (
      <SectionTab name="Photos" {...props}>
        <ImageIcon size={20} />
      </SectionTab>
    ),
    Panel: OwnerPhotosPanel,
  };
}

/**
 * Default Polotno sections with the stock Photos section swapped for the
 * owner-media one. All other sections (templates, text, elements, upload, etc.)
 * are preserved in their original order.
 */
function buildEditorSections(ownerAgentId?: string): Section[] {
  const ownerPhotos = buildOwnerPhotosSection(ownerAgentId);
  return DEFAULT_SECTIONS.map((section) =>
    section.name === "photos" ? ownerPhotos : section,
  );
}

/** Payload handed to the parent on save. */
export interface DesignExportPayload {
  /** Design name entered by the user. */
  name: string;
  /** PNG data URL of the rendered canvas. */
  dataUrl: string;
  /** Serialized Polotno scene JSON for later re-editing. */
  sceneJson: string;
  /** Canvas width in pixels. */
  width: number;
  /** Canvas height in pixels. */
  height: number;
}

export interface PolotnoEditorProps {
  /**
   * Persists the exported design. Should return a resolved promise on success;
   * a rejection surfaces an inline error and keeps the editor open.
   */
  onSave: (payload: DesignExportPayload) => Promise<void>;
  /** Optional initial scene JSON to resume editing an existing design. */
  initialSceneJson?: string;
  /** Optional initial design name. */
  initialName?: string;
  /**
   * Optional owning agent (a group the caller administers) whose media the
   * Photos panel should surface. Defaults to the authenticated user (self) when
   * omitted. Only NAMES the owner — the server route authorizes it.
   */
  ownerAgentId?: string;
}

/**
 * The full Polotno editor surface. Mounted only inside an `ssr:false` dynamic
 * boundary.
 */
export default function PolotnoEditor({
  onSave,
  initialSceneJson,
  initialName,
  ownerAgentId,
}: PolotnoEditorProps) {
  // Side-panel sections with the stock Unsplash Photos section replaced by the
  // owner's own media. Stable for the editor's lifetime (owner doesn't change).
  const sections = useMemo(
    () => buildEditorSections(ownerAgentId),
    [ownerAgentId],
  );
  // One store per mounted editor. Created lazily so the (expensive) mobx-state
  // tree is only built when the user actually opens the editor.
  const store = useMemo(() => {
    const created = createStore({ key: POLOTNO_KEY, showCredit: false });
    if (initialSceneJson) {
      try {
        created.loadJSON(JSON.parse(initialSceneJson));
      } catch (error) {
        console.error("[PolotnoEditor] failed to load initial scene:", error);
        created.addPage();
      }
    } else {
      created.addPage();
      created.setSize(DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT, true);
    }
    return created;
    // Store identity must be stable for the editor's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [name, setName] = useState(initialName ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    setError(null);
    setIsSaving(true);
    try {
      // Export the rendered canvas to a PNG data URL + serializable scene.
      const dataUrl = await store.toDataURL({
        pixelRatio: EXPORT_PIXEL_RATIO,
        mimeType: "image/png",
      });
      const sceneJson = JSON.stringify(store.toJSON());
      await onSave({
        name: name.trim(),
        dataUrl,
        sceneJson,
        width: store.width,
        height: store.height,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save the design.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  }, [name, onSave, store]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 border-b p-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Design name"
          className="max-w-xs"
          aria-label="Design name"
        />
        <Button onClick={handleSave} disabled={isSaving} className="ml-auto">
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              Save Design
            </>
          )}
        </Button>
      </div>

      {error && (
        <div className="border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <PolotnoContainer style={{ width: "100%", height: "100%" }}>
          <SidePanelWrap>
            <SidePanel store={store} sections={sections} defaultSection="photos" />
          </SidePanelWrap>
          <WorkspaceWrap>
            <Toolbar store={store} />
            <Workspace store={store} />
            <ZoomButtons store={store} />
          </WorkspaceWrap>
        </PolotnoContainer>
      </div>
    </div>
  );
}
