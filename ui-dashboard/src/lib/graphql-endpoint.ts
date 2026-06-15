export function resolveGraphqlEndpoint(hasuraUrl: string): string {
  if (hasuraUrl.startsWith("/") && typeof window !== "undefined") {
    return new URL(hasuraUrl, window.location.origin).toString();
  }
  return hasuraUrl;
}
