// app/(main)/layout.tsx
"use client";

import type React from "react";
import { useState } from "react";
import { BottomNav } from "@/components/bottom-nav";
import { CommandBar } from "@/components/CommandBar";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [commandBarVisible, setCommandBarVisible] = useState(false);

  return (
    <div className="min-h-screen pb-16">
      {children}
      <div className="fixed bottom-16 left-0 right-0 z-40 flex justify-center pointer-events-none">
        <div className="w-full max-w-xl px-4 pointer-events-auto">
          {commandBarVisible ? (
            <CommandBar
              onCommand={() => setCommandBarVisible(false)}
              placeholder="Type a command (e.g., 'pay alice 50')..."
            />
          ) : (
            <button
              onClick={() => setCommandBarVisible(true)}
              className="mx-auto flex items-center gap-1.5 rounded-full bg-muted/80 backdrop-blur-md border border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shadow-sm"
              aria-label="Open command bar"
            >
              <span className="font-mono">/</span>
              <span>Command</span>
            </button>
          )}
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
