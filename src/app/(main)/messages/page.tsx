"use client";

/**
 * Lazy boundary for the Matrix-powered messages client.
 *
 * The messages UI pulls in `matrix-js-sdk` (~831 KB) via `matrix-client.ts` +
 * the chat panels. Loading it with `next/dynamic({ ssr: false })` keeps the SDK
 * out of the `/messages` route's first-load JS: the chunk is fetched on the
 * client only when the messages view actually mounts. Chat is inherently
 * browser-only (it needs a live Matrix client), so disabling SSR here changes
 * no behavior.
 */

import dynamic from "next/dynamic";

const MessagesLoading = () => (
  <div className="container max-w-4xl mx-auto px-4 py-6 h-[calc(100vh-8rem)] flex items-center justify-center text-muted-foreground">
    Connecting to Matrix...
  </div>
);

const MessagesPageClient = dynamic(() => import("./messages-page-client"), {
  ssr: false,
  loading: MessagesLoading,
});

export default function MessagesPage() {
  return <MessagesPageClient />;
}
