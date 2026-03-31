"use client";

/**
 * Entity scaffold review and confirmation panel.
 *
 * Purpose: presents parsed entities/relationships/grammar details, supports
 * in-place edits, and emits a normalized payload for creation.
 * Used in: the natural-language entity creation flow after parsing succeeds.
 * Key props:
 * - `entities` / `relationships` / `conditionals`: parser output to review.
 * - `onConfirm`: callback that receives the finalized create payload.
 * - `onCancel`: exits review and returns to input editing.
 * - `isSubmitting`: disables actions while parent create request is pending.
 */

import { useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users,
  Calendar,
  MapPin,
  Briefcase,
  Building2,
  User,
  ArrowRight,
  Check,
  X,
  Pencil,
  AlertTriangle,
  Link2,
} from "lucide-react";
import type {
  ExtractedRelationship,
  EntityType,
  ExtractedProperty,
} from "@/lib/nlp-parser";
import {
  ENTITY_TYPES,
  ENTITY_TYPE_LABELS,
  RELATIONSHIP_TYPE_LABELS,
} from "@/lib/nlp-parser";
import type { V2ExtractedEntity, V2Conditional } from "@/lib/nlp-parser-v2";
import type {
  ConfirmedEntity,
  ConfirmedRelationship,
  CreateEntitiesPayload,
} from "@/app/actions/create-entities";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENTITY_TYPE_OPTIONS: { value: EntityType; label: string }[] = [
  { value: ENTITY_TYPES.PROJECT, label: "Project" },
  { value: ENTITY_TYPES.EVENT, label: "Event" },
  { value: ENTITY_TYPES.PLACE, label: "Place" },
  { value: ENTITY_TYPES.PERSON, label: "Person" },
  { value: ENTITY_TYPES.ORGANIZATION, label: "Organization" },
];

const ENTITY_ICONS: Record<EntityType, typeof Briefcase> = {
  [ENTITY_TYPES.PROJECT]: Briefcase,
  [ENTITY_TYPES.EVENT]: Calendar,
  [ENTITY_TYPES.PLACE]: MapPin,
  [ENTITY_TYPES.PERSON]: User,
  [ENTITY_TYPES.ORGANIZATION]: Building2,
};

const ENTITY_COLORS: Record<EntityType, string> = {
  [ENTITY_TYPES.PROJECT]: "bg-blue-100 text-blue-800 border-blue-200",
  [ENTITY_TYPES.EVENT]: "bg-purple-100 text-purple-800 border-purple-200",
  [ENTITY_TYPES.PLACE]: "bg-green-100 text-green-800 border-green-200",
  [ENTITY_TYPES.PERSON]: "bg-amber-100 text-amber-800 border-amber-200",
  [ENTITY_TYPES.ORGANIZATION]: "bg-rose-100 text-rose-800 border-rose-200",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EntityScaffoldPreviewProps {
  entities: V2ExtractedEntity[];
  relationships: ExtractedRelationship[];
  conditionals: V2Conditional[];
  originalInput: string;
  warnings: string[];
  onConfirm: (payload: CreateEntitiesPayload) => void;
  onCancel: () => void;
  isSubmitting?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders editable extracted entities and builds a confirmation payload.
 *
 * @param props - Component props.
 * @param props.entities - Initial extracted entities from parser output.
 * @param props.relationships - Initial extracted relationships using entity indices.
 * @param props.conditionals - Parsed determiners/predicates for grammar visibility.
 * @param props.originalInput - Raw user input that produced this scaffold.
 * @param props.warnings - Parse-time warnings to display to user.
 * @param props.onConfirm - Callback invoked with finalized payload for persistence.
 * @param props.onCancel - Callback invoked to return to previous step.
 * @param props.isSubmitting - Whether parent submit is in progress.
 * @returns Entity review UI with edit controls and confirm/cancel actions.
 */
export function EntityScaffoldPreview({
  entities: initialEntities,
  relationships: initialRelationships,
  conditionals,
  originalInput,
  warnings,
  onConfirm,
  onCancel,
  isSubmitting = false,
}: EntityScaffoldPreviewProps) {
  // Editable local copy of entities so user changes do not mutate parent parse result.
  const [entities, setEntities] = useState<V2ExtractedEntity[]>(initialEntities);
  // Tracks which entity card is currently in edit mode.
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);

  // ---- Entity editing ----

  const updateEntityName = useCallback((tempId: string, name: string) => {
    // Keep entity `name` and its mirrored `name` property in sync.
    setEntities((prev) =>
      prev.map((e) => {
        if (e.tempId !== tempId) return e;
        const updatedProps = e.properties.map((p) =>
          p.key === "name" ? { ...p, value: name } : p
        );
        return { ...e, name, properties: updatedProps };
      })
    );
  }, []);

  const updateEntityType = useCallback(
    (tempId: string, type: EntityType) => {
      // User can correct parser-assigned type before confirming.
      setEntities((prev) =>
        prev.map((e) => (e.tempId === tempId ? { ...e, type } : e))
      );
    },
    []
  );

  const updateEntityProperty = useCallback(
    (tempId: string, key: string, value: string) => {
      // Upsert property values: overwrite existing keys or append user-edit values.
      setEntities((prev) =>
        prev.map((e) => {
          if (e.tempId !== tempId) return e;
          const exists = e.properties.some((p) => p.key === key);
          const updatedProps = exists
            ? e.properties.map((p) =>
                p.key === key ? { ...p, value } : p
              )
            : [
                ...e.properties,
                { key, value, source: "user-edit" } as ExtractedProperty,
              ];
          return { ...e, properties: updatedProps };
        })
      );
    },
    []
  );

  const removeEntity = useCallback((tempId: string) => {
    // Removing an entity also causes dependent relationship rows to be filtered out later.
    setEntities((prev) => prev.filter((e) => e.tempId !== tempId));
  }, []);

  // ---- Confirmation ----

  const handleConfirm = useCallback(() => {
    // Normalize current editable entities into the server action payload shape.
    const confirmedEntities: ConfirmedEntity[] = entities.map((e) => ({
      tempId: e.tempId,
      type: e.type,
      name: e.name,
      properties: e.properties,
      ...(e.targetTable && { targetTable: e.targetTable }),
      ...(e.isExisting && { isExisting: true }),
      ...(e.existingId && { existingId: e.existingId }),
    }));

    // Rebuild relationship references via temp IDs and drop any relationships
    // whose entities were removed during review.
    const confirmedRelationships: ConfirmedRelationship[] =
      initialRelationships
        .filter((r) => {
          const from = initialEntities[r.fromEntityIndex];
          const to = initialEntities[r.toEntityIndex];
          return (
            from &&
            to &&
            entities.some((e) => e.tempId === from.tempId) &&
            entities.some((e) => e.tempId === to.tempId)
          );
        })
        .map((r) => ({
          type: r.type,
          fromTempId: initialEntities[r.fromEntityIndex].tempId,
          toTempId: initialEntities[r.toEntityIndex].tempId,
        }));

    // Side effect: emits finalized payload to parent, which performs persistence.
    onConfirm({
      entities: confirmedEntities,
      relationships: confirmedRelationships,
      originalInput,
    });
  }, [entities, initialEntities, initialRelationships, originalInput, onConfirm]);

  // ---- Helpers ----

  const getPropertyValue = (entity: V2ExtractedEntity, key: string): string => {
    return entity.properties.find((p) => p.key === key)?.value ?? "";
  };

  // Conditional rendering: empty-state guidance when all entities were removed or missing.
  if (entities.length === 0) {
    return (
      <Card className="border-amber-200 bg-amber-50">
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-amber-800">
            <AlertTriangle className="h-5 w-5" />
            <p>No entities could be extracted from the input.</p>
          </div>
          <p className="mt-2 text-sm text-amber-700">
            Try being more specific. For example: &quot;Create a community
            garden project in Oakland for next Saturday&quot;
          </p>
          <Button variant="outline" className="mt-4" onClick={onCancel}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Review Entities</CardTitle>
          <CardDescription>
            The following entities were extracted from your input. Review and
            edit before creating.
          </CardDescription>
        </CardHeader>
        {/* Conditional rendering: show parser warnings only when present. */}
        {warnings.length > 0 && (
          <CardContent className="pt-0 pb-3">
            {warnings.map((warning, i) => (
              <div
                key={i}
                className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 p-2 rounded mb-1"
              >
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{warning}</span>
              </div>
            ))}
          </CardContent>
        )}
      </Card>

      {/* Entities */}
      {entities.map((entity) => {
        const Icon = ENTITY_ICONS[entity.type];
        const isEditing = editingEntityId === entity.tempId;
        const colorClass = ENTITY_COLORS[entity.type];
        const isExisting = entity.isExisting === true;

        return (
          <Card
            key={entity.tempId}
            className={`border-l-4 ${isExisting ? "border-emerald-400 bg-emerald-50/30" : colorClass.split(" ").filter((c) => c.startsWith("border-"))[0] || "border-blue-200"}`}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className={`p-1.5 rounded ${isExisting ? "bg-emerald-100 text-emerald-700" : colorClass.split(" ").slice(0, 2).join(" ")}`}
                  >
                    {isExisting ? <Link2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </div>
                  <Badge
                    variant="outline"
                    className={colorClass}
                  >
                    {ENTITY_TYPE_LABELS[entity.type]}
                    {entity.originalKeyword && (
                      <span className="ml-1 opacity-70">
                        &middot; {entity.originalKeyword.charAt(0).toUpperCase() + entity.originalKeyword.slice(1)}
                      </span>
                    )}
                  </Badge>
                  {isExisting && (
                    <Badge variant="outline" className="bg-emerald-100 text-emerald-700 border-emerald-300">
                      Existing
                    </Badge>
                  )}
                  {!isExisting && entity.confidence < 0.7 && (
                    <Badge variant="outline" className="text-amber-600 border-amber-300">
                      Low confidence
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {!isExisting && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setEditingEntityId(isEditing ? null : entity.tempId)
                      }
                      aria-label={isEditing ? "Stop editing entity" : "Edit entity"}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeEntity(entity.tempId)}
                    aria-label="Remove entity"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-3">
              {isExisting ? (
                /* Existing entity display - simplified, no edit form */
                <div className="space-y-1">
                  <h3 className="font-semibold text-base flex items-center gap-2">
                    {entity.name}
                    <span className="text-xs font-normal text-emerald-600">
                      Will be linked
                    </span>
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    This entity already exists in the database and will be linked to the new entities.
                  </p>
                </div>
              ) : isEditing ? (
                /* Edit mode */
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Name</Label>
                      <Input
                        value={entity.name}
                        onChange={(e) =>
                          updateEntityName(entity.tempId, e.target.value)
                        }
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Type</Label>
                      <Select
                        value={entity.type}
                        onValueChange={(v) =>
                          updateEntityType(entity.tempId, v as EntityType)
                        }
                      >
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ENTITY_TYPE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Location</Label>
                    <Input
                      value={getPropertyValue(entity, "location")}
                      onChange={(e) =>
                        updateEntityProperty(
                          entity.tempId,
                          "location",
                          e.target.value
                        )
                      }
                      placeholder="Enter location"
                      className="h-8 text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Date</Label>
                    <Input
                      type="date"
                      value={getPropertyValue(entity, "date")}
                      onChange={(e) =>
                        updateEntityProperty(
                          entity.tempId,
                          "date",
                          e.target.value
                        )
                      }
                      className="h-8 text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Schedule</Label>
                    <Input
                      value={getPropertyValue(entity, "schedule")}
                      onChange={(e) =>
                        updateEntityProperty(
                          entity.tempId,
                          "schedule",
                          e.target.value
                        )
                      }
                      placeholder="e.g., Saturdays, weekly"
                      className="h-8 text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Description</Label>
                    <Input
                      value={getPropertyValue(entity, "description")}
                      onChange={(e) =>
                        updateEntityProperty(
                          entity.tempId,
                          "description",
                          e.target.value
                        )
                      }
                      placeholder="Enter description"
                      className="h-8 text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Purpose</Label>
                    <Input
                      value={getPropertyValue(entity, "purpose")}
                      onChange={(e) =>
                        updateEntityProperty(
                          entity.tempId,
                          "purpose",
                          e.target.value
                        )
                      }
                      placeholder="What is this for?"
                      className="h-8 text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Topic</Label>
                    <Input
                      value={getPropertyValue(entity, "topic")}
                      onChange={(e) =>
                        updateEntityProperty(
                          entity.tempId,
                          "topic",
                          e.target.value
                        )
                      }
                      placeholder="What is this about?"
                      className="h-8 text-sm"
                    />
                  </div>

                  {getPropertyValue(entity, "value") && (
                    <div className="space-y-1">
                      <Label className="text-xs">Value</Label>
                      <Input
                        value={getPropertyValue(entity, "value")}
                        onChange={(e) =>
                          updateEntityProperty(
                            entity.tempId,
                            "value",
                            e.target.value
                          )
                        }
                        className="h-8 text-sm"
                      />
                    </div>
                  )}
                </div>
              ) : (
                /* Display mode */
                <div className="space-y-1">
                  <h3 className="font-semibold text-base">{entity.name}</h3>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    {getPropertyValue(entity, "location") && (
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {getPropertyValue(entity, "location")}
                      </span>
                    )}
                    {getPropertyValue(entity, "date") && (
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {getPropertyValue(entity, "date")}
                      </span>
                    )}
                    {getPropertyValue(entity, "schedule") && (
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {getPropertyValue(entity, "schedule")}
                      </span>
                    )}
                  </div>
                  {getPropertyValue(entity, "purpose") && (
                    <span className="flex items-center gap-1">
                      <Briefcase className="h-3 w-3" />
                      {getPropertyValue(entity, "purpose")}
                    </span>
                  )}
                  {getPropertyValue(entity, "topic") && (
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {getPropertyValue(entity, "topic")}
                    </span>
                  )}
                  {getPropertyValue(entity, "value") && (
                    <span className="flex items-center gap-1 font-medium">
                      {getPropertyValue(entity, "value")}
                    </span>
                  )}
                  {getPropertyValue(entity, "description") && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {getPropertyValue(entity, "description")}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {/* Relationships */}
      {/* Conditional rendering: relationship summary appears only if parser found links. */}
      {initialRelationships.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Relationships
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {initialRelationships.map((rel, i) => {
                const fromInitial = initialEntities[rel.fromEntityIndex];
                const toInitial = initialEntities[rel.toEntityIndex];
                if (!fromInitial || !toInitial) return null;
                // Look up current (possibly edited) entity names.
                const fromEntity = entities.find((e) => e.tempId === fromInitial.tempId);
                const toEntity = entities.find((e) => e.tempId === toInitial.tempId);
                // Skip if either entity was removed.
                if (!fromEntity || !toEntity) return null;

                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-sm p-2 rounded bg-muted/50"
                  >
                    <Badge variant="outline" className="text-xs">
                      {fromEntity.name}
                    </Badge>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground text-xs">
                      {RELATIONSHIP_TYPE_LABELS[rel.type]}
                    </span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <Badge variant="outline" className="text-xs">
                      {toEntity.name}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Conditionals / Determiners */}
      {/* Conditional rendering: grammar metadata is informational and optional. */}
      {conditionals.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Grammar Analysis
            </CardTitle>
            <CardDescription className="text-xs">
              Determiners and predicates detected in your input
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {conditionals.map((cond, i) => (
                <div
                  key={i}
                  className="inline-flex items-center gap-1.5 text-xs border rounded-full px-2.5 py-1 bg-muted/50"
                >
                  <span className="font-medium text-primary">
                    {cond.determiner}
                  </span>
                  <span className="text-muted-foreground">
                    {cond.predicate}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        {/* Confirm stays disabled during submit or if there are no entities left to process. */}
        <Button onClick={handleConfirm} disabled={isSubmitting || entities.length === 0}>
          {isSubmitting ? (
            "Creating..."
          ) : (
            <>
              <Check className="h-4 w-4 mr-1" />
              {(() => {
                const newCount = entities.filter((e) => !e.isExisting).length;
                const existingCount = entities.filter((e) => e.isExisting).length;
                const parts: string[] = [];
                if (newCount > 0) {
                  parts.push(`Create ${newCount} Entit${newCount !== 1 ? "ies" : "y"}`);
                }
                if (existingCount > 0) {
                  parts.push(`Link ${existingCount} Existing`);
                }
                return parts.join(", ");
              })()}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
