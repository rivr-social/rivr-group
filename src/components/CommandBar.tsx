"use client";

/**
 * CommandBar component for entering and executing natural-language commands.
 * Used in command-driven interaction surfaces where users can submit quick actions
 * (for example, wallet/payment command entry in the main app experience).
 *
 * Supports two execution paths:
 * 1. Fast path: regex-matched "pay X Y" commands via `executeCommand` server action.
 * 2. NLP fallback: if the fast path fails, parses input with `parseNaturalLanguageV2`
 *    and presents an `EntityScaffoldPreview` for review before persisting.
 *
 * Key props:
 * - `onCommand`: optional callback fired after a successful command execution.
 * - `placeholder`: input placeholder text shown when empty.
 */

import { useState, useRef, useEffect, useCallback, type ComponentType } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Calendar,
  CirclePlus,
  Compass,
  FileText,
  Home,
  Map as MapIcon,
  MessageSquare,
  Bell,
  Scale,
  Settings,
  ShoppingBag,
  Trophy,
  User,
  Users,
} from "lucide-react";
import { executeCommand } from "@/app/actions/commands";
import { parseNaturalLanguageV2 } from "@/lib/nlp-parser-v2";
import { getGlobalUrl } from "@/lib/federation/global-url";
import type { V2ParseResult, ExistingEntityRecord } from "@/lib/nlp-parser-v2";
import { EntityScaffoldPreview } from "@/components/entity-scaffold-preview";
import {
  createEntitiesFromScaffold,
  type CreateEntitiesPayload,
} from "@/app/actions/create-entities";
import { findExistingEntitiesByNames } from "@/app/actions/find-entities";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useToast } from "@/components/ui/use-toast";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum input length before NLP v2 parsing is attempted */
const NLP_MIN_INPUT_LENGTH = 5;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CommandBarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommand?: (command: string) => void;
  placeholder?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CommandDefinition {
  id: string;
  label: string;
  description: string;
  path: string;
  group: string;
  icon: ComponentType<{ className?: string }>;
  external?: boolean;
  aliases?: string[];
}

const COMMANDS: CommandDefinition[] = [
  // ---- Navigate ----
  {
    id: "home",
    label: "Home",
    description: "Go to the group home feed.",
    path: "/",
    group: "Navigate",
    icon: Home,
    aliases: ["home", "/home", "feed"],
  },
  {
    id: "profile",
    label: "Group Profile",
    description: "Open the group profile page.",
    path: "/profile",
    group: "Navigate",
    icon: User,
    aliases: ["profile", "group profile", "/profile"],
  },
  {
    id: "members",
    label: "Members",
    description: "View and manage group members.",
    path: "/members",
    group: "Navigate",
    icon: Users,
    aliases: ["members", "people", "membership", "/members"],
  },
  {
    id: "docs",
    label: "Docs",
    description: "Open group documents and files.",
    path: "/docs",
    group: "Navigate",
    icon: FileText,
    aliases: ["docs", "documents", "files", "/docs"],
  },
  {
    id: "governance",
    label: "Governance",
    description: "Open group governance and decision-making.",
    path: "/governance",
    group: "Navigate",
    icon: Scale,
    aliases: ["governance", "decisions", "voting", "proposals", "/governance"],
  },
  {
    id: "messages",
    label: "Messages",
    description: "Open group message inbox.",
    path: "/messages",
    group: "Navigate",
    icon: MessageSquare,
    aliases: ["messages", "chat", "inbox", "/messages"],
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Open group notifications feed.",
    path: "/notifications",
    group: "Navigate",
    icon: Bell,
    aliases: ["notifications", "alerts", "/notifications"],
  },
  {
    id: "calendar",
    label: "Calendar",
    description: "View the group event calendar.",
    path: "/calendar",
    group: "Navigate",
    icon: Calendar,
    aliases: ["calendar", "events calendar", "/calendar"],
  },
  {
    id: "settings",
    label: "Settings",
    description: "Open group settings and configuration.",
    path: "/settings",
    group: "Navigate",
    icon: Settings,
    aliases: ["settings", "preferences", "config", "/settings"],
  },
  {
    id: "badges",
    label: "Badges",
    description: "Browse group badges and achievements.",
    path: "/badges",
    group: "Navigate",
    icon: Trophy,
    aliases: ["badges", "certificates", "/badges"],
  },
  {
    id: "marketplace",
    label: "Marketplace",
    description: "Open marketplace listings and purchases.",
    path: "/marketplace",
    group: "Navigate",
    icon: ShoppingBag,
    aliases: ["marketplace", "shop", "listings", "/marketplace"],
  },
  {
    id: "map",
    label: "Map",
    description: "Open the global map experience.",
    path: getGlobalUrl("/map"),
    group: "Navigate",
    icon: MapIcon,
    external: true,
    aliases: ["map", "open map", "/map"],
  },
  // ---- Create ----
  {
    id: "create-post",
    label: "Create Post",
    description: "Start a new group post.",
    path: "/create?tab=post",
    group: "Create",
    icon: CirclePlus,
    aliases: ["create post", "new post", "/create post"],
  },
  {
    id: "create-event",
    label: "Create Event",
    description: "Start a new group event.",
    path: "/create?tab=event",
    group: "Create",
    icon: CirclePlus,
    aliases: ["create event", "new event", "/create event"],
  },
  {
    id: "create-doc",
    label: "Create Document",
    description: "Start a new group document.",
    path: "/create?tab=doc",
    group: "Create",
    icon: CirclePlus,
    aliases: ["create doc", "new doc", "create document", "new document", "/create doc"],
  },
  {
    id: "create-proposal",
    label: "Create Proposal",
    description: "Start a new governance proposal.",
    path: "/create?tab=proposal",
    group: "Create",
    icon: CirclePlus,
    aliases: ["create proposal", "new proposal", "/create proposal"],
  },
  {
    id: "create-project",
    label: "Create Project",
    description: "Start a new group project.",
    path: "/create?tab=project",
    group: "Create",
    icon: CirclePlus,
    aliases: ["create project", "new project", "/create project"],
  },
  // ---- Explore ----
  {
    id: "events",
    label: "Events",
    description: "Browse all group events.",
    path: "/events",
    group: "Explore",
    icon: Compass,
    aliases: ["events", "browse events", "/events"],
  },
];

const COMMAND_GROUP_ORDER = ["Create", "Navigate", "Explore"] as const;
type GroupedCommands = { group: string; commands: CommandDefinition[] };

const QUICK_COMMANDS = new Map<string, CommandDefinition>();
for (const command of COMMANDS) {
  QUICK_COMMANDS.set(command.id.toLowerCase(), command);
  QUICK_COMMANDS.set(command.label.toLowerCase(), command);
  for (const alias of command.aliases ?? []) {
    QUICK_COMMANDS.set(alias.toLowerCase(), command);
  }
}

export function CommandBar({
  open,
  onOpenChange,
  onCommand,
  placeholder = "Type a command (e.g., 'pay alice 50' or 'create a proposal')...",
}: CommandBarProps) {
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Local controlled-input state for the command text.
  const [input, setInput] = useState("");
  // Tracks in-flight submission to prevent duplicate requests and toggle loading UI.
  const [isProcessing, setIsProcessing] = useState(false);
  // NLP v2 parse result displayed in the scaffold preview sheet.
  const [parseResult, setParseResult] = useState<V2ParseResult | null>(null);
  // Controls whether the scaffold preview sheet is open.
  const [showScaffold, setShowScaffold] = useState(false);
  // Tracks in-flight entity creation from the scaffold preview.
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Ref used to programmatically focus/blur the input from keyboard shortcuts.
  const inputRef = useRef<HTMLInputElement>(null);

  // Global keyboard shortcuts side effect:
  // - "/" focuses the input when not already typing in a form field.
  // - "Cmd+K" / "Ctrl+K" toggles the command dialog.
  // - "Escape" blurs and clears the current input value (unless scaffold is open).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditableTarget =
        !!target &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          target.isContentEditable);

      if (e.key === "/" && !isEditableTarget && !open) {
        e.preventDefault();
        onOpenChange(true);
      }
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) && !isEditableTarget) {
        e.preventDefault();
        onOpenChange(!open);
      }
      if (e.key === "Escape" && !showScaffold) {
        setInput("");
        onOpenChange(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open, showScaffold]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // ---- NLP v2 fallback: parse and show scaffold ----

  const attemptNLPParse = useCallback(
    async (text: string) => {
      if (text.length < NLP_MIN_INPUT_LENGTH) {
        toast({
          title: "Input too short",
          description: `Please enter at least ${NLP_MIN_INPUT_LENGTH} characters for entity parsing.`,
          variant: "destructive",
        });
        return;
      }

      // First pass: local-only parse for fast feedback.
      let result = parseNaturalLanguageV2(text);

      // Enhancement pass: look up potential existing entities from DB.
      try {
        const potentialNames: string[] = [];
        if (result.intent?.existingReferences) {
          result.intent.existingReferences.forEach((ref) => {
            potentialNames.push(ref.name);
          });
        }

        if (potentialNames.length > 0) {
          // Runtime values from findExistingEntitiesByNames conform to ExistingEntityRecord
          // but the server action return type is loosely typed as Record<string, unknown>.
          const rawEntities = await findExistingEntitiesByNames(potentialNames);
          const existingEntities = rawEntities as unknown as Map<string, ExistingEntityRecord>;
          if (existingEntities.size > 0) {
            result = parseNaturalLanguageV2(text, existingEntities);
          }
        }
      } catch (dbError) {
        // DB lookup failed; fall back to client-only parse result.
        console.warn("Entity lookup failed, using client-only parse:", dbError);
      }

      setParseResult(result);

      if (result.success && result.entities.length > 0) {
        setShowScaffold(true);
      } else {
        toast({
          title: "Could not parse input",
          description:
            result.warnings[0] ||
            "Try being more specific about what you want to create.",
          variant: "destructive",
        });
      }
    },
    [toast]
  );

  // ---- Submit handler: fast path then NLP fallback ----

  const runCommand = useCallback(async () => {
    // Guard against empty/whitespace commands and concurrent submissions.
    if (!input.trim() || isProcessing) return;

    const command = input.trim();

    // Quick command check — navigation shortcuts resolved before server round-trip.
    const normalizedCommand = command.toLowerCase();
    const quickMatch = QUICK_COMMANDS.get(normalizedCommand);
    if (quickMatch) {
      if (quickMatch.external) {
        window.location.href = quickMatch.path;
      } else {
        router.push(quickMatch.path);
      }
      onCommand?.(command);
      setInput("");
      onOpenChange(false);
      return;
    }

    setIsProcessing(true);

    try {
      // Fast path: server action for regex-matched "pay X Y" commands.
      const result = await executeCommand(command);

      if (result.success) {
        // On success, emit optional callback and clear the input for the next command.
        onCommand?.(command);
        setInput("");
        onOpenChange(false);
      } else {
        // Fast path did not match or failed; attempt NLP v2 entity extraction.
        await attemptNLPParse(command);
      }
    } catch (error) {
      // Network/runtime failure path for command execution side effect.
      console.error("Failed to execute command:", error);
      toast({
        title: "Command failed",
        description: "An unexpected error occurred. Please try again.",
        variant: "destructive",
      });
    } finally {
      // Always release processing lock so input/UI can recover.
      setIsProcessing(false);
    }
  }, [attemptNLPParse, input, isProcessing, onCommand, onOpenChange, router, toast]);

  // ---- Scaffold confirm: persist entities ----

  const handleScaffoldConfirm = useCallback(
    async (payload: CreateEntitiesPayload) => {
      setIsSubmitting(true);
      try {
        const result = await createEntitiesFromScaffold(payload);

        if (result.success) {
          toast({
            title: "Entities created",
            description: result.message,
          });
          // Clean up: close scaffold, clear parse state, clear input.
          setShowScaffold(false);
          setParseResult(null);
          setInput("");
          onCommand?.(payload.originalInput);
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
        setIsSubmitting(false);
      }
    },
    [toast, onCommand]
  );

  // ---- Scaffold cancel: close preview and restore input ----

  const handleScaffoldCancel = useCallback(() => {
    setShowScaffold(false);
    setParseResult(null);
    inputRef.current?.focus();
  }, []);

  const openCommand = useCallback(
    (command: CommandDefinition) => {
      if (command.external) {
        window.location.href = command.path;
      } else {
        router.push(command.path);
      }
      onCommand?.(command.label);
      setInput("");
      onOpenChange(false);
    },
    [onCommand, onOpenChange, router],
  );

  const contextualCommands = useCallback((): CommandDefinition[] => {
    const commands: CommandDefinition[] = [];

    if (/^\/events\/[^/]+$/.test(pathname)) {
      commands.push(
        {
          id: "event-edit",
          label: "Edit This Event",
          description: "Open the editor for the current event.",
          path: `${pathname}/edit`,
          group: "Current Page",
          icon: Calendar,
          aliases: ["edit event", "current event edit"],
        },
        {
          id: "event-tickets",
          label: "Event Tickets",
          description: "Open tickets for the current event.",
          path: `${pathname}/tickets`,
          group: "Current Page",
          icon: Calendar,
          aliases: ["event tickets", "tickets"],
        },
        {
          id: "event-financials",
          label: "Event Financials",
          description: "Open financials for the current event.",
          path: `${pathname}/financials`,
          group: "Current Page",
          icon: ShoppingBag,
          aliases: ["event financials", "financials"],
        },
      );
    }

    if (/^\/docs\/[^/]+$/.test(pathname)) {
      commands.push(
        {
          id: "doc-edit",
          label: "Edit This Document",
          description: "Open the editor for the current document.",
          path: `${pathname}/edit`,
          group: "Current Page",
          icon: FileText,
          aliases: ["edit doc", "edit document"],
        },
      );
    }

    if (/^\/governance\/[^/]+$/.test(pathname)) {
      commands.push(
        {
          id: "proposal-vote",
          label: "Vote on Proposal",
          description: "Cast your vote on the current proposal.",
          path: `${pathname}/vote`,
          group: "Current Page",
          icon: Scale,
          aliases: ["vote", "cast vote"],
        },
      );
    }

    if (pathname === "/profile") {
      commands.push(
        {
          id: "wallet-transactions",
          label: "Wallet Transactions",
          description: "Open wallet transaction history.",
          path: "/profile?tab=wallet&walletTab=transactions",
          group: "Current Page",
          icon: ShoppingBag,
          aliases: ["transactions", "wallet transactions"],
        },
        {
          id: "wallet-purchases",
          label: "Wallet Purchases",
          description: "Open wallet purchases.",
          path: "/profile?tab=wallet&walletTab=purchases",
          group: "Current Page",
          icon: ShoppingBag,
          aliases: ["purchases", "wallet purchases"],
        },
        {
          id: "wallet-sales",
          label: "Wallet Sales",
          description: "Open wallet sales and payouts.",
          path: "/profile?tab=wallet&walletTab=sales",
          group: "Current Page",
          icon: ShoppingBag,
          aliases: ["sales", "wallet sales", "payouts"],
        },
      );
    }

    if (/^\/marketplace\/[^/]+$/.test(pathname)) {
      commands.push({
        id: "marketplace-purchase",
        label: "Purchase This Listing",
        description: "Open purchase flow for the current listing.",
        path: `${pathname}/purchase`,
        group: "Current Page",
        icon: ShoppingBag,
        aliases: ["buy this", "purchase listing", "checkout"],
      });
    }

    const currentTab = searchParams.get("tab");
    if (pathname === "/profile" && currentTab && currentTab !== "about") {
      commands.push({
        id: "profile-about",
        label: "Profile About",
        description: "Return to the group profile overview.",
        path: "/profile?tab=about",
        group: "Current Page",
        icon: User,
        aliases: ["about", "profile about"],
      });
    }

    return commands;
  }, [pathname, searchParams]);

  const allCommands = [...contextualCommands(), ...COMMANDS];
  const filteredCommandsByGroup: GroupedCommands[] = [];
  const currentPageCommands = allCommands.filter((command) => command.group === "Current Page");
  if (currentPageCommands.length > 0) {
    filteredCommandsByGroup.push({ group: "Current Page", commands: currentPageCommands });
  }
  for (const group of COMMAND_GROUP_ORDER) {
    const commands = allCommands.filter((command) => command.group === group);
    if (commands.length > 0) {
      filteredCommandsByGroup.push({ group, commands });
    }
  }

  // ---- Render ----

  return (
    <>
      <CommandDialog open={open} onOpenChange={onOpenChange}>
        <CommandInput
          ref={inputRef}
          value={input}
          onValueChange={setInput}
          placeholder={placeholder}
        />
        <CommandList>
          <CommandEmpty>No matching command. Press Enter on "Run" to execute freeform.</CommandEmpty>

          {input.trim().length > 0 ? (
            <>
              <CommandGroup heading="Run">
                <CommandItem
                  value={`run ${input}`}
                  onSelect={() => {
                    void runCommand();
                  }}
                  disabled={isProcessing}
                >
                  <span className="mr-2 font-mono text-xs text-muted-foreground">$</span>
                  <div className="flex flex-col">
                    <span>Run "{input.trim()}"</span>
                    <span className="text-xs text-muted-foreground">
                      Execute as a natural-language command.
                    </span>
                  </div>
                  <CommandShortcut>{isProcessing ? "..." : "Enter"}</CommandShortcut>
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
            </>
          ) : null}

          {filteredCommandsByGroup.map(({ group, commands }) => (
            <CommandGroup key={group} heading={group}>
              {commands.map((command) => {
                const Icon = command.icon;
                return (
                  <CommandItem
                    key={command.id}
                    value={[command.label, ...(command.aliases ?? []), command.description].join(" ")}
                    onSelect={() => openCommand(command)}
                  >
                    <Icon className="mr-2 h-4 w-4" />
                    <div className="flex flex-col">
                      <span>{command.label}</span>
                      <span className="text-xs text-muted-foreground">{command.description}</span>
                    </div>
                    <CommandShortcut>
                      {command.external ? "Open" : command.path}
                    </CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>

      {/* NLP v2 scaffold preview sheet */}
      <Sheet open={showScaffold} onOpenChange={(isOpen) => {
        if (!isOpen) {
          handleScaffoldCancel();
        }
      }}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Review Extracted Entities</SheetTitle>
            <SheetDescription>
              We parsed your input into the following entities and relationships.
              Review, edit, and confirm to create them.
            </SheetDescription>
          </SheetHeader>
          {parseResult && parseResult.success && (
            <div className="mt-4">
              <EntityScaffoldPreview
                entities={parseResult.entities}
                relationships={parseResult.relationships}
                conditionals={parseResult.conditionals}
                originalInput={parseResult.input}
                warnings={parseResult.warnings}
                onConfirm={handleScaffoldConfirm}
                onCancel={handleScaffoldCancel}
                isSubmitting={isSubmitting}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
