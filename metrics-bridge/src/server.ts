import { createServer } from "node:http";
import { register } from "./metrics.js";
import { PORT, POLL_INTERVAL_MS } from "./config.js";

let lastSuccessfulPollAt = 0;

export function markHealthy(): void {
  lastSuccessfulPollAt = Math.floor(Date.now() / 1000);
}

const STALENESS_WINDOW_S = Math.ceil((POLL_INTERVAL_MS * 3) / 1000);

function isHealthy(): boolean {
  if (lastSuccessfulPollAt === 0) return false;
  return (
    Math.floor(Date.now() / 1000) - lastSuccessfulPollAt < STALENESS_WINDOW_S
  );
}

export function handleRequest(
  req: { url?: string; method?: string },
  res: {
    writeHead: (status: number, headers?: Record<string, string>) => void;
    end: (body: string) => void;
  },
): void {
  const path = req.url?.split("?")[0];

  if (path === "/metrics" && req.method === "GET") {
    register
      .metrics()
      .then((metrics) => {
        res.writeHead(200, { "Content-Type": register.contentType });
        res.end(metrics);
      })
      .catch(() => {
        res.writeHead(500);
        res.end("internal error");
      });
    return;
  }

  // `/health` (not `/healthz`): Cloud Run v2 reserves `/healthz` at its
  // frontend — external requests to that path get a Google-branded 404 and
  // never reach the container.
  if (path === "/health" && req.method === "GET") {
    const healthy = isHealthy();
    res.writeHead(healthy ? 200 : 503);
    res.end(healthy ? "ok" : "unhealthy");
    return;
  }

  res.writeHead(404);
  res.end("not found");
}

export function startServer(): void {
  const server = createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`metrics-bridge listening on :${PORT}`);
  });
}
