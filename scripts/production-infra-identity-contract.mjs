import {
  APPLY_WORKFLOWS,
  GENERIC_PROVIDER_CONDITION,
  PRODUCTION_PROVIDER_CONDITION,
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
import { validateRefreshIdentity } from "./production-infra-identity-contract-refresh.mjs";
import { validateWorkflowContract } from "./production-infra-identity-contract-workflow.mjs";

export function validateProductionInfraIdentityContract(files) {
  const errors = [];
  const topLevelBlocks = terraformTopLevelBlocks(files, errors);
  const blocks = topLevelBlocks.filter((block) => block.kind === "resource");
  validateProviderInventory(blocks, errors);
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
  validateProductionIdentity(blocks, errors);
  validateRefreshIdentity(files, blocks, errors);
  validateGithubVariables(blocks, errors);
  validateIdentityReferenceInventory(files, topLevelBlocks, errors);
  validateWorkflowContract(files, errors);
  return errors;
}

export function assertProductionInfraIdentityContract(files) {
  const errors = validateProductionInfraIdentityContract(files);
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
