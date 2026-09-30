// Count one root once per delivered review. Never infer globally clean code.
export function metricSummary(rows) {
  const arms = {};
  for (const treatment of ["incumbent", "candidate"]) {
    const selected = rows.filter((row) => row.treatment === treatment);
    const expected = selected.flatMap((row) => row.expected_root_ids ?? []);
    const defects = selected.flatMap((row) =>
      (row.score.defects ?? []).filter((root) =>
        row.expected_root_ids?.includes(root.id),
      ),
    );
    const matched = defects.filter((root) => root.verdict === "matched").length;
    const uncertain = defects.filter(
      (root) => root.verdict === "uncertain",
    ).length;
    const negativeAccusations = selected.flatMap((row) =>
      (row.score.defects ?? []).filter(
        (root) =>
          row.negative_control_root_ids?.includes(root.id) &&
          root.verdict === "matched",
      ),
    );
    const novel = selected.flatMap((row) => row.score.novel ?? []);
    arms[treatment] = {
      reviews: selected.length,
      known_matched: matched,
      known_opportunities: expected.length,
      known_recall:
        expected.length && uncertain === 0 ? matched / expected.length : null,
      uncertain_count: uncertain,
      uncertain_roots: selected.flatMap((row) =>
        (row.score.defects ?? [])
          .filter(
            (root) =>
              row.expected_root_ids?.includes(root.id) &&
              root.verdict === "uncertain",
          )
          .map((root) => ({
            case_id: row.case_id,
            id: root.id,
            verdict: root.verdict,
            severity:
              row.roots?.find((item) => item.id === root.id)?.severity ?? null,
          })),
      ),
      missed_roots: selected.flatMap((row) =>
        (row.score.defects ?? [])
          .filter(
            (root) =>
              row.expected_root_ids?.includes(root.id) &&
              root.verdict === "unmatched",
          )
          .map((root) => ({
            case_id: row.case_id,
            id: root.id,
            verdict: root.verdict,
            severity:
              row.roots?.find((item) => item.id === root.id)?.severity ?? null,
          })),
      ),
      wrong: selected.reduce(
        (count, row) =>
          count +
          new Set([
            ...(row.score.novel ?? [])
              .filter((claim) => claim.verdict === "wrong")
              .map((claim) => claim.claim_id),
            ...(row.score.defects ?? [])
              .filter(
                (root) =>
                  row.negative_control_root_ids?.includes(root.id) &&
                  root.verdict === "matched",
              )
              .flatMap((root) => root.claim_ids ?? []),
          ]).size,
        0,
      ),
      repaired_root_accusations: negativeAccusations.length,
      unsupported: novel.filter((claim) => claim.verdict === "unsupported")
        .length,
      unverified: novel.filter((claim) => claim.verdict === "unverified")
        .length,
      model_supported_novel: novel.filter(
        (claim) => claim.verdict === "model-supported",
      ).length,
      repaired_reviews: selected.filter((row) => row.variant === "repaired")
        .length,
      repaired_wrong_or_unsupported: selected
        .filter((row) => row.variant === "repaired")
        .flatMap((row) => row.score.novel ?? [])
        .filter((claim) => ["wrong", "unsupported"].includes(claim.verdict))
        .length,
    };
  }
  const byFamily = [
    ...new Set(rows.map((row) => row.family_id).filter(Boolean)),
  ].map((family) => {
    const selected = rows.filter((row) => row.family_id === family);
    const matched = (treatment) =>
      selected
        .filter((row) => row.treatment === treatment)
        .flatMap((row) =>
          (row.score.defects ?? []).filter((root) =>
            row.expected_root_ids?.includes(root.id),
          ),
        )
        .filter((root) => root.verdict === "matched").length;
    const cases = (treatment) =>
      selected
        .filter((row) => row.treatment === treatment)
        .map((row) => row.case_id)
        .sort();
    const paired =
      JSON.stringify(cases("incumbent")) === JSON.stringify(cases("candidate"));
    const uncertain = selected.some((row) =>
      (row.score.defects ?? []).some(
        (root) =>
          row.expected_root_ids?.includes(root.id) &&
          root.verdict === "uncertain",
      ),
    );
    return {
      family_id: family,
      paired,
      known_match_delta:
        paired && !uncertain
          ? matched("candidate") - matched("incumbent")
          : null,
    };
  });
  return {
    arms,
    by_family: byFamily,
    negative_control_limit:
      "Repaired cases are negative controls for named roots, not globally clean changes.",
  };
}
