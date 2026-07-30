import { PageNotFoundView } from "@/components/page-not-found-view"

/** Route-level 404. Shares its view with pages that must render (not throw) it. */
export default function NotFound() {
  return <PageNotFoundView />
}
