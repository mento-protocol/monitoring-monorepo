<!-- agent-context: title="Intel marathon scripts" status=active owner=eng canonical=true last_verified=2026-09-10 doc_type=reference scope=ui-dashboard review_interval_days=90 garden_lane=package-readmes-reference -->

# Intel marathon scripts

`tier1-bulk-enrich.mjs` owns CLI parsing and orchestration. Its header lists
supported flags. `run.sh tier1-bulk-enrich` remains the credential-loading
entry point for an authorized operator run.

Tier 1 imports four sibling modules:

- `tier1-discovery.mjs`: paged discovery, deduplication, and queue ordering.
- `tier1-quota.mjs`: Arkham requests, quota precedence, and usage polls.
- `tier1-writes.mjs`: label mapping, refresh merging, Redis requests, and
  confirmed write outcomes.
- `tier1-progress.mjs`: progress history loading for the selected scope.

Importing these modules does not run the CLI or access credentials, the network,
or progress files. Factory arguments provide transport and storage for tests.
The CLI preserves the existing resume policy: every progress record with an
address marks it processed, including error records.

Run the offline tests with:

```bash
pnpm --filter @mento-protocol/ui-dashboard test scripts/intel-marathon
```

The parity suite runs the frozen pre-extraction source in
`fixtures/tier1-before.mjs.txt` and the current CLI in separate temporary
folders. The baseline is from main commit
`a746e1c5a45938318303633fa7cddc009f92d0ef`. Earlier ad-hoc review harnesses were
not committed; the tests reconstruct the current contracts and the write-loss
and quota findings recorded in the PR #2035 review evidence.

The preload uses fake credentials, rejects unexpected requests, and disables
other Node network transports. It fixes the clock and shortens sleeps. Tests
compare stdout, stderr, exit code, request order and bodies, and generated
files. Only error stack frames are removed because extraction moves their
source locations. Error messages remain exact.

`--dry-run` still reads Hasura and can read Upstash. It is not an offline test.
A live enrichment run spends quota and can write production labels. It needs
separate operator authorization.
