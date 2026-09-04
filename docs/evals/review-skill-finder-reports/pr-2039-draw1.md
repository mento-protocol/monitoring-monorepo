The new checks do not establish pull-request write access, and the branch probe can fail because of unrelated pre-push gates. Cached maintenance can also retain an incompatible Playwright browser revision.

Full review comments:

- [P1] Verify pull-request write permission — /Users/chapati/.cache/mento-review-eval/fx-2039-3409e991f810/scripts/bootstrap/codex-cloud-setup.sh:184-185
  A fine-grained token with Contents write and Pull requests read passes this GET and the branch probe, but `gh pr create`, PR updates, and review replies still return 403 because they require Pull requests write. Since setup claims to validate shipping capabilities, add a write-capability probe instead of treating this read request as sufficient.

- [P1] Isolate the write probe from pre-push hooks — /Users/chapati/.cache/mento-review-eval/fx-2039-3409e991f810/scripts/bootstrap/codex-cloud-setup.sh:205-206
  When setup runs again in a checkout where `core.hooksPath=.trunk/hooks` is already configured, this push invokes the repository's pre-push quality gate before setup activates pnpm or installs the checked-out branch's dependencies. A stale dependency tree or an expected in-progress gate failure then produces the misleading read-only-token error even though Git write access works. Disable hooks only for this capability probe or run it after its prerequisites are ready.

- [P2] Refresh Chromium during cached maintenance — /Users/chapati/.cache/mento-review-eval/fx-2039-3409e991f810/scripts/bootstrap/codex-cloud-setup.sh:583-583
  When a cached container checks out a branch that changes `@playwright/test`, this setup-only call leaves the browser cache at the old Playwright revision because maintenance updates packages but never installs the matching browser. Browser tests then fail with a missing executable. Add a matching Chromium install or verification to the maintenance path; `AGENTS.md:98-101` requires changes to cover every live workflow entry point.
