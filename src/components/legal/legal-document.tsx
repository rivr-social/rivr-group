/**
 * Presentational renderer for a legal document (Terms of Service / Privacy
 * Policy). Server component — pure rendering of structured content.
 *
 * @module components/legal/legal-document
 */
import type { LegalDocumentContent } from "@/lib/legal/content";

/** Converts a section heading into a stable anchor id (e.g. "1. Eligibility" → "eligibility"). */
function sectionAnchor(heading: string): string {
  return heading
    .replace(/^\d+\.\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Renders a full legal document with title, effective date, intro, and sections.
 */
export function LegalDocument({ content }: { content: LegalDocumentContent }) {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">{content.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Effective date: {content.effectiveDate}
        </p>
      </header>

      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        {content.intro.map((paragraph, index) => (
          <p key={`intro-${index}`}>{paragraph}</p>
        ))}
      </div>

      <div className="mt-10 space-y-10">
        {content.sections.map((section) => {
          const anchor = sectionAnchor(section.heading);
          return (
            <section key={anchor} id={anchor} className="scroll-mt-24">
              <h2 className="text-lg font-semibold text-foreground">{section.heading}</h2>
              <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
                {section.body?.map((paragraph, index) => (
                  <p key={`${anchor}-p-${index}`}>{paragraph}</p>
                ))}
                {section.bullets && section.bullets.length > 0 && (
                  <ul className="list-disc space-y-1 pl-6">
                    {section.bullets.map((bullet, index) => (
                      <li key={`${anchor}-b-${index}`}>{bullet}</li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </article>
  );
}
