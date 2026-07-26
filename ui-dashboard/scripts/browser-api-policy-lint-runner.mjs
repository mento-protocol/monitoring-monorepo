import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";

const DASHBOARD_ROOT_URL = new URL("../", import.meta.url);
const POLICY_RULE_ID = "browser-api-policy/no-unsupported-receiver-property";
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
const DESTRUCTURED_BLOCKED_SOURCE = `
  const { toSorted } = Array.prototype;
  const { toReversed } = new Uint8Array([3, 1]);
  const { isWellFormed: validateString } = String.prototype;
  toSorted.call([3, 1]);
  toReversed.call(new Uint8Array([3, 1]));
  validateString.call("value");
`;
const STATIC_BLOCKED_SOURCE = `
  const BuiltinObject = Object;
  const BuiltinMap = Map;
  Object.groupBy([1], String);
  Map.groupBy([1], String);
  BuiltinObject.groupBy([1], String);
  BuiltinMap.groupBy([1], String);
  globalThis.Object.groupBy([1], String);
  globalThis.Map.groupBy([1], String);
  const { groupBy: groupObjects } = Object;
  const { groupBy: groupMaps } = globalThis.Map;
  groupObjects([1], String);
  groupMaps([1], String);
`;
const STATIC_ALLOWED_SOURCE = `
  export {};

  const Object = { groupBy() {} };
  const Map = { groupBy() {} };
  const CustomObject = Object;
  const CustomMap = Map;
  Object.groupBy();
  Map.groupBy();
  CustomObject.groupBy();
  CustomMap.groupBy();

  const customGlobal = { Object, Map };
  customGlobal.Object.groupBy();
  customGlobal.Map.groupBy();
  const { groupBy: groupObjects } = Object;
  const { groupBy: groupMaps } = customGlobal.Map;
  groupObjects();
  groupMaps();
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
  destructuredBlocked: {
    filePath: "src/lib/tag-suggestions.ts",
    source: DESTRUCTURED_BLOCKED_SOURCE,
  },
  staticBlocked: {
    filePath: "src/lib/address-reports-shared.ts",
    source: STATIC_BLOCKED_SOURCE,
  },
  staticAllowed: {
    filePath: "src/lib/address-label-fields.ts",
    source: STATIC_ALLOWED_SOURCE,
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

      const customCollection = { toSorted() {} };
      const { toSorted: customSort } = customCollection;
      customSort();
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
      .filter(({ ruleId }) => ruleId === POLICY_RULE_ID)
      .map(({ ruleId, message }) => ({ ruleId, message })),
  ]);
}
const results = Object.fromEntries(resultEntries);

process.stdout.write(JSON.stringify(results));
