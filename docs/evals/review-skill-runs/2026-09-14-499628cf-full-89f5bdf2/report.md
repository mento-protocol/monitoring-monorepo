## Review-skill eval — 2026-09-14 (full)

**RED** — status complete, suite `review-skill-v1`, key `499628cf`

- no baseline row; comparison skipped
- pipeline P1 recall 0.438 is below p1_recall_floor 0.6

| condition | model | draws | recall | P1 | novel-real | wrong | $ | s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pipeline | gpt-5.6-sol@high → claude-opus-5@high | 1 | 19/51 (37.3%) | 7/16 (43.8%) | 17 | 2 | $10.76 | 4428 |
| replay | gpt-5.6-sol@high → claude-opus-5@high | 2 | 36/78 (46.2%) | 10/20 (50.0%) | 43 | 4 | $16.13 | 2743 |
| control | claude-opus-5@high | 1 | 12/39 (30.8%) | 4/10 (40.0%) | 17 | 3 | $5.89 | 865 |

No paired baseline comparison for this row.

Judge calibration 39/40. Cost $44.69 over 8036 s — $32.78 cells, $11.91 scoring.
Skill `installed` (`89f5bdf2`), claude 2.1.270 (Claude Code), codex codex-cli 0.154.0, host Mac.
Detail: `docs/evals/review-skill-runs/2026-09-14-499628cf-full-89f5bdf2`. Contract `59b82ee3`.
