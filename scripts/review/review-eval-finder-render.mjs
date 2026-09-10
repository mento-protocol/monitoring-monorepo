/**
 * Text rendering of a finder comparison report. Split from
 * `review-eval-finder-compare.mjs` for line headroom; it reads the report
 * object `buildReport` returns and decides nothing.
 */

const short = (value) => String(value).slice(0, 8);

function rate(matched, opportunities) {
  return opportunities === 0 ? "n/a" : (matched / opportunities).toFixed(3);
}

export function render(report) {
  const lines = [];
  for (const side of ["anchor", "candidate"]) {
    const arm = report[side];
    lines.push(
      `${side.padEnd(9)} finder ${arm.finder} argv ${short(arm.finder_argv_digest)} skill ${short(arm.skill_digest)} orchestrator ${short(arm.orchestrator_digest)} judge ${arm.judge?.model}@${arm.judge?.effort} calibration ${arm.judge_calibration?.agreement}/${arm.judge_calibration?.total} cli ${arm.codex_cli} / ${arm.claude_cli}`,
    );
    lines.push(
      `${" ".repeat(9)} contract ${short(arm.contract_digest)} scorer ${short(arm.matcher_digest)} calibration set ${short(arm.calibration_digest)} key ${short(arm.comparability_key)}`,
    );
  }
  lines.push(
    `loaded    contract ${short(report.contract_digest)} scorer ${short(report.matcher_digest)}`,
  );
  lines.push("");
  for (const warning of report.warnings) lines.push(`WARNING: ${warning}`);
  for (const note of report.notes) lines.push(`note: ${note}`);
  if (report.warnings.length || report.notes.length) lines.push("");
  lines.push(
    ["pr", "matched", "cand", "net", "p1", "cand p1", "wrong", "cand wrong"]
      .map((head, index) => head.padStart(index === 0 ? 6 : 11))
      .join(""),
  );
  for (const row of report.rows) {
    lines.push(
      [
        String(row.pr).padStart(6),
        String(row.anchor.matched).padStart(11),
        String(row.candidate.matched).padStart(11),
        String(row.net > 0 ? `+${row.net}` : row.net).padStart(11),
        `${row.anchor.p1_matched}/${row.anchor.p1_opportunities}`.padStart(11),
        `${row.candidate.p1_matched}/${row.candidate.p1_opportunities}`.padStart(
          11,
        ),
        String(row.anchor.wrong_claims).padStart(11),
        String(row.candidate.wrong_claims).padStart(11),
      ].join(""),
    );
  }
  const { totals } = report;
  lines.push("");
  lines.push(
    `paired PRs ${totals.prs}; net matched ${totals.net > 0 ? `+${totals.net}` : totals.net} (anchor ${totals.anchor.matched}, candidate ${totals.candidate.matched})`,
  );
  lines.push(
    `P1 recall  anchor ${totals.anchor.p1_matched}/${totals.anchor.p1_opportunities} (${rate(totals.anchor.p1_matched, totals.anchor.p1_opportunities)}), candidate ${totals.candidate.p1_matched}/${totals.candidate.p1_opportunities} (${rate(totals.candidate.p1_matched, totals.candidate.p1_opportunities)})`,
  );
  lines.push(
    `wrong claims anchor ${totals.anchor.wrong_claims}, candidate ${totals.candidate.wrong_claims}`,
  );
  const test = report.sign_flip;
  lines.push(
    `sign-flip ${test.method}: n ${test.n}, informative ${test.informative_pairs}, net ${test.net}, p_greater ${test.p_greater.toFixed(4)}, p_less ${test.p_less.toFixed(4)}`,
  );
  for (const [side, prs] of Object.entries(report.skipped)) {
    if (prs.length) lines.push(`skipped (${side}): ${prs.join(", ")}`);
  }
  lines.push(
    "one draw per fixture: enough to reject a finder, never to promote one",
  );
  return `${lines.join("\n")}\n`;
}
