"use client";

/**
 * GroupAssistantConfigCard — the admin-facing configuration surface for a
 * sovereign group's AI assistant.
 *
 * This is the group-app analogue of the person app's AssistantSettingsPanel,
 * trimmed to what the group assistant backend actually exposes:
 *   - which model the assistant runs (selectedModel),
 *   - an operator-authored persona/"soul" prompt (customSoulMd),
 *   - the KG scope ids the assistant may draw context from (includedKgScopeIds),
 *   - and whether the assistant is exposed to non-admin visitors
 *     (publicChatEnabled).
 *
 * It loads via `fetchGroupAssistantConfig` and persists via
 * `updateGroupAssistantConfig` — both admin-gated server actions that target
 * the group's resolved direct agent, so the settings always attach to whichever
 * agent actually runs the assistant (a persona or the group agent itself).
 *
 * This card is only ever rendered inside `/groups/[id]/settings`, which
 * redirects non-admins before mount, so it inherits that admin gate.
 */

import { useCallback, useEffect, useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import {
  fetchGroupAssistantConfig,
  getAssistantScopeOptionsAction,
  updateGroupAssistantConfig,
  type AssistantConfigFetchResult,
  type AssistantScopeOption,
  type AssistantScopeOptionsResult,
} from "@/app/actions/group-assistant-config";
import { ALLOWED_ASSISTANT_MODELS } from "@/app/actions/group-assistant-config-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Human-readable labels for the allowed model selectors. */
const MODEL_LABELS: Record<string, string> = {
  "anthropic/claude-sonnet-4-6": "Claude Sonnet 4.6 (recommended)",
  "anthropic/claude-opus-4-6": "Claude Opus 4.6 (most capable)",
  "openai/gpt-4o": "GPT-4o",
  "gemini/gemini-2.0-flash": "Gemini 2.0 Flash",
  "local/ollama": "Local (Ollama)",
};

/** Mirrors the server-side cap in `updateGroupAssistantConfig`. */
const MAX_SOUL_MD_LENGTH = 8000;

type AssistantConfig = NonNullable<AssistantConfigFetchResult["config"]>;

/**
 * Parse the KG-scope editor text: one id per line (or comma-separated),
 * trimmed, de-duplicated. Shared by the checkbox picker and the save path so
 * both always see the same id list.
 */
function parseScopeIds(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GroupAssistantConfigCard({ groupId }: { groupId: string }) {
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolved-agent facts (read-only in this UI).
  const [isPersona, setIsPersona] = useState(false);
  const [hasAutobotPersona, setHasAutobotPersona] = useState(false);

  // Editable settings.
  const [selectedModel, setSelectedModel] = useState<string>(
    ALLOWED_ASSISTANT_MODELS[0],
  );
  const [customSoulMd, setCustomSoulMd] = useState("");
  const [scopeIdsText, setScopeIdsText] = useState("");
  const [publicChatEnabled, setPublicChatEnabled] = useState(false);

  // Knowledge-source picker options (the group + its direct subgroups).
  // Non-fatal on failure — an empty list falls back to the advanced textarea.
  const [scopeOptions, setScopeOptions] = useState<AssistantScopeOption[]>([]);

  const applyConfig = useCallback((config: AssistantConfig) => {
    setIsPersona(config.isPersona);
    setHasAutobotPersona(config.hasAutobotPersona);
    setSelectedModel(config.selectedModel);
    setCustomSoulMd(config.customSoulMd);
    setScopeIdsText(config.includedKgScopeIds.join("\n"));
    setPublicChatEnabled(config.publicChatEnabled);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [result, optionsResult] = await Promise.all([
      fetchGroupAssistantConfig(groupId),
      getAssistantScopeOptionsAction(groupId).catch(
        (): AssistantScopeOptionsResult => ({ success: false }),
      ),
    ]);
    if (!result.success || !result.config) {
      setError(result.error ?? "Unable to load assistant configuration.");
      setLoading(false);
      return;
    }
    applyConfig(result.config);
    setScopeOptions(
      optionsResult.success && optionsResult.options
        ? optionsResult.options
        : [],
    );
    setLoading(false);
  }, [groupId, applyConfig]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Add/remove a picker id in the SAME `scopeIdsText` state the advanced
   * textarea and the save path read — ids the picker doesn't know about
   * round-trip untouched.
   */
  const toggleScopeId = useCallback((id: string, checked: boolean) => {
    setScopeIdsText((prev) => {
      const ids = parseScopeIds(prev);
      const next = checked
        ? ids.includes(id)
          ? ids
          : [...ids, id]
        : ids.filter((value) => value !== id);
      return next.join("\n");
    });
  }, []);

  const onSave = useCallback(async () => {
    if (customSoulMd.length > MAX_SOUL_MD_LENGTH) {
      toast({
        title: "Instructions too long",
        description: `Personality & tone instructions must be under ${MAX_SOUL_MD_LENGTH} characters.`,
        variant: "destructive",
      });
      return;
    }

    // Parse the KG-scope editor: one id per line, trimmed, de-duplicated.
    const includedKgScopeIds = parseScopeIds(scopeIdsText);

    setSaving(true);
    const result = await updateGroupAssistantConfig({
      groupId,
      selectedModel,
      customSoulMd: customSoulMd.trim(),
      includedKgScopeIds,
      publicChatEnabled,
    });
    setSaving(false);

    if (!result.success) {
      toast({
        title: "Could not save assistant settings",
        description: result.error,
        variant: "destructive",
      });
      return;
    }

    toast({ title: "Assistant settings saved" });
  }, [
    groupId,
    selectedModel,
    customSoulMd,
    scopeIdsText,
    publicChatEnabled,
    toast,
  ]);

  // Current scope-id list, derived from the same text the textarea edits, so
  // the picker checkboxes and the advanced editor never disagree.
  const selectedScopeIds = new Set(parseScopeIds(scopeIdsText));

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Assistant unavailable</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="rounded-full bg-primary/10 p-1.5">
              <Bot className="h-4 w-4 text-primary" />
            </div>
            <div>
              <CardTitle className="text-sm font-medium">
                Group AI assistant
              </CardTitle>
              <CardDescription>
                Configure the AI assistant that represents this group in chat.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-[10px]">
              {isPersona ? "Persona-backed" : "Runs as the group agent"}
            </Badge>
            {!hasAutobotPersona && (
              <Badge variant="outline" className="text-[10px]">
                No dedicated persona — using the group agent identity
              </Badge>
            )}
          </div>

          {/* Model selector */}
          <div className="grid gap-2">
            <Label htmlFor="assistant-model">Model</Label>
            <Select value={selectedModel} onValueChange={setSelectedModel}>
              <SelectTrigger id="assistant-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALLOWED_ASSISTANT_MODELS.map((model) => (
                  <SelectItem key={model} value={model}>
                    {MODEL_LABELS[model] ?? model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The model powering assistant replies. Anthropic models use this
              instance&apos;s Claude credential.
            </p>
          </div>

          {/* Operator soul prompt */}
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="assistant-soul">
                Assistant personality &amp; tone
              </Label>
              <span className="text-[10px] text-muted-foreground">
                {customSoulMd.length}/{MAX_SOUL_MD_LENGTH}
              </span>
            </div>
            <Textarea
              id="assistant-soul"
              value={customSoulMd}
              onChange={(event) => setCustomSoulMd(event.target.value)}
              maxLength={MAX_SOUL_MD_LENGTH}
              rows={6}
              placeholder="Describe how the assistant should sound — its personality, tone, and any group-specific guidance."
            />
            <p className="text-xs text-muted-foreground">
              How the assistant should sound and behave when it replies for
              this group. Leave blank to use the default personality.
            </p>
          </div>

          {/* KG scope ids */}
          <div className="grid gap-2">
            <Label>Knowledge sources</Label>
            {scopeOptions.length > 0 && (
              <div className="space-y-2 rounded-md border p-3">
                {scopeOptions.map((option) => (
                  <div key={option.id} className="flex items-center gap-3">
                    <Checkbox
                      id={`assistant-scope-${option.id}`}
                      checked={selectedScopeIds.has(option.id)}
                      onCheckedChange={(checked) =>
                        toggleScopeId(option.id, checked === true)
                      }
                    />
                    <Label
                      htmlFor={`assistant-scope-${option.id}`}
                      className="cursor-pointer text-sm font-normal"
                    >
                      {option.name}
                    </Label>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Pick which parts of the group the assistant may draw knowledge
              from. Usually leave everything unchecked — the group&apos;s own
              knowledge is included automatically.
            </p>
            <details className="grid gap-2">
              <summary className="cursor-pointer text-sm font-medium">
                Advanced: paste source IDs
              </summary>
              <div className="mt-2 grid gap-2">
                <Label htmlFor="assistant-kg-scopes">
                  Extra knowledge sources (advanced)
                </Label>
                <Textarea
                  id="assistant-kg-scopes"
                  value={scopeIdsText}
                  onChange={(event) => setScopeIdsText(event.target.value)}
                  rows={3}
                  placeholder="One source ID per line."
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  One source ID per line. Your operator can give you additional
                  source IDs that aren&apos;t in the picker above.
                </p>
              </div>
            </details>
          </div>
        </CardContent>
      </Card>

      {/* Public exposure */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Public chat</CardTitle>
          <CardDescription>
            When enabled, non-admin visitors can chat with the assistant. Their
            replies are rate-limited and scoped to public knowledge only — admin
            and member-only information is never surfaced to visitors.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              id="assistant-public"
              checked={publicChatEnabled}
              onCheckedChange={setPublicChatEnabled}
            />
            <Label htmlFor="assistant-public" className="cursor-pointer">
              Allow visitors to chat with the assistant
            </Label>
          </div>
        </CardContent>
      </Card>

      <Button type="button" onClick={() => void onSave()} disabled={saving}>
        {saving ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Saving...
          </>
        ) : (
          "Save Assistant Settings"
        )}
      </Button>
    </div>
  );
}

export default GroupAssistantConfigCard;
