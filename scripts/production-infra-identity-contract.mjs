import {
  APPLY_WORKFLOWS,
  GENERIC_PROVIDER_CONDITION,
  PRODUCTION_PROVIDER_CONDITION,
  REFRESH_PROVIDER_CONDITION,
  SERVICE_AND_DRIFT_WORKFLOWS,
} from "./production-infra-identity-contract-constants.mjs";
import { terraformTopLevelBlocks } from "./production-infra-identity-contract-hcl.mjs";
import {
  validateGithubVariables,
  validateIdentityReferenceInventory,
  validateProductionIdentity,
  validateProvider,
  validateProviderInventory,
} from "./production-infra-identity-contract-identity.mjs";
import { validateIamGrantSinkInventory } from "./production-infra-identity-contract-iam.mjs";
import { validateRefreshIdentity } from "./production-infra-identity-contract-refresh.mjs";
import { validateWorkflowContract } from "./production-infra-identity-contract-workflow.mjs";

function validateIdentityContract(files, completeInventory) {
  const errors = [];
  const topLevelBlocks = terraformTopLevelBlocks(files, errors);
  const blocks = topLevelBlocks.filter((block) => block.kind === "resource");
  validateProviderInventory(blocks, errors);
  validateIamGrantSinkInventory(
    files,
    topLevelBlocks,
    errors,
    completeInventory,
  );
  validateProvider(
    blocks,
    {
      poolName: "github_actions",
      poolId: "github-actions",
      providerName: "github",
      providerCondition: GENERIC_PROVIDER_CONDITION,
      conditionLabel: "terraform: generic GitHub WIF provider",
    },
    errors,
  );
  validateProvider(
    blocks,
    {
      poolName: "github_production_infra",
      poolId: "github-production-infra",
      providerName: "github_production_infra",
      providerCondition: PRODUCTION_PROVIDER_CONDITION,
      conditionLabel: "terraform: production WIF provider",
    },
    errors,
  );
  validateProvider(
    blocks,
    {
      poolName: "github_terraform_refresh",
      poolId: "github-terraform-refresh",
      providerName: "github_terraform_refresh",
      providerCondition: REFRESH_PROVIDER_CONDITION,
      conditionLabel: "terraform: refresh WIF provider",
      attributeMapping: {
        "google.subject": "assertion.sub",
        "attribute.repository": "assertion.repository",
        "attribute.repository_id": "assertion.repository_id",
        "attribute.ref": "assertion.ref",
        "attribute.workflow_ref": "assertion.workflow_ref",
      },
    },
    errors,
  );
  validateProductionIdentity(blocks, errors);
  validateRefreshIdentity(files, blocks, errors);
  validateGithubVariables(blocks, errors);
  validateIdentityReferenceInventory(files, topLevelBlocks, errors);
  validateWorkflowContract(files, errors);
  return errors;
}

export function validateProductionInfraIdentityContract(files) {
  return validateIdentityContract(files, false);
}

export function assertProductionInfraIdentityContract(files) {
  const errors = validateIdentityContract(files, true);
  if (errors.length > 0) {
    throw new Error(
      `Production infrastructure identity contract failed:\n- ${errors.join("\n- ")}`,
    );
  }
}

export const productionInfraIdentityContractPaths = {
  applyWorkflows: APPLY_WORKFLOWS,
  serviceAndDriftWorkflows: SERVICE_AND_DRIFT_WORKFLOWS,
};
