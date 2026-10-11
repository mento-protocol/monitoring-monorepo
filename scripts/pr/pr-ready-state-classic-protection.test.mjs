import test from "node:test";
import assert from "node:assert/strict";
import { fetchRequiredStatusContexts } from "./pr-ready-state-status-contexts.mjs";
import { classicProtectionConfirmedAbsent } from "./pr-ready-state-classic-protection.mjs";
const repo = {
  owner: "mento-protocol",
  name: "monitoring-monorepo",
  host: null,
};
const proof = () => ({
  data: {
    repository: {
      nameWithOwner: "mento-protocol/monitoring-monorepo",
      viewerPermission: "WRITE",
      branchProtectionRules: {
        totalCount: 0,
        nodes: [],
        pageInfo: { hasNextPage: false },
      },
      ref: { name: "main", branchProtectionRule: null },
    },
  },
});
async function probe(value, overrides = {}) {
  return classicProtectionConfirmedAbsent({
    repo,
    encodedBaseRef: "main",
    error: "gh: Not Found (HTTP 404)",
    fetchBranch: async () => ({
      ok: true,
      value: { name: "main", protection: { enabled: false } },
    }),
    fetchClassicProtection: async () => ({ ok: true, value }),
    ...overrides,
  });
}
test("generic 404 requires independently complete exact-base absence proof", async () => {
  let args;
  assert.equal(
    await probe(proof(), {
      fetchClassicProtection: async (actualRepo, actualArgs) => {
        assert.deepEqual(actualRepo, repo);
        args = actualArgs;
        return { ok: true, value: proof() };
      },
    }),
    true,
  );
  assert.ok(args.includes("ref=refs/heads/main"));
  assert.ok(args.includes("owner=mento-protocol"));
  assert.ok(args.includes("name=monitoring-monorepo"));
});
const invalid = {
  "GraphQL errors with otherwise complete data": (p) => {
    p.errors = [{ message: "forbidden" }];
  },
  "malformed error payload": (p) => {
    p.errors = "forbidden";
  },
  "unreadable repository": (p) => {
    p.data.repository = null;
  },
  "malformed repository name": (p) => {
    p.data.repository.nameWithOwner = 123;
  },
  "wrong repository": (p) => {
    p.data.repository.nameWithOwner = "other/repo";
  },
  "read-only viewer": (p) => {
    p.data.repository.viewerPermission = "READ";
  },
  "missing permission": (p) => {
    delete p.data.repository.viewerPermission;
  },
  "unreadable inventory": (p) => {
    p.data.repository.branchProtectionRules = null;
  },
  "missing total count": (p) => {
    delete p.data.repository.branchProtectionRules.totalCount;
  },
  "nonzero total count": (p) => {
    p.data.repository.branchProtectionRules.totalCount = 1;
  },
  "remaining inventory page": (p) => {
    p.data.repository.branchProtectionRules.pageInfo.hasNextPage = true;
  },
  "missing pagination evidence": (p) => {
    delete p.data.repository.branchProtectionRules.pageInfo;
  },
  "hidden classic-only rule": (p) => {
    p.data.repository.branchProtectionRules.nodes = [{ id: "classic" }];
  },
  "null nodes": (p) => {
    p.data.repository.branchProtectionRules.nodes = null;
  },
  "missing ref": (p) => {
    p.data.repository.ref = null;
  },
  "wrong ref": (p) => {
    p.data.repository.ref.name = "release";
  },
  "missing ref rule": (p) => {
    delete p.data.repository.ref.branchProtectionRule;
  },
  "existing matching classic rule": (p) => {
    p.data.repository.ref.branchProtectionRule = { id: "classic" };
  },
};
for (const [name, mutate] of Object.entries(invalid)) {
  test(`fails closed: ${name}`, async () => {
    const p = proof();
    mutate(p);
    assert.equal(await probe(p), false);
  });
}
test("failed GraphQL transport fails closed", async () => {
  assert.equal(
    await probe(proof(), {
      fetchClassicProtection: async () => ({ ok: false, error: "403" }),
    }),
    false,
  );
});
for (const branch of [
  null,
  { name: "main" },
  { name: "main", protection: { enabled: true } },
  { name: "wrong", protection: { enabled: false } },
]) {
  test(`fails closed: contradictory branch ${JSON.stringify(branch)}`, async () => {
    let fetched = false;
    assert.equal(
      await probe(proof(), {
        fetchBranch: async () => ({ ok: true, value: branch }),
        fetchClassicProtection: async () => {
          fetched = true;
          return { ok: true, value: proof() };
        },
      }),
      false,
    );
    assert.equal(fetched, false);
  });
}
test("non-generic 404 for missing branch cannot use absence inventory", async () => {
  assert.equal(
    await probe(proof(), { error: "gh: Branch not found (HTTP 404)" }),
    false,
  );
});
test("conclusive REST messages retain their existing independent proof", async () => {
  const never = async () => {
    throw new Error("must not request GraphQL");
  };
  assert.equal(
    await probe(null, {
      error: "gh: Branch not protected (HTTP 404)",
      fetchClassicProtection: never,
    }),
    true,
  );
  assert.equal(
    await probe(null, {
      error: "gh: Required status checks not enabled (HTTP 404)",
      fetchBranch: never,
      fetchClassicProtection: never,
    }),
    true,
  );
});
test("qualified ref for branch containing slash is encoded only for REST", async () => {
  const p = proof();
  p.data.repository.ref.name = "release/test";
  let graphArgs;
  assert.equal(
    await probe(p, {
      encodedBaseRef: "release%2Ftest",
      fetchBranch: async (_, args) => {
        assert.ok(args[0].endsWith("release%2Ftest"));
        return {
          ok: true,
          value: { name: "release/test", protection: { enabled: false } },
        };
      },
      fetchClassicProtection: async (_, args) => {
        graphArgs = args;
        return { ok: true, value: p };
      },
    }),
    true,
  );
  assert.ok(graphArgs.includes("ref=refs/heads/release/test"));
});

for (const classicPresent of [false, true]) {
  test(`integration: ruleset context completeness requires no hidden classic rule (${classicPresent})`, async () => {
    const p = proof();
    if (classicPresent)
      p.data.repository.branchProtectionRules.nodes = [{ id: "hidden" }];
    const result = await fetchRequiredStatusContexts({
      repo,
      baseRef: "main",
      fetchProtection: async () => ({
        ok: false,
        error: "gh: Not Found (HTTP 404)",
      }),
      fetchBranch: async () => ({
        ok: true,
        value: { name: "main", protection: { enabled: false } },
      }),
      fetchClassicProtection: async () => ({ ok: true, value: p }),
      fetchRules: async () => ({
        ok: true,
        value: [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [
                { context: "ci", integration_id: 15368 },
              ],
              strict_required_status_checks_policy: false,
            },
          },
        ],
      }),
    });
    assert.deepEqual(result.contexts, [
      { context: "ci", integrationId: 15368 },
    ]);
    assert.equal(result.strict, classicPresent ? null : false);
    assert.equal(result.error === null, !classicPresent);
  });
}
