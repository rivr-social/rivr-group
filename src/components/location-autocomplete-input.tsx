"use client";

/**
 * Autocomplete text input for selecting geographic locations from API-backed suggestions.
 * Used in: forms and search flows that capture a place name with optional coordinates metadata.
 * Key props: controlled `value`, `onValueChange`, optional `onSelectSuggestion`, and `minQueryLength`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type LocationSuggestion = {
  id: string;
  label: string;
  name?: string;
  locality?: string;
  adminRegion?: string;
  countryCode?: string;
  lat?: number;
  lon?: number;
  source?: string;
};

type LocationAutocompleteInputProps = {
  id?: string;
  name?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  inputClassName?: string;
  minQueryLength?: number;
  onValueChange: (value: string) => void;
  onSelectSuggestion?: (suggestion: LocationSuggestion) => void;
};

/**
 * Renders a controlled input with keyboard-accessible location suggestions.
 * @param {LocationAutocompleteInputProps} props Input configuration, controlled value handlers, and selection callbacks.
 */
export function LocationAutocompleteInput({
  id,
  name,
  value,
  placeholder,
  disabled,
  required,
  className,
  inputClassName,
  minQueryLength = 2,
  onValueChange,
  onSelectSuggestion,
}: LocationAutocompleteInputProps) {
  // UI state for dropdown visibility, async request status, result list, and keyboard selection.
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  // Mutable refs prevent stale async updates and allow deferred blur-close cleanup.
  const requestSeqRef = useRef(0);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Normalize whitespace so fetch logic and visibility checks use trimmed query text.
  const trimmed = useMemo(() => value.trim(), [value]);

  useEffect(() => {
    // Guard: do not fetch suggestions until query reaches minimum length.
    if (trimmed.length < minQueryLength) {
      setSuggestions([]);
      setIsLoading(false);
      return;
    }

    // Sequence number ensures only latest request response updates component state.
    const seq = ++requestSeqRef.current;
    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams({
          q: trimmed,
          limit: "8",
        });
        // Side effect: fetch location suggestions from API route for current input.
        const response = await fetch(`/api/locations/suggest?${params.toString()}`, {
          method: "GET",
          cache: "no-store",
        });

        if (!response.ok) {
          if (seq === requestSeqRef.current) {
            setSuggestions([]);
          }
          return;
        }

        const data = (await response.json()) as { suggestions?: LocationSuggestion[] };
        if (seq === requestSeqRef.current) {
          setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
          setActiveIndex(-1);
        }
      } catch {
        if (seq === requestSeqRef.current) {
          setSuggestions([]);
        }
      } finally {
        if (seq === requestSeqRef.current) {
          setIsLoading(false);
        }
      }
    }, 200);

    // Cleanup cancels pending debounce timer when query changes or component unmounts.
    return () => clearTimeout(timer);
  }, [trimmed, minQueryLength]);

  useEffect(() => {
    return () => {
      // Cleanup delayed blur-close timer to avoid updating unmounted component.
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const selectSuggestion = (suggestion: LocationSuggestion) => {
    // Event handler: commit suggestion into controlled input and notify parent callback.
    onValueChange(suggestion.label);
    onSelectSuggestion?.(suggestion);
    setIsOpen(false);
    setActiveIndex(-1);
  };

  return (
    <div className={cn("relative", className)}>
      <Input
        id={id}
        name={name}
        className={inputClassName}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        autoComplete="off"
        onFocus={() => setIsOpen(true)}
        onBlur={() => {
          // Delay close so click/mousedown on dropdown items can complete first.
          closeTimerRef.current = setTimeout(() => setIsOpen(false), 120);
        }}
        onChange={(e) => {
          // Event handler: propagate controlled value change and open suggestion list.
          onValueChange(e.target.value);
          setIsOpen(true);
        }}
        onKeyDown={(e) => {
          // Keyboard navigation and selection for the open suggestion list.
          if (!isOpen || suggestions.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((prev) => (prev + 1) % suggestions.length);
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
            return;
          }
          if (e.key === "Enter" && activeIndex >= 0 && activeIndex < suggestions.length) {
            e.preventDefault();
            selectSuggestion(suggestions[activeIndex]);
            return;
          }
          if (e.key === "Escape") {
            setIsOpen(false);
          }
        }}
      />

      {isOpen && trimmed.length >= minQueryLength ? (
        // Conditional rendering: only show popover once query is long enough and input is active.
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-popover shadow-lg">
          {isLoading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">Searching locations...</div>
          ) : suggestions.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">No matching locations</div>
          ) : (
            suggestions.map((suggestion, idx) => (
              <button
                key={suggestion.id}
                type="button"
                className={cn(
                  "w-full px-3 py-2 text-left hover:bg-muted",
                  idx === activeIndex ? "bg-muted" : ""
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectSuggestion(suggestion);
                }}
              >
                <div className="text-sm font-medium">{suggestion.name || suggestion.label}</div>
                <div className="text-xs text-muted-foreground">{suggestion.label}</div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
