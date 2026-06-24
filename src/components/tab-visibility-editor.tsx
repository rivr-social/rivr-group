"use client";

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  GROUP_TAB_KEYS,
  GROUP_CONFIG_TAB_KEYS,
  GROUP_TAB_LABELS,
  CONFIG_TAB_LOCKED_VISIBILITY,
  isConfigTab,
  type AnyGroupTabKey,
  type GroupTabKey,
  type TabVisibilityLevel,
  type TabVisibilitySettings,
} from "@/lib/types";

type TabVisibilityEditorProps = {
  value: TabVisibilitySettings;
  onChange: (settings: TabVisibilitySettings) => void;
  groupType: string;
};

const VISIBILITY_OPTIONS: Array<{ value: TabVisibilityLevel; label: string; description: string }> = [
  { value: "public", label: "Public", description: "Visible to everyone" },
  { value: "members", label: "Members", description: "Visible to group members only" },
  { value: "admin", label: "Admin", description: "Visible to admins only" },
  { value: "hidden", label: "Hidden", description: "Tab is completely hidden" },
];

// Page tabs available to every group, plus org-only page tabs.
const BASIC_PAGE_TABS: GroupTabKey[] = ["about", "feed", "events", "groups", "members", "documents"];
const ORG_ONLY_PAGE_TABS: GroupTabKey[] = GROUP_TAB_KEYS.filter(
  (key) => !BASIC_PAGE_TABS.includes(key),
);

export function TabVisibilityEditor({ value, onChange, groupType }: TabVisibilityEditorProps) {
  const isOrg = groupType === "organization" || groupType === "org";

  // Derive the full set of rows from the canonical registry. Page tabs are
  // gated by group type; config tabs are always shown but locked at admin.
  const pageTabs: GroupTabKey[] = isOrg ? [...GROUP_TAB_KEYS] : BASIC_PAGE_TABS;
  const availableTabs: AnyGroupTabKey[] = [...pageTabs, ...GROUP_CONFIG_TAB_KEYS];

  const onTabChange = (tab: AnyGroupTabKey, level: TabVisibilityLevel) => {
    // Config tabs are locked and must never be mutated from the editor.
    if (isConfigTab(tab)) return;
    const next = { ...value };
    if (level === "public") {
      delete next[tab];
    } else {
      next[tab] = level;
    }
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {availableTabs.map((tab) => {
        const locked = isConfigTab(tab);
        const current: TabVisibilityLevel = locked
          ? CONFIG_TAB_LOCKED_VISIBILITY
          : (value[tab] ?? "public");
        const isOrgOnly = !locked && ORG_ONLY_PAGE_TABS.includes(tab as GroupTabKey);
        return (
          <div key={tab} className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="min-w-0">
              <Label className="font-medium">{GROUP_TAB_LABELS[tab]}</Label>
              {isOrgOnly && (
                <span className="ml-2 text-xs text-muted-foreground">(Organization)</span>
              )}
              {locked && (
                <span className="ml-2 text-xs text-muted-foreground">(Admin only — locked)</span>
              )}
            </div>
            <Select
              value={current}
              onValueChange={(v) => onTabChange(tab, v as TabVisibilityLevel)}
              disabled={locked}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VISIBILITY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </div>
  );
}
