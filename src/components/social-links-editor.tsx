"use client";

/**
 * Reusable social-links editor used by both the user settings form and the
 * group edit modal so the two entity types share one editing affordance.
 *
 * State model: the editor owns a controlled `Record<platform, value>` map via
 * `value` / `onChange`. It enforces the canonical platform list and the
 * per-entity max from `@/lib/social-links`. Final validation/normalization is
 * always performed SERVER-SIDE in the relevant action — this editor only
 * provides client-side affordances and input typing.
 */

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SOCIAL_PLATFORMS,
  MAX_SOCIAL_LINKS,
  getSocialPlatform,
} from "@/lib/social-links";

export interface SocialLinksEditorProps {
  /** Controlled platform→value map. */
  value: Record<string, string>;
  /** Called with the next full map on any change. */
  onChange: (next: Record<string, string>) => void;
}

/** Returns the HTML input type appropriate for a platform key. */
function inputTypeForPlatform(platform: string): string {
  const descriptor = getSocialPlatform(platform);
  if (!descriptor) return "text";
  if (descriptor.kind === "tel") return "tel";
  if (descriptor.kind === "email") return "email";
  return "url";
}

/** Returns a helpful placeholder for a platform key. */
function placeholderForPlatform(platform: string): string {
  const descriptor = getSocialPlatform(platform);
  if (!descriptor) return "";
  if (descriptor.kind === "tel") return "(555) 123-4567";
  if (descriptor.kind === "email") return "you@example.com";
  return "https://...";
}

export function SocialLinksEditor({ value, onChange }: SocialLinksEditorProps) {
  const entries = Object.entries(value);
  const usedPlatforms = Object.keys(value);
  const atMax = entries.length >= MAX_SOCIAL_LINKS;

  const renamePlatform = (oldKey: string, newKey: string) => {
    if (oldKey === newKey || Object.prototype.hasOwnProperty.call(value, newKey)) return;
    const next = Object.fromEntries(
      Object.entries(value).map(([k, v]) => (k === oldKey ? [newKey, v] : [k, v]))
    );
    onChange(next);
  };

  const setValue = (key: string, nextValue: string) => {
    onChange({ ...value, [key]: nextValue });
  };

  const removePlatform = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };

  const addPlatform = () => {
    const nextPlatform = SOCIAL_PLATFORMS.find((opt) => !usedPlatforms.includes(opt.key));
    if (nextPlatform) {
      onChange({ ...value, [nextPlatform.key]: "" });
    }
  };

  return (
    <div className="space-y-2">
      {entries.map(([platform, linkValue]) => {
        const otherUsed = usedPlatforms.filter((k) => k !== platform);
        return (
          <div key={platform} className="flex items-center gap-2">
            <Select value={platform} onValueChange={(newPlatform) => renamePlatform(platform, newPlatform)}>
              <SelectTrigger className="w-36 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOCIAL_PLATFORMS.filter((opt) => !otherUsed.includes(opt.key)).map((opt) => (
                  <SelectItem key={opt.key} value={opt.key}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type={inputTypeForPlatform(platform)}
              placeholder={placeholderForPlatform(platform)}
              value={linkValue}
              onChange={(e) => setValue(platform, e.target.value)}
            />
            <button
              type="button"
              className="p-2 text-muted-foreground hover:text-destructive"
              onClick={() => removePlatform(platform)}
              aria-label={`Remove ${platform} link`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" disabled={atMax} onClick={addPlatform}>
        <Plus className="mr-2 h-4 w-4" />
        Add social link
      </Button>
    </div>
  );
}
