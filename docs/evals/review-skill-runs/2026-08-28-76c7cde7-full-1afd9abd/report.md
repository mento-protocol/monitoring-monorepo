## Review-skill eval — 2026-08-28 (full)

**AMBER** — status complete, suite `review-skill-v1`, key `76c7cde7`

- no baseline row; comparison skipped
- judge calibration 29/40 is below 38/40

| condition | model | draws | recall | P1 | novel-real | wrong | $ | s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pipeline | gpt-5.6-sol@high → claude-opus-5@high | 2 | 30/68 (44.1%) | 10/24 (41.7%) | 19 | 9 | $40.12 | 18485 |
| replay | gpt-5.6-sol@high → claude-opus-5@high | 2 | 21/44 (47.7%) | 6/12 (50.0%) | 18 | 3 | $19.89 | 3068 |
| control | claude-opus-5@high | 1 | 11/34 (32.4%) | 4/12 (33.3%) | 12 | 2 | $15.46 | 2523 |

No paired baseline comparison for this row.

Judge calibration 29/40. Cost $108.01 over 24076 s — $75.47 cells, $32.54 scoring.
Skill `installed` (`1afd9abd`), claude 2.1.247 (Claude Code), codex codex-cli 0.150.1, host Mac.
Detail: `docs/evals/review-skill-runs/2026-08-28-76c7cde7-full-1afd9abd`. Contract `8b6479d1`.
