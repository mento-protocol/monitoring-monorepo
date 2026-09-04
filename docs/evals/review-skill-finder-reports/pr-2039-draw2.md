The capability probe can succeed without pull-request write permission. The temporary branch implementation also has cleanup and concurrency defects, and the change exceeds the repository's source-file limit.

Full review comments:

- [P1] Verify pull-request write access before setup succeeds — /Users/chapati/.cache/mento-review-eval/fx-2039-3409e991f810/scripts/bootstrap/codex-cloud-setup.sh:184-185
  When a token has Contents write permission but only Pull requests read permission, this GET and the branch probe both succeed, but `gh pr create` and PR updates later fail. The setup therefore reports success without verifying the shipping capability named by the change. Probe a pull-request write operation or inspect a reliable permission signal.

- [P2] Keep the cleanup trap armed after delete failures — /Users/chapati/.cache/mento-review-eval/fx-2039-3409e991f810/scripts/bootstrap/codex-cloud-setup.sh:217-220
  If branch creation succeeds but deletion fails, setting `created=false` prevents the EXIT trap from retrying cleanup, so the temporary remote branch remains. Keep cleanup armed or invoke a separate compensation path before returning; this is also required by `docs/pr-checklists/recurring-review-patterns.md:198-199`.

- [P2] Make probe branch names unique across containers — /Users/chapati/.cache/mento-review-eval/fx-2039-3409e991f810/scripts/bootstrap/codex-cloud-setup.sh:192-192
  Two Codex Cloud containers started in the same second can have the same shell PID and generate the same branch name. One setup can then reject the other's push, delete its probe, or fail during deletion. Add cross-container entropy, such as a UUID or secure random suffix.

- [P2] Split the setup script below the 600-line cap — /Users/chapati/.cache/mento-review-eval/fx-2039-3409e991f810/scripts/bootstrap/codex-cloud-setup.sh:530-530
  This change grows the source file from 547 to 609 lines. The repository requires a same-PR split when a change pushes a source file above 600 lines, and scripts have no ESLint limit to catch this automatically (`docs/pr-checklists/recurring-review-patterns.md:202-208`). Extract the GitHub probes or Playwright setup with adequate headroom.
