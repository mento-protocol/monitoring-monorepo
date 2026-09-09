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
      selected.draft === pr.isDraft,
    "PR head or base changed during lookup",
  );
  return {
    number: stack.number,
    diffBaseRef: pr.baseRefName,
    protectionBaseRef: stack.base.ref,
    position: position + 1,
    ready: null,
    readiness: "not_evaluated",
    layers: layers.map((layer) => ({
      number: layer.number,
      state: layer.merged_at ? "MERGED" : "OPEN",
      headRefName: layer.head.ref,
      headRefOid: layer.head.sha,
    })),
    dependencyPrNumbers: layers
      .slice(0, position)
      .filter((layer) => !layer.merged_at)
      .map((layer) => layer.number),
  };
}
