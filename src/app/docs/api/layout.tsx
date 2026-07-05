/**
 * API tab layout — adds the developer-reference sidebar.
 *
 * On this sovereign group build the sidebar is STATIC (overview / auth /
 * federation) — the machine-generated per-registry MCP + per-group REST
 * reference that global ships is not generated here, so there is no
 * `_generated/*` manifest to assemble from. See docs/api/page.tsx.
 */
import { DocsSidebar } from "../_components/docs-nav";
import { API_SECTIONS } from "../_content/nav";

export default function ApiLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-8 md:flex-row md:gap-10">
      <DocsSidebar sections={API_SECTIONS} ariaLabel="API reference navigation" />
      <article className="min-w-0 flex-1">{children}</article>
    </div>
  );
}
