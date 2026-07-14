// app/(main)/layout.tsx
import type React from "react";

/**
 * Main route-group layout.
 *
 * The persistent nav chrome (bottom nav + command palette) that used to live
 * here was hoisted to the ROOT layout as `<AppChrome />` (C18, 2026-07-14) so it
 * covers every page — including sovereign surfaces outside this group like
 * `/groups/[id]`, `/jobs/[id]`, `/events`. This layout now only owns the
 * route-group's page container spacing.
 */
export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="relative min-h-screen pb-16">{children}</div>;
}
