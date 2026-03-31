"use client";

/**
 * NLP input entry point for entity creation.
 *
 * Purpose: captures freeform user intent, parses it into entity scaffolding,
 * and hands off to a confirmation UI before persistence.
 * Used in: the entity creation flow where users create structured records
 * from natural language input.
 * Key props:
 * - `onEntitiesCreated`: receives created entity IDs after successful save.
 * - `localeId`: optional locale/chapter context attached during persistence.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkles, Loader2, RotateCcw } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { parseNaturalLanguageV2 } from "@/lib/nlp-parser-v2";
import type { V2ParseResult } from "@/lib/nlp-parser-v2";
import { EntityScaffoldPreview } from "@/components/entity-scaffold-preview";
import {
  createEntitiesFromScaffold,
  type CreateEntitiesPayload,
} from "@/app/actions/create-entities";
import { findExistingEntitiesByNames } from "@/app/actions/find-entities";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLACEHOLDER_EXAMPLES = [
  "Create a community garden project in Oakland for next Saturday",
  "Organize a volunteer meetup at the community center tomorrow",
  "Start a neighborhood cleanup project in Portland",
  "Plan a workshop hosted by the sustainability collective next Friday",
  "Set up a farmers market event at Pioneer Square",
];

const INPUT_MIN_LENGTH = 5;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface NLPInputProps {
  /** Callback fired after entities are successfully created */
  onEntitiesCreated?: (
    createdIds: { tempId: string; dbId: string; name: string; type: string }[]
  ) => void;
  /** The currently selected locale ID — attached to created entities */
  localeId?: string;
}

/**
 * Renders the natural-language entry UI and orchestrates parse/confirm flow.
 *
 * @param props - Component props.
 * @param props.onEntitiesCreated - Optional callback invoked after successful creation.
 * @param props.localeId - Optional locale context forwarded to create action.
 * @returns NLP parsing input UI with scaffold preview/confirmation.
 */
export function NLPInput({ onEntitiesCreated, localeId }: NLPInputProps) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  // Local UI and workflow state for parse/create lifecycle.
  const [inputText, setInputText] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [parseResult, setParseResult] = useState<V2ParseResult | null>(null);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);

  // Side effect: choose a random placeholder example once at mount.
  useEffect(() => {
    setPlaceholderIndex(Math.floor(Math.random() * PLACEHOLDER_EXAMPLES.length));
  }, []);

  // ---- Parse input ----

  const handleParse = useCallback(async () => {
    const trimmed = inputText.trim();
    // Guard clause: require enough signal before parsing.
    if (trimmed.length < INPUT_MIN_LENGTH) {
      toast({
        title: "Input too short",
        description: `Please enter at least ${INPUT_MIN_LENGTH} characters describing what you want to create.`,
        variant: "destructive",
      });
      return;
    }

    setIsParsing(true);

    try {
      // First pass is local-only parsing for fast feedback without network calls.
      const quickParse = parseNaturalLanguageV2(trimmed);

      // Optional enhancement: fetch potential existing entities from server and
      // re-parse with that context to improve linking accuracy.
      let result = quickParse;
      try {
        const potentialNames: string[] = [];
        if (quickParse.intent?.existingReferences) {
          quickParse.intent.existingReferences.forEach((ref: { name: string; type: string; isExisting?: boolean }) => {
            potentialNames.push(ref.name);
          });
        }

        const existingEntities = potentialNames.length > 0
          // Server action call: reads matching entities by name from persistence.
          ? await findExistingEntitiesByNames(potentialNames)
          : new Map();

        // Re-parse with existing entities for better results
        if (existingEntities.size > 0) {
          result = parseNaturalLanguageV2(trimmed, existingEntities);
        }
      } catch (dbError) {
        // DB lookup failed — fall back to client-only parse result
        console.warn("Entity lookup failed, using client-only parse:", dbError);
      }

      setParseResult(result);

      // Side effect: toast warning when parse does not produce a successful scaffold.
      if (!result.success) {
        toast({
          title: "Could not parse input",
          description:
            result.warnings[0] ||
            "Try being more specific about what you want to create.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Parse error:", error);
      // Still set a failed result so the reset button appears
      setParseResult({
        success: false,
        input: trimmed,
        entities: [],
        relationships: [],
        conditionals: [],
        warnings: ["An error occurred while parsing your input."],
        intent: null,
      } as V2ParseResult);
      toast({
        title: "Parse error",
        description: "An error occurred while parsing your input.",
        variant: "destructive",
      });
    } finally {
      // Always clear parse loading state, regardless of success/failure.
      setIsParsing(false);
    }
  }, [inputText, toast]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Keyboard shortcut: Enter triggers parse without submitting a parent form.
      if (e.key === "Enter") {
        e.preventDefault();
        handleParse();
      }
    },
    [handleParse]
  );

  // ---- Confirm & create ----

  const handleConfirm = useCallback(
    async (payload: CreateEntitiesPayload) => {
      setIsSubmitting(true);
      try {
        const payloadWithLocale = { ...payload, localeId };
        // Server action call: persists confirmed scaffold entities/relationships.
        const result = await createEntitiesFromScaffold(payloadWithLocale);

        if (result.success) {
          toast({
            title: "Entities created",
            description: result.message,
          });
          // Reset state
          setParseResult(null);
          setInputText("");
          // Notify parent so it can reconcile local lists/state with created IDs.
          onEntitiesCreated?.(result.createdIds);
        } else {
          toast({
            title: "Creation failed",
            description: result.message,
            variant: "destructive",
          });
        }
      } catch (error) {
        toast({
          title: "Error",
          description:
            error instanceof Error
              ? error.message
              : "An unexpected error occurred",
          variant: "destructive",
        });
      } finally {
        // Always release submit lock to re-enable actions.
        setIsSubmitting(false);
      }
    },
    [toast, onEntitiesCreated, localeId]
  );

  // ---- Cancel / reset ----

  const handleCancel = useCallback(() => {
    setParseResult(null);
  }, []);

  const handleReset = useCallback(() => {
    // Full reset clears parse output and input, then restores input focus.
    setParseResult(null);
    setInputText("");
    inputRef.current?.focus();
  }, []);

  // ---- Render ----

  return (
    <div className="space-y-4">
      {/* Input card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="h-5 w-5 text-primary" />
            Natural Language Input
          </CardTitle>
          <CardDescription>
            Describe what you want to create in plain language. The system will
            extract entities, properties, and relationships for you to review.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              type="text"
              data-testid="nlp-input"
              placeholder={PLACEHOLDER_EXAMPLES[placeholderIndex]}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isParsing || isSubmitting}
              className="flex-1"
            />
            {/* Conditional action: show Reset after parse result exists; otherwise Parse. */}
            {parseResult ? (
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={isSubmitting}
              >
                <RotateCcw className="h-4 w-4 mr-1" />
                Reset
              </Button>
            ) : (
              <Button
                onClick={handleParse}
                disabled={
                  isParsing || inputText.trim().length < INPUT_MIN_LENGTH
                }
              >
                {isParsing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    Parsing...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-1" />
                    Parse
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Conditional rendering: only show preview when parsing succeeded. */}
      {parseResult && parseResult.success && (
        <EntityScaffoldPreview
          entities={parseResult.entities}
          relationships={parseResult.relationships}
          conditionals={parseResult.conditionals}
          originalInput={parseResult.input}
          warnings={parseResult.warnings}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
          isSubmitting={isSubmitting}
        />
      )}
    </div>
  );
}
