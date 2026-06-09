"use client";

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GROUP_TAB_KEYS, type GroupTabKey, type TabVisibilityLevel, type TabVisibilitySettings } from "@/lib/types";

type TabVisibilityEditorProps = {
  value: TabVisibilitySettings;
  onChange: (settings: TabVisibilitySettings) => void;
  groupType: string;
};

const TAB_LABELS: Record<GroupTabKey, string> = {
  about: "About",
  feed: "Feed",
  events: "Events",
  groups: "Groups",
  members: "Members",
  documents: "Documents",
  jobs: "Jobs",
  marketplace: "Marketplace",
  governance: "Governance",
  badges: "Badges",
  stake: "Stake",
  press: "Press",
  treasury: "Treasury",
};

const VISIBILITY_OPTIONS: Array<{ value: TabVisibilityLevel; label: string; description: string }> = [
  { value: "public", label: "Public", description: "Visible to everyone" },
  { value: "members", label: "Members", description: "Visible to group members only" },
  { value: "admin", label: "Admin", description: "Visible to admins only" },
  { value: "hidden", label: "Hidden", description: "Tab is completely hidden" },
];

const BASIC_TABS: GroupTabKey[] = ["about", "feed", "events", "groups", "members", "documents"];
const ORG_ONLY_TABS: GroupTabKey[] = ["jobs", "marketplace", "governance", "badges", "stake", "press", "treasury"];

export function TabVisibilityEditor({ value, onChange, groupType }: TabVisibilityEditorProps) {
  const isOrg = groupType === "organization" || groupType === "org";
  const availableTabs = isOrg ? GROUP_TAB_KEYS : BASIC_TABS;

  const onTabChange = (tab: GroupTabKey, level: TabVisibilityLevel) => {
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
        const current = value[tab] ?? "public";
        return (
          <div key={tab} className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="min-w-0">
              <Label className="font-medium">{TAB_LABELS[tab]}</Label>
              {ORG_ONLY_TABS.includes(tab) && (
                <span className="ml-2 text-xs text-muted-foreground">(Organization)</span>
              )}
            </div>
            <Select
              value={current}
              onValueChange={(v) => onTabChange(tab, v as TabVisibilityLevel)}
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
