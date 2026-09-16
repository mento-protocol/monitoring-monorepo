// GitHub's stack endpoint orders layers from bottom to top. Readiness remains
// per PR: callers must run both projections for every unmerged dependency.
function requireMetadata(condition, message) {
  if (!condition) throw new Error(`Stack metadata unavailable: ${message}`);
}

function validRef(value) {
  return typeof value === "string" && value.length > 0;
}

function sameRepository(repository, repo) {
  try {
    const url = new URL(repository?.url);
    return (
      url.hostname ===
        (repo.host === "github.com" || !repo.host
          ? "api.github.com"
          : repo.host) &&
      url.pathname
        .toLowerCase()
        .endsWith(`/repos/${repo.owner}/${repo.name}`.toLowerCase())
    );
  } catch {
    return false;
  }
}

export async function fetchStackContext({ repo, pr, fetchJson }) {
  const endpoint = `repos/${repo.owner}/${repo.name}/stacks`;
  const listed = await fetchJson(repo, [
    `${endpoint}?pull_request=${pr.number}&per_page=100`,
  ]);
  requireMetadata(listed.ok, listed.error ?? "membership request failed");
  requireMetadata(Array.isArray(listed.value), "membership is not an array");
  requireMetadata(listed.value.length <= 1, "ambiguous membership");
  if (listed.value.length === 0) return null;

  const entry = listed.value[0];
  requireMetadata(
    Number.isSafeInteger(entry?.number) && entry.number > 0,
    "missing stack number",
  );
  const result = await fetchJson(repo, [`${endpoint}/${entry.number}`]);
  requireMetadata(result.ok, result.error ?? "detail request failed");
  const stack = result.value;
  requireMetadata(
    stack?.number === entry.number && stack.open === true,
    "stack identity or state changed",
  );
  requireMetadata(
    validRef(stack.base?.ref) && stack.base.ref === entry.base?.ref,
    "stack base missing or changed",
  );
  requireMetadata(
    stack.base.sha === undefined || /^[0-9a-f]{40}$/i.test(stack.base.sha),
    "invalid protection base SHA",
  );
  const layers = stack.pull_requests;
  requireMetadata(Array.isArray(layers) && layers.length > 0, "missing layers");
  requireMetadata(
    Array.isArray(entry.pull_requests) &&
      entry.pull_requests.length === layers.length,
    "membership changed",
  );
  const numbers = new Set();
  let parentRef = stack.base.ref;
  for (const [index, layer] of layers.entries()) {
    const previous = entry.pull_requests[index];
    requireMetadata(
      Number.isSafeInteger(layer?.number) &&
        layer.number > 0 &&
        !numbers.has(layer.number),
      "invalid or duplicate layer",
    );
    numbers.add(layer.number);
    requireMetadata(
      ["open", "closed"].includes(layer.state) &&
        typeof layer.draft === "boolean",
      "missing layer state",
    );
    requireMetadata(
      layer.merged_at === null ||
        (typeof layer.merged_at === "string" &&
          Number.isFinite(Date.parse(layer.merged_at))),
      "missing merge state",
    );
    requireMetadata(
      validRef(layer.head?.ref) &&
        /^[0-9a-f]{40}$/i.test(layer.head?.sha ?? ""),
      "missing layer head",
    );
    requireMetadata(
      sameRepository(layer.head?.repo, repo) &&
        sameRepository(layer.base?.repo, repo),
      "cross-repository layer",
    );
    requireMetadata(
      layer.base.sha === undefined || /^[0-9a-f]{40}$/i.test(layer.base.sha),
      "invalid layer base SHA",
    );
    requireMetadata(
      previous?.number === layer.number &&
        previous.head?.sha === layer.head.sha &&
        previous.head?.ref === layer.head.ref &&
        previous.state === layer.state &&
        previous.merged_at === layer.merged_at,
      "layer changed during lookup",
    );
    if (layer.state === "open") {
      requireMetadata(
        layer.merged_at === null && layer.base?.ref === parentRef,
        "nonlinear or changing open layer base",
      );
      parentRef = layer.head.ref;
    } else {
      requireMetadata(layer.merged_at !== null, "closed unmerged dependency");
    }
  }
  const position = layers.findIndex((layer) => layer.number === pr.number);
  requireMetadata(position >= 0, "filtered stack does not contain PR");
  const selected = layers[position];
  requireMetadata(
    selected.state === "open" &&
      selected.head.sha === pr.headRefOid &&
      selected.head.ref === pr.headRefName &&
      selected.base.ref === pr.baseRefName &&
      (selected.base.sha === undefined ||
        selected.base.sha === pr.baseRefOid) &&
      selected.draft === pr.isDraft,
    "PR head or base changed during lookup",
  );
  // Pin both sides to immutable commits: matching branch names do not prove
  // that a child includes a parent's latest changes.
  const openLayers = layers.filter((layer) => layer.state === "open");
  for (let index = 1; index < openLayers.length; index += 1) {
    const parent = openLayers[index - 1];
    const child = openLayers[index];
    const comparison = await fetchJson(repo, [
      `repos/${repo.owner}/${repo.name}/compare/${parent.head.sha}...${child.head.sha}?per_page=1`,
    ]);
    requireMetadata(
      comparison.ok,
      comparison.error ?? "parent ancestry request failed",
    );
    requireMetadata(
      ["ahead", "identical"].includes(comparison.value?.status) &&
        comparison.value?.behind_by === 0 &&
        comparison.value?.base_commit?.sha === parent.head.sha &&
        comparison.value?.merge_base_commit?.sha === parent.head.sha,
      `layer #${child.number} does not verifiably include parent #${parent.number} head`,
    );
  }
  return {
    number: stack.number,
    diffBaseRef: pr.baseRefName,
    protectionBaseRef: stack.base.ref,
    protectionBaseOid: stack.base.sha ?? null,
    position: position + 1,
    ready: null,
    readiness: "not_evaluated",
    layers: layers.map((layer) => ({
      number: layer.number,
      state: layer.merged_at ? "MERGED" : "OPEN",
      headRefName: layer.head.ref,
      headRefOid: layer.head.sha,
      baseRefName: layer.base.ref,
      baseRefOid: layer.base.sha ?? null,
      isDraft: layer.draft,
    })),
    dependencyPrNumbers: layers
      .slice(0, position)
      .filter((layer) => !layer.merged_at)
      .map((layer) => layer.number),
  };
}

export async function verifyReadinessSnapshot({
  repo,
  pr,
  stack,
  baseHealthOid = null,
  baseHealthError = null,
  fetchJson,
}) {
  // Base health is read through a mutable ref (`main`, or a stack's protection
  // base), so the commit it judged has to be pinned to the same base this
  // snapshot verifies. Without this, `main` advancing to a red commit after the
  // health query leaves every other field unchanged, and the gate would report
  // PASS on a base whose health it never actually read. A stack layer whose
  // stacks response omits the optional `base.sha` has no verified base commit
  // at all, so its health cannot be bound and must not be trusted.
  //
  // A read that already failed is not this check's business: it becomes a
  // required `base-red` blocker with an unknown state, which is the documented
  // structured output (docs/notes/pr-ready-state.md). Throwing over it would
  // turn a blocked-but-reportable PR into a crashed probe and leave watch mode
  // with no JSON at all. Only a health read claiming success has to match.
  if (baseHealthError === null) {
    let verifiedBaseOid = stack ? stack.protectionBaseOid : pr.baseRefOid;
    if (verifiedBaseOid == null) {
      // A native stacks response may omit the optional `base.sha`, and
      // refusing those layers outright would make their readiness permanently
      // unavailable. Resolve the protection ref here instead: read after the
      // health query, it is an independent observation of the same base, so a
      // base that moved in between still shows up as a mismatch below.
      const baseRef = stack?.protectionBaseRef ?? pr.baseRefName;
      const baseResult = await fetchJson(repo, [
        `repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(baseRef)}`,
      ]);
      requireMetadata(
        baseResult.ok,
        baseResult.error ?? "protection base lookup failed",
      );
      verifiedBaseOid = baseResult.value?.sha ?? null;
      requireMetadata(
        typeof verifiedBaseOid === "string" &&
          /^[0-9a-f]{40}$/u.test(verifiedBaseOid),
        "protection base commit is unreadable",
      );
    }
    requireMetadata(
      baseHealthOid === verifiedBaseOid,
      "base advanced while gathering readiness data",
    );
  }

  const result = await fetchJson(repo, [
    `repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  ]);
  requireMetadata(result.ok, result.error ?? "final PR request failed");
  const current = result.value;
  requireMetadata(
    current?.number === pr.number &&
      current.state === "open" &&
      current.head?.sha === pr.headRefOid &&
      current.head?.ref === pr.headRefName &&
      current.base?.ref === pr.baseRefName &&
      current.base?.sha === pr.baseRefOid &&
      current.draft === pr.isDraft,
    "PR changed while gathering readiness data",
  );
  const currentStack = await fetchStackContext({ repo, pr, fetchJson });
  requireMetadata(
    JSON.stringify(currentStack) === JSON.stringify(stack),
    "stack changed while gathering readiness data",
  );
}
