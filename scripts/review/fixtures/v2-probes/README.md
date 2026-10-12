<!-- agent-context: title="Frozen review probe source fixtures" status=active owner=eng canonical=true last_verified=2026-09-30 doc_type=reference scope=ci/process review_interval_days=90 garden_lane=package-readmes-reference -->

# Frozen probe source fixtures

These files are frozen executable test data from `mento-protocol/monitoring-monorepo`. Each `.mjs.txt` file preserves the exact original module bytes. Tests copy them into a temporary tree and apply the pinned repair patches for repaired cases. The production probe guard verifies the complete module closure before importing private copies.

The `.txt` suffix excludes these snapshots from JavaScript lint and test discovery. Do not import them directly. Source updates require an audit of module initialization, dependencies, repair bytes, and the production trust registry.

| Test file                                          | Original commit                            | Original source path                                          | SHA256                                                             |
| -------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pr-1984/sentry-autofix-run-record.mjs.txt`        | `07901b22c0da7db2b27f15dbbc3f5e8ea45623df` | `scripts/sentry/autofix/sentry-autofix-run-record.mjs`        | `ce84784ed26821c2f4175087e96dac2039316ae539f0e2f04828de1ea548b47b` |
| `pr-1984/sentry-autofix-refused-inventory.mjs.txt` | `07901b22c0da7db2b27f15dbbc3f5e8ea45623df` | `scripts/sentry/autofix/sentry-autofix-refused-inventory.mjs` | `d34ef1bf4cb33363554fd6b06bb2b44aeeef545cf01d40a160ee7ff98da245ed` |
| `pr-1982/issue-board-backfill.mjs.txt`             | `ee739b4142564a3a4e9273da6ba345f3cda5e8d3` | `scripts/pr/issue-board-backfill.mjs`                         | `a4e75227e4bf5b15cecad4096cb9ed42bce1f2a2c9b70ddc0bc8e51081f72349` |
| `pr-1982/issue-board-state.mjs.txt`                | `ee739b4142564a3a4e9273da6ba345f3cda5e8d3` | `scripts/pr/issue-board-state.mjs`                            | `d9b4445ab42a119fbf5963aeea7accb516461bd99ae3edfb3670e63b0d1bfaaf` |

Tests need Node and Git for local patch application. They do not fetch repositories or require historical Git objects.
