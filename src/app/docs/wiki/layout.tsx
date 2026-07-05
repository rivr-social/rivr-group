/**
 * Wiki tab layout — adds the surface-navigation sidebar (WIKI_SECTIONS).
 */
import { DocsSidebar } from "../_components/docs-nav";
import { WIKI_SECTIONS } from "../_content/nav";

export default function WikiLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-8 md:flex-row md:gap-10">
      <DocsSidebar sections={WIKI_SECTIONS} ariaLabel="Wiki navigation" />
      <article className="min-w-0 flex-1">{children}</article>
    </div>
  );
}
