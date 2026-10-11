// Grading-only answer-key selection. Keep host probe code in the dataset module.
export function rootsForCase(dataset, caseId) {
  const item = dataset.cases.find((entry) => entry.id === caseId);
  if (!item) throw new Error(`Unknown case ${caseId}`);
  const ids = new Set([
    ...item.expected_root_ids,
    ...item.negative_control_root_ids,
  ]);
  return dataset.roots.filter((root) => ids.has(root.id));
}
