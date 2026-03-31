"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { JoinQuestion } from "@/lib/types";

type JoinQuestionEditorProps = {
  value: JoinQuestion[];
  onChange: (questions: JoinQuestion[]) => void;
};

const QUESTION_TYPES: Array<JoinQuestion["type"]> = [
  "text",
  "textarea",
  "multipleChoice",
  "radio",
  "checkbox",
];

function createEmptyQuestion(): JoinQuestion {
  return {
    id: crypto.randomUUID(),
    question: "",
    label: "",
    required: false,
    type: "text",
    options: [],
  };
}

export function JoinQuestionEditor({ value, onChange }: JoinQuestionEditorProps) {
  const updateQuestion = (questionId: string, updater: (question: JoinQuestion) => JoinQuestion) => {
    onChange(value.map((question) => (question.id === questionId ? updater(question) : question)));
  };

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label>Application Questions</Label>
          <p className="text-sm text-muted-foreground">
            Ask applicants for extra context before admins approve membership.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, createEmptyQuestion()])}>
          <Plus className="mr-2 h-4 w-4" />
          Add Question
        </Button>
      </div>

      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">No application questions yet.</p>
      ) : (
        <div className="space-y-4">
          {value.map((question, index) => {
            const supportsOptions = question.type === "multipleChoice" || question.type === "radio";
            const optionsText = Array.isArray(question.options)
              ? question.options
                  .map((option) => (typeof option === "string" ? option : option.label))
                  .join(", ")
              : "";

            return (
              <div key={question.id} className="space-y-3 rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">Question {index + 1}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onChange(value.filter((entry) => entry.id !== question.id))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label>Prompt</Label>
                  <Textarea
                    value={question.question}
                    onChange={(event) =>
                      updateQuestion(question.id, (entry) => ({ ...entry, question: event.target.value }))
                    }
                    rows={2}
                    placeholder="Why do you want to join?"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Short Label (optional)</Label>
                  <Input
                    value={question.label ?? ""}
                    onChange={(event) =>
                      updateQuestion(question.id, (entry) => ({ ...entry, label: event.target.value }))
                    }
                    placeholder="Why join?"
                  />
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Question Type</Label>
                    <Select
                      value={question.type}
                      onValueChange={(nextType) =>
                        updateQuestion(question.id, (entry) => ({
                          ...entry,
                          type: nextType as JoinQuestion["type"],
                          options:
                            nextType === "multipleChoice" || nextType === "radio"
                              ? entry.options ?? []
                              : [],
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {QUESTION_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between rounded-md border px-3 py-2">
                    <div>
                      <Label>Required</Label>
                      <p className="text-xs text-muted-foreground">Applicants must answer this question.</p>
                    </div>
                    <Switch
                      checked={question.required}
                      onCheckedChange={(checked) =>
                        updateQuestion(question.id, (entry) => ({ ...entry, required: checked }))
                      }
                    />
                  </div>
                </div>

                {supportsOptions ? (
                  <div className="space-y-2">
                    <Label>Options</Label>
                    <Input
                      value={optionsText}
                      onChange={(event) =>
                        updateQuestion(question.id, (entry) => ({
                          ...entry,
                          options: event.target.value
                            .split(",")
                            .map((option) => option.trim())
                            .filter(Boolean),
                        }))
                      }
                      placeholder="Option one, Option two, Option three"
                    />
                    <p className="text-xs text-muted-foreground">Separate options with commas.</p>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
