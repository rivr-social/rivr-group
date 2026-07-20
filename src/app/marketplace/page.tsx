import { redirect } from "next/navigation";

/**
 * Sovereign index redirect. This app has no standalone `/marketplace` list
 * surface (listings live under the primary group's Marketplace tab and detail
 * pages under `/marketplace/[id]`), but the sitemap advertises `/marketplace`
 * and the CommandBar/typed nav target it — a bare hit previously 404'd. Forward
 * to the group home's Marketplace tab (the root page routes a valid `?tab=` to
 * the primary group).
 */
export default function MarketplaceIndexPage() {
  redirect("/?tab=marketplace");
}
