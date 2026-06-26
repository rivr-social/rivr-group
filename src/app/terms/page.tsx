/**
 * Public Terms of Service page (`/terms`).
 *
 * Rendering: Server Component. Auth: public (listed in route-access allowlist).
 *
 * @module app/terms/page
 */
import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal/legal-document";
import { LEGAL_SERVICE_NAME, TERMS_OF_SERVICE } from "@/lib/legal/content";

export const metadata: Metadata = {
  title: `Terms of Service | ${LEGAL_SERVICE_NAME}`,
  description: `The Terms of Service governing your use of ${LEGAL_SERVICE_NAME}.`,
};

export default function TermsPage() {
  return <LegalDocument content={TERMS_OF_SERVICE} />;
}
