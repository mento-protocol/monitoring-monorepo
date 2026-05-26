function normalizeLimit(limit) {
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.trunc(limit));
}

export async function selectTier2Queue(ranked, limit, hasDeepRecord) {
  const target = normalizeLimit(limit);
  const queue = [];
  let skipResume = 0;

  for (const candidate of ranked) {
    if (queue.length >= target) break;
    if (await hasDeepRecord(candidate.address)) {
      skipResume += 1;
      continue;
    }
    queue.push(candidate);
  }

  return { queue, skipResume };
}
