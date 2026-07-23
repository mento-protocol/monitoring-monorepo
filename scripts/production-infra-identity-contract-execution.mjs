import { createHash } from "node:crypto";
import path from "node:path";
import {
  blockKey,
  stringAttribute,
  topLevelBlockKey,
} from "./production-infra-identity-contract-hcl.mjs";
import { validateTerraformSourceSurfaces } from "./production-infra-identity-contract-surfaces.mjs";

const EXECUTION_BLOCK_SHAPE_SPECIFICATIONS = [
  "alerts/infra/onchain-event-handler/local-dotenv-file.tf:terraform_data.env_file|22f732bd0222adbcdc2ede7f02062c342ac8e5702f9384f4550cef142848d0fd",
  "alerts/infra/onchain-event-listeners/main.tf:null_resource.pause_webhook_before_update|f5b86ba2e2be2c7f0460380e0c91a0e2d48e7876c3355ab212211b4ad68b3975",
  "alerts/infra/onchain-event-listeners/main.tf:null_resource.pause_webhook_on_destroy|7caa7afc423d30f0342b969884e7bf486046ae0cdd7b2c3a37ff777c9f5ace24",
];

const EXECUTION_FILE_SHAPE_SPECIFICATIONS = [
  "alerts/infra/scripts/common.sh|935c7d27e22ce8a4ada56a12dc2cacdda87b2c22e609faf9050f795393b4877c",
  "alerts/infra/scripts/manage-quicknode-webhook.sh|0f0b6e0f50f66885e0d371e5ab576ea7e259e4e2f809e0dfc9ed2f7d1e547379",
  "alerts/infra/scripts/spinner.sh|de08da94de5983d9e9d09962761e9f1707d9d79ac49cc91a8241196ecbf422a7",
];

const EXECUTION_FILES_BY_BLOCK = new Map([
  [
    "alerts/infra/onchain-event-listeners/main.tf:null_resource.pause_webhook_before_update",
    [
      "alerts/infra/scripts/common.sh",
      "alerts/infra/scripts/manage-quicknode-webhook.sh",
      "alerts/infra/scripts/spinner.sh",
    ],
  ],
  [
    "alerts/infra/onchain-event-listeners/main.tf:null_resource.pause_webhook_on_destroy",
    ["alerts/infra/scripts/manage-quicknode-webhook.sh"],
  ],
]);

const ARBITRARY_HTTP_BLOCK_SHAPE_SPECIFICATIONS = [
  "alerts/infra/channels/sentry-bridge/slack_channels.tf:restapi_object.sentry_slack_channel|d51816fa0d47a37525db23b4cf2b7dc1d513e51eeaab5f5e6e005db2aff58ad8",
  "alerts/infra/channels/sentry-bridge/slack_channels.tf:restapi_object.sentry_slack_channel_member|7be9fe324b35c84fac70d53e6e391139a00dc59f295d4f0bc831ef7db2108fde",
  "alerts/infra/channels/slack-channels/main.tf:restapi_object.channel|ab6c749084edee07cc0a6a76a8c8f464a9bf7ec63710f7b81fc9ebe898294b00",
  "alerts/infra/channels/slack-channels/main.tf:restapi_object.channel_member|b2608921d3288dad2667088d69167e2f7fc256980370ea0914ed4e3d8553af43",
  "alerts/infra/ci-failures-channel.tf:data.http.slack_eng_usergroup_members|f4b97b9262797aed6db70b80cd826578b7f80d6309ee8061b3aadf10f7c3a80d",
  "alerts/infra/ci-failures-channel.tf:data.http.slack_usergroups_list|fc3a98fbe55e1537e1e272cc12fd45ea97bd9dd92a75f6fa6b4ef75d98e5f24b",
  "alerts/infra/ci-failures-channel.tf:restapi_object.ci_failures_channel|29d4af38f3fc629a2bb7e67aee05c62332beedfada399138cb3eb5cf2e28172b",
  "alerts/infra/ci-failures-channel.tf:restapi_object.ci_failures_channel_member|4f118c11ae6a5c173a43a020782ae490c2685f38b15ae41f225ecdc9d04cacff",
  "alerts/infra/ci-failures-channel.tf:restapi_object.ci_failures_invite_eng|e601b9798eeac0d0f56529c4d03d93d395784fb0361525887d09ecccbb1aedb6",
  "alerts/infra/onchain-event-listeners/main.tf:restapi_object.multisig_webhook|bd85db33605fd51a6f269c80547daab7c1c010998c6529325f259df92fab49b0",
  "alerts/infra/providers.tf:provider.restapi.quicknode|90ac712a36e6674df8c8362fde76c2e36a2eeee3ed9af2a6cd1b8e38bc3a7f4b",
  "alerts/infra/providers.tf:provider.restapi.slack|8b4bc87d91939de3aab9a7286ca993d5bf86856916c5452737b1ef97483853ee",
  "governance-watchdog/infra/quicknode.tf:restapi_object.quicknode_webhook_governor|386d22a3358f747734e05a5e222b775f126892b4f2054a35be92f04c55195c48",
  "governance-watchdog/infra/quicknode.tf:restapi_object.quicknode_webhook_healthcheck|b1578a17d5ff5d6940a6a01bad97d29e307da270d01a70bdc40ed667891bf620",
  "governance-watchdog/infra/versions.tf:provider.restapi.default|769263b893b2f9d0cff6851abda5a3c600668cbe032d3c38375b24ed50b1e9b7",
];

function buildShapeRegistry(specifications, label) {
  const registry = new Map();
  for (const specification of specifications) {
    const separator = specification.lastIndexOf("|");
    const key = specification.slice(0, separator);
    const hashes = specification.slice(separator + 1).split(",");
    if (
      separator < 1 ||
      hashes.some((hash) => !/^[0-9a-f]{64}$/u.test(hash)) ||
      registry.has(key)
    ) {
      throw new Error(`invalid ${label} shape registry entry: ${key}`);
    }
    registry.set(key, new Set(hashes));
  }
  return registry;
}

const EXPECTED_EXECUTION_BLOCK_SHAPES = buildShapeRegistry(
  EXECUTION_BLOCK_SHAPE_SPECIFICATIONS,
  "imperative Terraform execution block",
);
const EXPECTED_EXECUTION_FILE_SHAPES = buildShapeRegistry(
  EXECUTION_FILE_SHAPE_SPECIFICATIONS,
  "imperative Terraform dependency",
);
const EXPECTED_ARBITRARY_HTTP_BLOCK_SHAPES = buildShapeRegistry(
  ARBITRARY_HTTP_BLOCK_SHAPE_SPECIFICATIONS,
  "arbitrary HTTP mutation block",
);

function contentShape(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function executionBlockKey(block) {
  return block.kind === "resource" ? blockKey(block) : topLevelBlockKey(block);
}

function arbitraryHttpBlockKey(block) {
  if (block.kind === "provider") {
    return `${block.filePath}:provider.restapi.${stringAttribute(block, "alias") ?? "default"}`;
  }
  return block.kind === "resource" ? blockKey(block) : topLevelBlockKey(block);
}

function reportMissingInventory(
  blocksByKey,
  registry,
  label,
  errors,
  completeInventory,
) {
  if (!completeInventory) return;
  const missing = [...registry.keys()]
    .filter((key) => !blocksByKey.has(key))
    .sort();
  if (missing.length > 0) {
    errors.push(`${label} are missing: ${missing.join(", ")}`);
  }
}

function validateArbitraryHttpInventory(blocks, errors, completeInventory) {
  const blocksByKey = Map.groupBy(blocks, arbitraryHttpBlockKey);
  const duplicates = [...blocksByKey]
    .filter(([, matching]) => matching.length > 1)
    .map(([key]) => key)
    .sort();
  if (duplicates.length > 0) {
    errors.push(
      `arbitrary HTTP mutation blocks must be declared at most once: ${duplicates.join(", ")}`,
    );
  }
  const unregistered = new Set();
  for (const block of blocks) {
    const key = arbitraryHttpBlockKey(block);
    const expected = EXPECTED_ARBITRARY_HTTP_BLOCK_SHAPES.get(key);
    if (expected === undefined) {
      unregistered.add(key);
    } else {
      const actual = contentShape(block.text);
      if (!expected.has(actual)) {
        errors.push(
          `${key}: arbitrary HTTP mutation blocks must match its exact audited shape (found ${actual})`,
        );
      }
    }
  }
  if (unregistered.size > 0) {
    errors.push(
      `terraform: unregistered arbitrary HTTP mutation blocks are forbidden: ${[...unregistered].sort().join(", ")}`,
    );
  }
  reportMissingInventory(
    blocksByKey,
    EXPECTED_ARBITRARY_HTTP_BLOCK_SHAPES,
    "arbitrary HTTP mutation blocks",
    errors,
    completeInventory,
  );
}

function validateExecutionBlockInventory(blocks, errors, completeInventory) {
  const blocksByKey = Map.groupBy(blocks, executionBlockKey);
  const duplicates = [...blocksByKey]
    .filter(([, matching]) => matching.length > 1)
    .map(([key]) => key)
    .sort();
  if (duplicates.length > 0) {
    errors.push(
      `imperative Terraform execution blocks must be declared at most once: ${duplicates.join(", ")}`,
    );
  }

  const unregistered = new Set();
  for (const block of blocks) {
    const key = executionBlockKey(block);
    const expected = EXPECTED_EXECUTION_BLOCK_SHAPES.get(key);
    if (expected === undefined) {
      unregistered.add(key);
    } else {
      const actual = contentShape(block.text);
      if (!expected.has(actual)) {
        errors.push(
          `${key}: imperative Terraform execution blocks must match its exact audited shape (found ${actual})`,
        );
      }
    }
  }
  if (unregistered.size > 0) {
    errors.push(
      `terraform: unregistered imperative Terraform execution blocks are forbidden: ${[...unregistered].sort().join(", ")}`,
    );
  }
  reportMissingInventory(
    blocksByKey,
    EXPECTED_EXECUTION_BLOCK_SHAPES,
    "imperative Terraform execution blocks",
    errors,
    completeInventory,
  );
}

function validateExecutionFiles(files, blocks, errors, completeInventory) {
  const requiredFiles = completeInventory
    ? new Set(EXPECTED_EXECUTION_FILE_SHAPES.keys())
    : new Set(
        blocks.flatMap(
          (block) => EXECUTION_FILES_BY_BLOCK.get(blockKey(block)) ?? [],
        ),
      );
  for (const filePath of requiredFiles) {
    const contents = files[filePath];
    if (typeof contents !== "string") {
      errors.push(
        `${filePath}: required imperative Terraform dependency is missing`,
      );
      continue;
    }
    const actual = contentShape(contents);
    if (!EXPECTED_EXECUTION_FILE_SHAPES.get(filePath)?.has(actual)) {
      errors.push(
        `${filePath}: imperative Terraform dependency must match its exact audited shape (found ${actual})`,
      );
    }
  }
}

function isAutomaticVariableFile(filePath) {
  const basename = path.posix.basename(filePath);
  return (
    basename === "terraform.tfvars" ||
    basename === "terraform.tfvars.json" ||
    /\.auto\.tfvars(?:\.json)?$/u.test(basename)
  );
}

export function validateTerraformExecutionSurfaces(
  files,
  blocks,
  errors,
  completeInventory = false,
) {
  validateTerraformSourceSurfaces(blocks, errors, completeInventory);
  // Match every provisioner label before decoding it. This catches equivalent
  // HCL spellings such as "local\u002dexec" and fails closed on future types.
  const executionBlocks = blocks.filter((block) =>
    /(?:^|\n)[ \t]*provisioner\s+"(?:[^"\\]|\\.)*"\s*\{/u.test(block.code),
  );
  validateExecutionBlockInventory(executionBlocks, errors, completeInventory);
  validateExecutionFiles(
    files,
    executionBlocks.filter((block) =>
      EXPECTED_EXECUTION_BLOCK_SHAPES.has(executionBlockKey(block)),
    ),
    errors,
    completeInventory,
  );

  const arbitraryHttpBlocks = blocks.filter(
    (block) =>
      (block.kind === "resource" && block.type === "restapi_object") ||
      (block.kind === "data" && block.labels[0] === "http") ||
      (block.kind === "provider" && block.labels[0] === "restapi"),
  );
  validateArbitraryHttpInventory(
    arbitraryHttpBlocks,
    errors,
    completeInventory,
  );

  const externalDataExecutions = blocks
    .filter((block) => block.kind === "data" && block.labels[0] === "external")
    .map(topLevelBlockKey)
    .sort();
  if (externalDataExecutions.length > 0) {
    errors.push(
      `terraform: external data execution is forbidden: ${externalDataExecutions.join(", ")}`,
    );
  }

  const serviceAccountKeys = blocks
    .filter(
      (block) =>
        block.kind === "resource" &&
        block.type === "google_service_account_key",
    )
    .map(blockKey)
    .sort();
  if (serviceAccountKeys.length > 0) {
    errors.push(
      `terraform: service-account credential grant resources are forbidden unless explicitly audited: ${serviceAccountKeys.join(", ")}`,
    );
  }

  const automaticVariableFiles = Object.keys(files)
    .filter(isAutomaticVariableFile)
    .sort();
  if (automaticVariableFiles.length > 0) {
    errors.push(
      `terraform: checked-in automatic variable files are forbidden: ${automaticVariableFiles.join(", ")}`,
    );
  }
}
