import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";

const DASHBOARD_ROOT_URL = new URL("../", import.meta.url);
const POLICY_RULE_IDS = new Set([
  "browser-api-policy/no-unsupported-receiver-property",
  "no-restricted-properties",
]);
const BLOCKED_SOURCE = `
  [3, 1].toSorted();
  [3, 1].toReversed();
  [3, 1].toSpliced(0, 1);
  [3, 1].with(0, 2);
  Object.groupBy([1], String);
  Map.groupBy([1], String);
  "value".isWellFormed();
  "value".toWellFormed();
`;
const TYPED_ARRAY_BLOCKED_SOURCE = `
  const values = new Uint8Array([3, 1]);
  values.toSorted();
  values.toReversed();
  values.with(0, 2);
`;
const cases = {
  blocked: {
    filePath: "src/lib/immutable-sort.ts",
    source: BLOCKED_SOURCE,
  },
  typedArrayBlocked: {
    filePath: "src/lib/peg-monitoring.ts",
    source: TYPED_ARRAY_BLOCKED_SOURCE,
  },
  allowed: {
    filePath: "src/lib/address-report-fields.ts",
    source: `
      export {};

      const values = [1, 2, 3];
      values.at(-1);
      values.findLast((value) => value > 1);
      values.findLastIndex((value) => value > 1);
      values.flatMap((value) => [value]);
      Promise.allSettled([Promise.resolve(1)]);

      const domainObject = {
        toSorted() {},
        toReversed() {},
        toSpliced() {},
        with() {},
        isWellFormed() {},
        toWellFormed() {},
        groupBy() {},
      };
      domainObject.toSorted();
      domainObject.toReversed();
      domainObject.toSpliced();
      domainObject.with();
      domainObject.isWellFormed();
      domainObject.toWellFormed();
      domainObject.groupBy();

      interface Uint8Array {
        toSorted(): void;
        toReversed(): void;
        with(index: number, value: number): void;
      }
      declare const localTypedArray: Uint8Array;
      localTypedArray.toSorted();
      localTypedArray.toReversed();
      localTypedArray.with(0, 2);
    `,
  },
  api: {
    filePath: "src/app/api/address-labels/route.ts",
    source: BLOCKED_SOURCE,
  },
  og: {
    filePath: "src/lib/homepage-og.ts",
    source: BLOCKED_SOURCE,
  },
  test: {
    filePath: "src/lib/__tests__/browser-api-policy.test.ts",
    source: BLOCKED_SOURCE,
  },
};
const eslint = new ESLint({
  cwd: fileURLToPath(DASHBOARD_ROOT_URL),
  overrideConfigFile: fileURLToPath(
    new URL("eslint.config.mjs", DASHBOARD_ROOT_URL),
  ),
});

const resultEntries = [];
for (const [name, fixture] of Object.entries(cases)) {
  const [result] = await eslint.lintText(fixture.source, {
    filePath: fileURLToPath(new URL(fixture.filePath, DASHBOARD_ROOT_URL)),
  });
  if (!result) {
    throw new Error(`ESLint returned no result for ${fixture.filePath}`);
  }
  resultEntries.push([
    name,
    result.messages
      .filter(({ ruleId }) => ruleId && POLICY_RULE_IDS.has(ruleId))
      .map(({ ruleId, message }) => ({ ruleId, message })),
  ]);
}
const results = Object.fromEntries(resultEntries);

process.stdout.write(JSON.stringify(results));
