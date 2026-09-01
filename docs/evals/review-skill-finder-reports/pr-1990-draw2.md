The new CodeRabbit projection misses a known valid completion surface. This causes false stale states and redundant closeout requests on clean current-head reviews.

Review comment:

- [P2] Recognize trusted exact-head completion summaries — /private/tmp/fx-1990/scripts/pr/pr-ready-state-core.mjs:762-767
  When CodeRabbit completes a clean current-head run through its top-level summary, as observed on PR #2007, `reviews` can contain only stale or empty containers. This loop rejects that valid completion, while the issue-comment loop recognizes only manual requests, so the closeout procedure reports `stale` and posts a redundant `@coderabbitai review` that receives “Already reviewed.” Recognize trusted terminal summaries using the author, run ID, full head SHA, and timestamp before requesting another review.
