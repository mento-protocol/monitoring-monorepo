// Constant fixture-build identity, split out from fixture-build.mjs so it has
// no `import.meta` usage: Playwright's config loader requires `.mjs` siblings
// of a `.ts` config through its own CJS-interop transform, which breaks
// (`ReferenceError: exports is not defined in ES module scope`) on a required
// module that reads `import.meta` (fixture-build.mjs needs it for its CLI
// entry point and file-snapshot paths). playwright.config.ts imports these
// values from here instead of from fixture-build.mjs directly.
//
// These values are baked into the client bundle at build time (`NEXT_PUBLIC_*`
// are inlined), so they MUST stay byte-stable for the build to be
// turbo-cacheable across runs. The fixture Hasura port is therefore fixed
// rather than OS-assigned: it is embedded in the client's GraphQL URL and CSP
// connect-src, so the fixture server has to answer on exactly this port. The
// Next server port stays OS-assigned at runtime (`next start` binds it; it is
// not build-inlined).
export const FIXTURE_HASURA_PORT = 3211;
export const FIXTURE_HASURA_URL = `http://127.0.0.1:${FIXTURE_HASURA_PORT}/graphql`;
export const FIXTURE_DIST_DIR = ".next-fixture";
