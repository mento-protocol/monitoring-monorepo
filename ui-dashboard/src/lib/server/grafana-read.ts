class InvalidGrafanaResponseError extends Error {}

export function resolveGrafanaEndpoint(
  rawOrigin: string | undefined,
  pathname: `/${string}`,
): URL | null {
  if (!rawOrigin || pathname.includes("?") || pathname.includes("#"))
    return null;
  try {
    const url = new URL(rawOrigin);
    const localHttp =
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !localHttp) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    )
      return null;
    url.pathname = pathname;
    return url;
  } catch {
    return null;
  }
}

export async function readBoundedGrafanaResponse(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > maximumBytes)
  )
    throw new InvalidGrafanaResponseError();
  if (response.body === null) throw new InvalidGrafanaResponseError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- ordered streams expose one bounded chunk at a time
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      void reader.cancel().catch(() => undefined);
      throw new InvalidGrafanaResponseError();
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new InvalidGrafanaResponseError();
  }
}
