import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { dump, load } from "js-yaml";
import {
  checkStructuralRepository,
  hasProtectedMainSaveGuard,
} from "./check-pr-validation-boundary.mjs";

const ACTION = ".github/actions/pnpm-install/action.yml";
const CACHE_HASH =
  "hashFiles('pnpm-lock.yaml', 'pnpm-workspace.yaml', '**/.npmrc', 'package.json', '.node-version')";
const ORDER = [
  { uses: "pnpm/action-setup@" },
  { uses: "actions/setup-node@" },
  { name: "Prepare pnpm store target" },
  { name: "Restore pnpm store" },
  { name: "Clear incomplete pnpm store restore" },
  { name: "Verify pnpm store target" },
  { name: "Install dependencies" },
  { name: "Save pnpm store" },
];

function label(selector) {
  return selector.name ?? selector.uses;
}

function indexOf(steps, selector) {
  return steps.findIndex(
    (step) =>
      (selector.name !== undefined && step.name === selector.name) ||
      (selector.uses !== undefined &&
        String(step.uses ?? "").startsWith(selector.uses)),
  );
}

function mutateAction(root, mutate, expected, message) {
  const path = join(root, ACTION);
  const original = readFileSync(path, "utf8");
  const action = load(original);
  assert(Array.isArray(action?.runs?.steps), "pnpm action has steps");
  mutate(action.runs.steps, action);
  let violations;
  try {
    writeFileSync(path, dump(action, { lineWidth: -1, noRefs: true }));
    violations = checkStructuralRepository(root).join("\n");
  } finally {
    writeFileSync(path, original);
  }
  assert.match(violations, expected, message);
}

export function registerPnpmTests(fixture, mutateOnce) {
  test("cache saves require an exact protected-main push", () => {
    const cases = [
      [
        "github.event_name == 'push' && github.ref == 'refs/heads/main' && cache != 'true'",
        true,
      ],
      ["github.ref == 'refs/heads/main'", false],
      ["github.event_name == 'push' || github.ref == 'refs/heads/main'", false],
    ];
    for (const [condition, expected] of cases)
      assert.equal(hasProtectedMainSaveGuard(condition), expected);
  });

  test("the protected-main writer remains direct and reachable", () => {
    const root = fixture();
    assert.deepEqual(checkStructuralRepository(root), []);
    // prettier-ignore
    const mutations = [
      [".github/workflows/ci.yml", "  push:\n    branches: [main]", "  push:\n    branches: [release]", /reachable on every protected-main push/u],
      [".github/workflows/ci.yml", "  group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}", "  group: ${{ github.workflow }}", /reachable on every protected-main push/u],
      [".github/workflows/ci.yml", "  production-infra-contract:\n    name: Production infrastructure contract", "  production-infra-contract:\n    name: Production infrastructure contract\n    needs: changes", /direct dependency-free x64 pnpm cache writer/u],
      [".github/workflows/ci.yml", "  production-infra-contract:\n    name: Production infrastructure contract", "  production-infra-contract:\n    name: Production infrastructure contract\n    environment: production", /direct dependency-free x64 pnpm cache writer/u],
      [".github/workflows/ci.yml", "      - uses: ./.github/actions/pnpm-install\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", "      - name: Fail before cache writer\n        run: exit 1\n      - uses: ./.github/actions/pnpm-install\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", /direct dependency-free x64 pnpm cache writer/u],
      [".github/workflows/ci.yml", "          persist-credentials: false\n      - uses: ./.github/actions/pnpm-install\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", "          persist-credentials: false\n          path: nested\n      - uses: ./.github/actions/pnpm-install\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", /direct dependency-free x64 pnpm cache writer/u],
      [".github/workflows/ci.yml", "      - uses: ./.github/actions/pnpm-install\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", "      - uses: ./.github/actions/pnpm-install\n        env:\n          CI: false\n        with:\n          write-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}", /direct dependency-free x64 pnpm cache writer/u],
      [".github/actions/resolve-eslint-baseline/action.yml", "  steps:\n    - shell: bash", "  steps:\n    - uses: ./.github/actions/pnpm-install\n      with:\n        write-cache: true\n    - shell: bash", /called directly from workflow jobs/u],
    ];
    for (const mutation of mutations) mutateOnce(root, ...mutation);
  });

  test("pnpm cache order and key drift fail closed", () => {
    const root = fixture();
    assert.deepEqual(checkStructuralRepository(root), []);
    for (let edge = 0; edge < ORDER.length - 1; edge += 1) {
      mutateAction(
        root,
        (steps) => {
          const left = indexOf(steps, ORDER[edge]);
          const right = indexOf(steps, ORDER[edge + 1]);
          assert(
            left >= 0 && right >= 0,
            "the accepted action contains both ordered steps",
          );
          [steps[left], steps[right]] = [steps[right], steps[left]];
        },
        /setup-to-save order/u,
        `${label(ORDER[edge])} must stay before ${label(ORDER[edge + 1])}`,
      );
    }
    mutateAction(
      root,
      (steps) => {
        for (const step of steps.filter((item) =>
          /^actions\/cache\/(?:restore|save)@/u.test(String(item.uses ?? "")),
        ))
          step.with.key = step.with.key.replace(
            CACHE_HASH,
            "hashFiles('pnpm-lock.yaml')",
          );
      },
      /matching toolchain-bound key/u,
      "the exact key includes pnpm and Node identity",
    );
    mutateAction(
      root,
      (steps) => {
        const save = steps.find((step) =>
          String(step.uses ?? "").startsWith("actions/cache/save@"),
        );
        save.with.key += "-mismatch";
      },
      /matching toolchain-bound key/u,
      "restore and save keys match exactly",
    );
    mutateAction(
      root,
      (steps) => {
        for (const step of steps.filter((item) =>
          /^actions\/cache\/(?:restore|save)@/u.test(String(item.uses ?? "")),
        ))
          step.with.key = step.with.key.replace("'pnpm-workspace.yaml', ", "");
      },
      /key includes pnpm-workspace\.yaml/u,
      "the exact key includes pnpm workspace configuration",
    );
    mutateAction(
      root,
      (steps) => {
        for (const step of steps.filter((item) =>
          /^actions\/cache\/(?:restore|save)@/u.test(String(item.uses ?? "")),
        ))
          step.with.key = step.with.key.replace(", '**/.npmrc'", "");
      },
      /matching toolchain-bound key/u,
      "the exact key includes repository pnpm configuration",
    );
    for (const [message, mutate] of [
      [
        "pnpm version overrides are forbidden",
        (steps) => {
          steps[indexOf(steps, ORDER[0])].with.version = "10.0.0";
        },
      ],
      [
        "alternate pnpm package manifests are forbidden",
        (steps) => {
          steps[indexOf(steps, ORDER[0])].with.package_json_file = "other.json";
        },
      ],
      [
        "literal Node version overrides are forbidden",
        (steps) => {
          const setup = steps[indexOf(steps, ORDER[1])];
          delete setup.with["node-version-file"];
          setup.with["node-version"] = "22";
        },
      ],
      [
        "duplicate Node setup steps are forbidden",
        (steps) => {
          const index = indexOf(steps, ORDER[1]);
          steps.splice(index, 0, structuredClone(steps[index]));
        },
      ],
      [
        "cache writes stay opt-in",
        (_steps, action) => {
          action.inputs["write-cache"].default = "true";
        },
      ],
    ])
      mutateAction(
        root,
        mutate,
        /hashed package.json and \.node-version toolchain sources/u,
        message,
      );
    for (const name of [
      "Prepare pnpm store target",
      "Verify pnpm store target",
      "Install dependencies",
    ]) {
      mutateAction(
        root,
        (steps) => {
          steps[indexOf(steps, { name })]["continue-on-error"] = true;
        },
        /required steps unconditional and fatal/u,
        `${name} must remain fatal`,
      );
      mutateAction(
        root,
        (steps) => {
          steps[indexOf(steps, { name })].if = "${{ false }}";
        },
        /required steps unconditional and fatal/u,
        `${name} must remain unconditional`,
      );
    }
    for (const name of [
      "Prepare pnpm store target",
      "Clear incomplete pnpm store restore",
      "Verify pnpm store target",
      "Install dependencies",
    ])
      mutateAction(
        root,
        (steps) => {
          steps[indexOf(steps, { name })].shell =
            "env PNPM_HOME=/tmp/other bash {0}";
        },
        /reviewed run steps to use bash/u,
        `${name} must retain the reviewed shell`,
      );
    mutateAction(
      root,
      (steps) => {
        steps[indexOf(steps, { name: "Restore pnpm store" })].if =
          "${{ false }}";
      },
      /restore must be unconditional/u,
      "cache restore must remain unconditional",
    );
    mutateAction(
      root,
      (steps) => {
        const save = steps[indexOf(steps, { name: "Save pnpm store" })];
        save.if += " && false";
      },
      /exact protected-main-miss condition/u,
      "cache save must retain its exact liveness condition",
    );
    mutateAction(
      root,
      (steps) => {
        steps[
          indexOf(steps, {
            name: "Clear incomplete pnpm store restore",
          })
        ]["continue-on-error"] = true;
      },
      /cleanup that remains fatal/u,
      "incomplete restore cleanup must remain fatal",
    );
    mutateAction(
      root,
      (steps) => {
        steps[indexOf(steps, { name: "Restore pnpm store" })].id = "other";
        steps[indexOf(steps, { name: "Prepare pnpm store target" })].id =
          "pnpm-cache";
      },
      /restore action must own the sole pnpm-cache id/u,
      "the cache output ID must stay on the restore action",
    );
    mutateAction(
      root,
      (steps) => {
        const verify = indexOf(steps, { name: "Verify pnpm store target" });
        steps.splice(verify + 1, 0, {
          name: "Override pnpm store",
          shell: "bash",
          run: "pnpm config set store-dir /tmp/other",
        });
      },
      /exact eight-step sequence/u,
      "no internal step may override pnpm configuration after verification",
    );
    mutateAction(
      root,
      (steps) => {
        steps[indexOf(steps, { name: "Restore pnpm store" })].with[
          "lookup-only"
        ] = true;
      },
      /exact eight-step sequence, keys, and cache inputs/u,
      "restore must extract the cache instead of reporting a lookup-only hit",
    );
    mutateAction(
      root,
      (steps) => {
        steps[indexOf(steps, { name: "Install dependencies" })][
          "working-directory"
        ] = "ui-dashboard";
      },
      /exact eight-step sequence, keys, and cache inputs/u,
      "install must run from the composite caller workspace",
    );
    writeFileSync(join(root, ".npmrc"), "store-dir=/tmp/other\n");
    assert.match(
      checkStructuralRepository(root).join("\n"),
      /dependency roots, configuration, workflow definitions, and action definitions/u,
      "dependency-root .npmrc cannot redirect the pnpm store",
    );
  });
}
