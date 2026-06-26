/**
 * Public Privacy Policy page (`/privacy`).
 *
 * Rendering: Server Component. Auth: public (listed in route-access allowlist).
 *
 * @module app/privacy/page
 */
import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal/legal-document";
import { LEGAL_SERVICE_NAME, PRIVACY_POLICY } from "@/lib/legal/content";

export const metadata: Metadata = {
  title: `Privacy Policy | ${LEGAL_SERVICE_NAME}`,
  description: `How ${LEGAL_SERVICE_NAME} collects, uses, and protects your information.`,
};

export default function PrivacyPage() {
  return <LegalDocument content={PRIVACY_POLICY} />;
}
