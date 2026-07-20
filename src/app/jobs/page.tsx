import { redirect } from "next/navigation";

/**
 * Sovereign index redirect. Job detail pages live under `/jobs/[id]`, but there
 * is no standalone `/jobs` list surface (jobs render under the primary group's
 * Jobs tab) — a bare hit previously 404'd. Forward to the group home's Jobs tab
 * (the root page routes a valid `?tab=` to the primary group).
 */
export default function JobsIndexPage() {
  redirect("/?tab=jobs");
}
