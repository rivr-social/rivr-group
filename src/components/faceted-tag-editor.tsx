"use client";

/**
 * Inline nested-tag editor — the Parachute-style chip editor used inside the
 * docs vault module. Each faceted tag-path renders as a removable chip
 * (`work/projects/rivr` with an × button); an add-input accepts slash paths
 * (`a/b/c`) committed on Enter, comma, or the Add button, with autocomplete
 * drawn from the tags already present in the vault tree.
 *
 * All input is run through {@link normalizeFacetedTags}, so a tag typed here as
 * `Work/Projects` folds to the SAME lower-cased, deduped facet a Parachute
 * vault import produces — the tag tree never splits into case variants and the
 * mapping round-trips straight from a vault.
 */

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FACET_PATH_SEPARATOR, normalizeFacetedTags } from "@/lib/parachute-doc";

interface FacetedTagEditorProps {
  /** Current faceted tag-paths (normalized `string[][]`). */
  value: string[][];
  /** Materialized tag-paths already in the vault, offered as add autocomplete. */
  suggestions?: string[];
  /** Disable editing (the viewer lacks edit rights on this doc). */
  disabled?: boolean;
  /** Called with the next normalized tag-path set whenever it changes. */
  onChange: (next: string[][]) => void;
  /** Unique id so multiple editors on one page do not share a datalist. */
  datalistId?: string;
}

export function FacetedTagEditor({
  value,
  suggestions = [],
  disabled = false,
  onChange,
  datalistId = "faceted-tag-suggestions",
}: FacetedTagEditorProps): React.ReactElement {
  const [draft, setDraft] = useState("");

  const materialized = useMemo(
    () => value.map((path) => path.join(FACET_PATH_SEPARATOR)),
    [value],
  );

  const openSuggestions = useMemo(() => {
    const have = new Set(materialized);
    return [...new Set(suggestions)]
      .filter((path) => path.length > 0 && !have.has(path))
      .sort((a, b) => a.localeCompare(b));
  }, [suggestions, materialized]);

  const commitDraft = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onChange(normalizeFacetedTags([...materialized, trimmed]));
    setDraft("");
  };

  const removePath = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {value.length === 0 ? (
          <span className="text-[10px] text-muted-foreground">No tags yet.</span>
        ) : (
          value.map((path, idx) => {
            const label = path.join(FACET_PATH_SEPARATOR);
            return (
              <Badge key={label} variant="secondary" className="gap-1 text-[10px]">
                {label}
                {!disabled ? (
                  <button
                    type="button"
                    aria-label={`Remove ${label}`}
                    className="ml-0.5 rounded-sm hover:text-destructive"
                    onClick={() => removePath(idx)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </Badge>
            );
          })
        )}
      </div>
      {!disabled ? (
        <div className="flex items-center gap-1.5">
          <Input
            value={draft}
            list={datalistId}
            placeholder="work/projects/rivr"
            className="h-8 text-xs"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                commitDraft();
              }
            }}
          />
          <datalist id={datalistId}>
            {openSuggestions.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0 gap-1 text-xs"
            onClick={commitDraft}
            disabled={!draft.trim()}
          >
            <Plus className="h-3 w-3" />
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}
