// app/(main)/layout.tsx
"use client";

import type React from "react";
import { useState } from "react";
import { Slash } from "lucide-react";
import { BottomNav } from "@/components/bottom-nav";
import { CommandBar } from "@/components/CommandBar";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [commandBarOpen, setCommandBarOpen] = useState(false);

  return (
    <div className="relative min-h-screen pb-16">
      {children}
      <div className="fixed bottom-20 left-0 right-0 z-40 flex justify-center pointer-events-none">
        <button
          onClick={() => setCommandBarOpen(true)}
          className="liquid-glass pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/25 bg-transparent text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Open command palette"
        >
          <div className="liquid-glass-effect rounded-full" />
          <div className="liquid-glass-tint rounded-full" />
          <div className="liquid-glass-shine rounded-full" />
          <Slash className="h-4 w-4" />
        </button>
      </div>
      <CommandBar
        open={commandBarOpen}
        onOpenChange={setCommandBarOpen}
      />
      <BottomNav />
    </div>
  );
}
