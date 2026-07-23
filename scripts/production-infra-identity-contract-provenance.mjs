import { createHash } from "node:crypto";
import path from "node:path";
import { attributeExpression } from "./production-infra-identity-contract-hcl.mjs";

// These are the complete var.* and local.* source closure for the audited IAM
// grant sinks, module calls, and service-account identity sources. External
// tfvar values remain deployment inputs, but source defaults, validation, and
// indirection are immutable unless this registry is deliberately updated.
const SOURCE_BLOCK_SHAPE_SPECIFICATIONS = [
  "aegis/terraform:variable.grafana_service_account_token|24069e465ae3350a94c66f8a86e7621e3daac29a1bff0dc712df81188eeb619c",
  "alerts/infra:local.common_labels|e4ef4e31e239e0f74e116f6c4f7350d6d9839a519516ddc8b1ab9536742fc9e8",
  "alerts/infra:local.multisigs_by_chain|e4ef4e31e239e0f74e116f6c4f7350d6d9839a519516ddc8b1ab9536742fc9e8",
  "alerts/infra:local.multisigs_by_chain_network|e4ef4e31e239e0f74e116f6c4f7350d6d9839a519516ddc8b1ab9536742fc9e8",
  "alerts/infra:local.oncall_announcer_api_id_configured|e056cd34b0819c3feabb316f57a0244959ad31a4d41c344f1abbb2d482110b4f",
  "alerts/infra:local.oncall_announcer_api_key_configured|e056cd34b0819c3feabb316f57a0244959ad31a4d41c344f1abbb2d482110b4f",
  "alerts/infra:local.oncall_announcer_enabled|e056cd34b0819c3feabb316f57a0244959ad31a4d41c344f1abbb2d482110b4f",
  "alerts/infra:local.oncall_announcer_missing_channel_id|e056cd34b0819c3feabb316f57a0244959ad31a4d41c344f1abbb2d482110b4f",
  "alerts/infra:local.oncall_announcer_missing_usergroup_id|e056cd34b0819c3feabb316f57a0244959ad31a4d41c344f1abbb2d482110b4f",
  "alerts/infra:local.oncall_announcer_partially_configured|e056cd34b0819c3feabb316f57a0244959ad31a4d41c344f1abbb2d482110b4f",
  "alerts/infra:local.oncall_slack_channel_id|e056cd34b0819c3feabb316f57a0244959ad31a4d41c344f1abbb2d482110b4f",
  "alerts/infra:local.project_id|e4ef4e31e239e0f74e116f6c4f7350d6d9839a519516ddc8b1ab9536742fc9e8",
  "alerts/infra:local.support_engineer_usergroup_id|e0542cc48f78803f05faca89a9701ee99b631019061c10c39d76be3fe2b48c41",
  "alerts/infra:local.terraform_refresh_readonly_project_roles|27a3fb7a52a89d42c0b2020bffb15d4c32e2c10e6d7eb998ff43d0d0c1cadb07",
  "alerts/infra:variable.additional_labels|4ae18124b5969f2c78efbea24d14fb0c06550c61856d6554a12020d71c505c9c",
  "alerts/infra:variable.billing_account|2b836d24d4666d7376af5aafaf17b1094a7f05e2ceccbe19860941af9436fd45",
  "alerts/infra:variable.debug_mode|f52b2ce0bd99f8f263fda1fbc5aac0e9b5bce445d603fc45a4d5ec0ac4f472ce",
  "alerts/infra:variable.multisigs|bc6efbb0d5eb414139081182fac6f93647f32b822e9bbd08bc2c17209bce2f29",
  "alerts/infra:variable.oncall_announce_on_first_run|e36344bd00f1f50834bd9243d1c4e059bdb52da9c090c5f1f3876ca6950557bb",
  "alerts/infra:variable.oncall_rotation_check_schedule|0019df3ba1482127d81c064fe39e4b8d01f1217602baca2aa6e3e0aaed40a916",
  "alerts/infra:variable.oncall_slack_channel_id|de5843b9c72d3b4400b1df21867ca03b969020399514940324fd68c750bc89a6",
  "alerts/infra:variable.oncall_support_usergroup_id|db9c2eea4c309b047d059b9768699fcce95c73be8335360e06872c4111062e89",
  "alerts/infra:variable.org_id|9f4baa3184507cb57b60f341f8a8bd31877289b78cc638e67709406c677f6602",
  "alerts/infra:variable.project_name|f951d1cd861531aa1dc012f0b6c7feccf75a79661162c85ad210590c072caf6e",
  "alerts/infra:variable.quicknode_api_key|eb47592c0969d91dec66c730b9e9a989bf206b1d5b962d102c52e6376c0d4fa7",
  "alerts/infra:variable.quicknode_signing_secret|5836ac0da04de8e8dc1e77c99dff987175f553dd25d09f009f4a710076bce8d2",
  "alerts/infra:variable.region|089575f5639e85f54221eebe10dc8af9a5a6aac4ae02a354299950723851ed06",
  "alerts/infra:variable.sentry_organization_slug|984e88d258f8090cff6d69e00024ed548516f16981275d831d3861b39d8481e0",
  "alerts/infra:variable.sentry_slack_critical_channel|00143710d7e670a7cc4f31d8bd51dd08e8219ad4bdd3bf83c250c49f781ba943",
  "alerts/infra:variable.sentry_slack_critical_channel_id|d497a3cb42291b8f7e876f9be97aa05fd262ad3ed77ac31913a2dbfb75474ddd",
  "alerts/infra:variable.sentry_slack_workspace_name|be4856a7e02481d751c65fd28905fbaa020d019ac551783ac525504d4b95c599",
  "alerts/infra:variable.slack_bot_token|292883d2c0f531fede82af7a870527ab33a74ef0e6aebf01f0c1a259bdd57643",
  "alerts/infra:variable.splunk_on_call_api_base_url|061657a43a1bcfbfc17e8cbed9e9ad71644281c40be642000a317bf6f00da0d8",
  "alerts/infra:variable.splunk_on_call_api_id|b2ad53f49f4b04c3028eba0daa373fd3ede406ac106b8e22299925665c49a905",
  "alerts/infra:variable.splunk_on_call_api_key|92c810c147df774c164beb7bea42f04e8725528d76e2daf2387988268a57df02",
  "alerts/infra:variable.splunk_on_call_escalation_policy_slug|c8bc88de82cba93b2d606d2a29d6b7a81c2a06e6f2756fb26c0fdb676d409a9d",
  "alerts/infra:variable.splunk_on_call_team_slug|b9a7c2b035ff0a552c2aab0463838fddc5753a552c54bd9cb11098742a44badf",
  "alerts/infra/oncall-announcer:variable.project_id|f602de8aac72c79cc9603edb54bf1852ed59471f1b02abbf5249f186aa4926d7",
  "alerts/infra/oncall-announcer:variable.project_service_account_email|52a5ca1c5077d4fa53a223219927f4a1f211d492e723ccae8fb66935f7ab4b99",
  "alerts/infra/oncall-announcer:variable.region|54acbf8f33f8cb328e0c4005b3e05d2b6233cbe856500f4d38ee7b2a2cf32c0f",
  "alerts/infra/onchain-event-handler:variable.project_id|f602de8aac72c79cc9603edb54bf1852ed59471f1b02abbf5249f186aa4926d7",
  "alerts/infra/onchain-event-handler:variable.project_service_account_email|21b32fac847877d6db1405b1d0a312448e6725022e076d0aabed53bf06b74f65",
  "alerts/infra/onchain-event-handler:variable.region|8a91ffd644a8da625e1ec824508fc1effb530b4b5d6b37b685d00af3b0bd4477",
  "governance-watchdog/infra:local.terraform_refresh_readonly_project_roles|27a3fb7a52a89d42c0b2020bffb15d4c32e2c10e6d7eb998ff43d0d0c1cadb07",
  "governance-watchdog/infra:variable.billing_account|61e2f00a229a49febf7687a2c04935b28a12aac14ba468949a76406261381c1a",
  "governance-watchdog/infra:variable.org_id|7a5c139c6c3d17a556f2bb84bfb8e1c583d9a6227f93b26978e2c8c4dec7df32",
  "governance-watchdog/infra:variable.project_name|3f6217c066afb03d42540b28866a4bb7d177571af1b2d96f952ecf478f9b6017",
  "terraform:local.aegis_app_engine_default_service_account|68114d5c586b5e1ad7f83e71d85d49292ac97a493af9b271c815d532bf4cc5ba",
  "terraform:local.agent_readonly_org_roles|f98c173f5f9743fc1bc25a4b666f154cf04ea9fdf109b57c2b12b37491961256",
  "terraform:local.ci_deployer_roles|c0a5e556ec29c3dc3701cbd5bea9da0f1e342b725a994a9580315941d2205696",
  "terraform:local.grafana_agent_cloudbuild_project_roles|68114d5c586b5e1ad7f83e71d85d49292ac97a493af9b271c815d532bf4cc5ba",
  "terraform:local.grafana_agent_cloudbuild_service_accounts|68114d5c586b5e1ad7f83e71d85d49292ac97a493af9b271c815d532bf4cc5ba",
  "terraform:variable.agent_readonly_impersonators|4fcf4928762c3e8301cef20a21cc1fe0e96df244dfba2eb5e7f5ef2017c67bb7",
  "terraform:variable.agent_readonly_storage_object_projects|ed7b4d8a7e1e6e3b16360d5d2941ef6451648d1ee60fbb31219f162a7058593b",
  "terraform:variable.gcp_dev_members|5775d46fc6449d33e2e21992b7fc1e975083d40c0611768a500c34f5c7f774b2",
  "terraform:variable.gcp_org_id|6ec91fd45db313e543458758d709eafd7843406448fe3e73c0b0c8b898c72cef",
  "terraform:variable.terraform_service_account|d024a2372d4aca16e4122a6cbd873c389b5eabfac2e30efad6b5252fca88afbc",
];

function buildSourceRegistry() {
  const registry = new Map();
  for (const specification of SOURCE_BLOCK_SHAPE_SPECIFICATIONS) {
    const separator = specification.lastIndexOf("|");
    const key = specification.slice(0, separator);
    const hash = specification.slice(separator + 1);
    if (separator < 1 || !/^[0-9a-f]{64}$/u.test(hash) || registry.has(key)) {
      throw new Error(`invalid IAM source provenance registry entry: ${key}`);
    }
    registry.set(key, hash);
  }
  return registry;
}

const EXPECTED_SOURCE_SHAPES = buildSourceRegistry();
const EXPECTED_LOCAL_SOURCES = [...EXPECTED_SOURCE_SHAPES]
  .filter(([key]) => key.includes(":local."))
  .map(([key, hash]) => {
    const separator = key.lastIndexOf(":local.");
    return {
      directory: key.slice(0, separator),
      name: key.slice(separator + ":local.".length),
      key,
      hash,
    };
  });

function blockShape(block) {
  return createHash("sha256").update(block.text).digest("hex");
}

function blockDirectory(block) {
  return path.posix.dirname(block.filePath);
}

function variableSourceKey(block) {
  return `${blockDirectory(block)}:variable.${block.name}`;
}

export function validateIamSourceProvenance(
  blocks,
  errors,
  completeInventory = false,
) {
  const reportedShapes = new Set();
  const variableBlocks = blocks.filter((block) => block.kind === "variable");
  const variablesByKey = Map.groupBy(variableBlocks, variableSourceKey);

  for (const [key, matching] of variablesByKey) {
    const expected = EXPECTED_SOURCE_SHAPES.get(key);
    if (expected === undefined) continue;
    if (matching.length > 1) {
      errors.push(`${key}: IAM variable source must be declared at most once`);
    }
    for (const block of matching) {
      const actual = blockShape(block);
      if (actual !== expected) {
        errors.push(
          `${key}: IAM variable source block must match its exact audited shape (found ${actual})`,
        );
      }
    }
  }
  if (completeInventory) {
    const missingVariables = [...EXPECTED_SOURCE_SHAPES.keys()]
      .filter((key) => key.includes(":variable.") && !variablesByKey.has(key))
      .sort();
    if (missingVariables.length > 0) {
      errors.push(
        `IAM variable source blocks are missing: ${missingVariables.join(", ")}`,
      );
    }
  }

  for (const source of EXPECTED_LOCAL_SOURCES) {
    const matching = blocks.filter(
      (block) =>
        block.kind === "locals" &&
        blockDirectory(block) === source.directory &&
        attributeExpression(block, source.name) !== undefined,
    );
    if (matching.length > 1) {
      errors.push(
        `${source.key}: IAM local source must be declared at most once`,
      );
    }
    if (completeInventory && matching.length === 0) {
      errors.push(`${source.key}: IAM local source block is missing`);
    }
    for (const block of matching) {
      const actual = blockShape(block);
      const reportKey = `${block.filePath}:${block.start}:${actual}`;
      if (actual !== source.hash && !reportedShapes.has(reportKey)) {
        reportedShapes.add(reportKey);
        errors.push(
          `${source.key}: IAM local source blocks must match its exact audited shape (found ${actual})`,
        );
      }
    }
  }
}
