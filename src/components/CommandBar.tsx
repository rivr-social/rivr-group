"use client";

/**
 * CommandBar component for entering and executing natural-language commands.
 * Used in command-driven interaction surfaces where users can submit quick actions
 * (for example, wallet/payment command entry in the main app experience).
 * Key props:
 * - `onCommand`: optional callback fired after a successful command execution.
 * - `placeholder`: input placeholder text shown when empty.
 * - `className`: optional wrapper class overrides.
 */

import { useState, useRef, useEffect, FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { executeCommand } from "@/app/actions/commands";

interface CommandBarProps {
  onCommand?: (command: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * Renders a command input that triggers a server action on submit.
 *
 * @param props - Component props.
 * @param props.onCommand - Optional callback invoked after a successful command execution.
 * @param props.placeholder - Optional placeholder text for the command input.
 * @param props.className - Optional classes for the outer form element.
 */
export function CommandBar({
  onCommand,
  placeholder = "Type a command (e.g., 'pay alice 50')...",
  className = "",
}: CommandBarProps) {
  // Local controlled-input state for the command text.
  const [input, setInput] = useState("");
  // Tracks in-flight submission to prevent duplicate requests and toggle loading UI.
  const [isProcessing, setIsProcessing] = useState(false);
  // Ref used to programmatically focus/blur the input from keyboard shortcuts.
  const inputRef = useRef<HTMLInputElement>(null);

  // Global keyboard shortcuts side effect:
  // - "/" focuses the input when not already typing in a form field.
  // - "Escape" blurs and clears the current input value.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "/" && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") {
        inputRef.current?.blur();
        setInput("");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    // Prevent default form navigation and handle submission in-place.
    e.preventDefault();

    // Guard against empty/whitespace commands and concurrent submissions.
    if (!input.trim() || isProcessing) return;

    const command = input.trim();
    setIsProcessing(true);

    try {
      // Server action call that executes the parsed command and returns success/message metadata.
      const result = await executeCommand(command);

      if (result.success) {
        // On success, emit optional callback and clear the input for the next command.
        onCommand?.(command);
        setInput("");
      } else {
        // Preserve input on failure so users can adjust/resubmit.
        console.error("✗", result.message);
      }
    } catch (error) {
      // Network/runtime failure path for command execution side effect.
      console.error("✗ Failed to execute command:", error);
    } finally {
      // Always release processing lock so input/UI can recover.
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className={`w-full ${className}`}>
      <div className="relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
          <span className="text-sm font-mono">$</span>
        </div>
        <Input
          ref={inputRef}
          type="text"
          value={input}
          // Controlled-input update handler.
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          disabled={isProcessing}
          className="pl-8 pr-24 h-12 text-base bg-background/80 backdrop-blur-md border-primary/20 shadow-lg focus-visible:ring-primary/50 focus-visible:border-primary/50 transition-all"
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
          {/* Conditional status UI: spinner while submitting, keyboard hint when idle. */}
          {isProcessing ? (
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
          ) : (
            <span className="text-xs text-muted-foreground font-mono">
              Press <kbd className="px-1 py-0.5 bg-muted rounded">Enter</kbd>
            </span>
          )}
        </div>
      </div>
      <div className="mt-2 text-xs text-muted-foreground text-center">
        Press <kbd className="px-1 py-0.5 bg-muted rounded">/</kbd> to focus • <kbd className="px-1 py-0.5 bg-muted rounded">Esc</kbd> to cancel
      </div>
    </form>
  );
}
