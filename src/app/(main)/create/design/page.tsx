/**
 * Design editor page (server component).
 *
 * Route: `/create/design`
 *
 * Hosts the lazily-loaded Polotno canvas editor full-bleed. The heavy editor SDK
 * is code-split via `DesignEditorLazy` (a `dynamic({ ssr: false })` boundary), so
 * this route adds nothing meaningful to the shared bundle until the editor chunk
 * is fetched on the client.
 *
 * Authentication:
 * - Unauthenticated visitors are redirected to the login page; saving a design
 *   requires a server-derived identity.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { DesignEditorLazy } from "@/components/design/design-editor-lazy";

export const metadata: Metadata = {
  title: "Design Studio",
  description: "Create graphics, social cards, and flyers on a canvas.",
};

const LOGIN_PATH = "/auth/login";

export default async function DesignStudioPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(LOGIN_PATH);
  }

  return (
    <div className="h-[calc(100vh-4rem)] w-full">
      <DesignEditorLazy />
    </div>
  );
}
