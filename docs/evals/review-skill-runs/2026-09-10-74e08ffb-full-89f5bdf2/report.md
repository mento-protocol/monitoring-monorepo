## Review-skill eval — 2026-09-10 (full)

**RED** — status complete, suite `review-skill-v1`, key `74e08ffb`

- no baseline row; comparison skipped
- pipeline P1 recall 0.500 is below p1_recall_floor 0.6

| condition | model | draws | recall | P1 | novel-real | wrong | $ | s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pipeline | gpt-5.6-sol@high → claude-opus-5@high | 1 | 22/51 (43.1%) | 8/16 (50.0%) | 31 | 1 | $18.16 | 8823 |
| replay | gpt-5.6-sol@high → claude-opus-5@high | 2 | 42/78 (53.8%) | 12/20 (60.0%) | 47 | 3 | $21.20 | 3475 |
| control | claude-opus-5@high | 1 | 15/39 (38.5%) | 5/10 (50.0%) | 19 | 2 | $9.79 | 1530 |

No paired baseline comparison for this row.

Judge calibration 39/40. Cost $68.65 over 13828 s — $49.15 cells, $19.50 scoring.
Skill `installed` (`89f5bdf2`), claude 2.1.267 (Claude Code), codex codex-cli 0.154.0, host Mac.
Detail: `docs/evals/review-skill-runs/2026-09-10-74e08ffb-full-89f5bdf2`. Contract `59b82ee3`.
