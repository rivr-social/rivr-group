export function resolveRequestOrigin(request: Request, fallbackBaseUrl?: string): string {
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedHost) {
    const protocol =
      forwardedProto ||
      (fallbackBaseUrl?.startsWith("https://")
        ? "https"
        : fallbackBaseUrl?.startsWith("http://")
          ? "http"
          : requestUrl.protocol.replace(":", ""));
    return `${protocol}://${forwardedHost}`.replace(/\/+$/, "");
  }

  return (fallbackBaseUrl || requestUrl.origin).replace(/\/+$/, "");
}
