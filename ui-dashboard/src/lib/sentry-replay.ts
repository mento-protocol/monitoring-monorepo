// Re-export ONLY replayIntegration so the lazy replay chunk stays minimal.
// instrumentation-client.ts dynamic-imports this module instead of the whole
// "@sentry/nextjs" barrel: a dynamic namespace import retains every export of
// the target module, which pulled ~30 KB brotli of already-shipped SDK core
// into the async chunk. A single named re-export lets Turbopack tree-shake
// the async chunk down to the replay integration (rrweb recorder) itself.
export { replayIntegration } from "@sentry/nextjs";
