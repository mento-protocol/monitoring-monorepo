/**
 * GitHub Projects V2 field IO for the issue board.
 *
 * Resolves the project and its Status field, finds or creates the item for an
 * issue, and reads and writes the optional Agent / Branch / Claim ID /
 * Claimed At / PR fields. Label state stays authoritative; this layer only
 * projects it onto the workboard.
 */

import {
  OPTIONAL_PROJECT_FIELDS,
  projectDateFieldValue,
  projectPrFieldValue,
  selectStatusOption,
} from "./issue-board-state.mjs";
import { getIssue, ghGraphql } from "./issue-board-transport.mjs";

export async function getProject(options) {
  const response = await ghGraphql(
    `query($org:String!,$number:Int!){
      organization(login:$org){
        projectV2(number:$number){
          id
          title
          url
          fields(first:50){
            nodes{
              ... on ProjectV2FieldCommon {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                dataType
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }`,
    { org: options.projectOwner, number: options.projectNumber },
  );
  const project = response?.data?.organization?.projectV2;
  if (!project) {
    throw new Error(
      `Project ${options.projectOwner}/${options.projectNumber} was not found`,
    );
  }
  const fields = project.fields.nodes.filter(Boolean);
  const statusField = fields.find((field) => field.name === "Status");
  if (!statusField?.options) {
    throw new Error("Project must have a single-select Status field");
  }
  return {
    id: project.id,
    title: project.title,
    url: project.url,
    fields,
    statusField,
    statusOptions: statusField.options,
  };
}

function findField(project, name) {
  return project.fields.find((field) => field.name === name);
}

function findIssueProjectItemInNodes(nodes, project) {
  for (const item of nodes ?? []) {
    if (item?.id && item?.project?.id === project.id) return item.id;
    if (item?.id && item?.project?.title === project.title) return item.id;
  }
  return null;
}

export async function findIssueProjectItem(options, issue, project) {
  const localItem = findIssueProjectItemInNodes(issue.projectItems, project);
  if (localItem) return localItem;

  const response = await ghGraphql(
    `query($issue:ID!){
      node(id:$issue){
        ... on Issue {
          projectItems(first:50) {
            nodes {
              id
              project {
                id
                title
              }
            }
          }
        }
      }
    }`,
    { issue: issue.id },
  );
  return findIssueProjectItemInNodes(
    response?.data?.node?.projectItems?.nodes,
    project,
  );
}

async function readProjectTextField(options, itemId, fieldId) {
  const response = await ghGraphql(
    `query($item:ID!){
      node(id:$item){
        ... on ProjectV2Item {
          fieldValues(first:50) {
            nodes {
              ... on ProjectV2ItemFieldTextValue {
                text
                field {
                  ... on ProjectV2FieldCommon {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { item: itemId },
  );
  const values = response?.data?.node?.fieldValues?.nodes ?? [];
  const match = values.find((value) => value?.field?.id === fieldId);
  return match?.text ?? null;
}

export async function verifyClaimOwnership(
  options,
  project,
  itemId,
  issue,
  metadata,
) {
  if (options.dryRun) return;
  const claimField = requireClaimIdField(project);
  const claimId = await readProjectTextField(options, itemId, claimField.id);
  if (claimId !== metadata.claimId) {
    throw new Error(
      `Issue #${issue.number} claim was overwritten; project Claim ID is ${claimId ?? "<empty>"} instead of ${metadata.claimId}`,
    );
  }
}

export function requireClaimIdField(project) {
  const claimField = findField(project, OPTIONAL_PROJECT_FIELDS.claimId);
  if (claimField?.dataType !== "TEXT") {
    throw new Error(
      "Project must have a text Claim ID field before agents can claim issues",
    );
  }
  return claimField;
}

export async function hasDifferentClaimId(
  options,
  project,
  issue,
  expectedClaimId,
) {
  try {
    const claimField = requireClaimIdField(project);
    const current = await getIssue(options, issue.number);
    const itemId = await findIssueProjectItem(options, current, project);
    if (!itemId) return false;
    const claimId = await readProjectTextField(options, itemId, claimField.id);
    return Boolean(claimId && claimId !== expectedClaimId);
  } catch {
    return false;
  }
}

async function addIssueToProject(options, project, issue) {
  const response = await ghGraphql(
    `mutation($project:ID!,$content:ID!){
      addProjectV2ItemById(input:{projectId:$project,contentId:$content}){
        item { id }
      }
    }`,
    { project: project.id, content: issue.id },
    { dryRun: options.dryRun, mutates: true },
  );
  return response?.data?.addProjectV2ItemById?.item?.id;
}

export async function ensureProjectItem(options, project, issue) {
  const existing = await findIssueProjectItem(options, issue, project);
  if (existing) return existing;
  if (options.dryRun) return "dry-run-project-item";
  try {
    return await addIssueToProject(options, project, issue);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already|exists|duplicate/i.test(message)) throw err;
    const refreshed = await getIssue(options, issue.number);
    const refreshedItem = await findIssueProjectItem(
      options,
      refreshed,
      project,
    );
    if (refreshedItem) return refreshedItem;
    throw err;
  }
}

async function updateSingleSelect(options, project, itemId, fieldId, optionId) {
  await ghGraphql(
    `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$project
        itemId:$item
        fieldId:$field
        value:{singleSelectOptionId:$option}
      }) {
        projectV2Item { id }
      }
    }`,
    { project: project.id, item: itemId, field: fieldId, option: optionId },
    { dryRun: options.dryRun, mutates: true },
  );
}

async function clearProjectField(options, project, itemId, fieldId) {
  await ghGraphql(
    `mutation($project:ID!,$item:ID!,$field:ID!){
      clearProjectV2ItemFieldValue(input:{
        projectId:$project
        itemId:$item
        fieldId:$field
      }) {
        projectV2Item { id }
      }
    }`,
    { project: project.id, item: itemId, field: fieldId },
    { dryRun: options.dryRun, mutates: true },
  );
}

async function updateTextField(options, project, itemId, fieldId, text) {
  if (text === undefined || text === "") return;
  if (text === null) {
    await clearProjectField(options, project, itemId, fieldId);
    return;
  }
  await ghGraphql(
    `mutation($project:ID!,$item:ID!,$field:ID!,$text:String!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$project
        itemId:$item
        fieldId:$field
        value:{text:$text}
      }) {
        projectV2Item { id }
      }
    }`,
    { project: project.id, item: itemId, field: fieldId, text },
    { dryRun: options.dryRun, mutates: true },
  );
}

async function updateDateField(options, project, itemId, fieldId, date) {
  if (date === undefined || date === "") return;
  if (date === null) {
    await clearProjectField(options, project, itemId, fieldId);
    return;
  }
  await ghGraphql(
    `mutation($project:ID!,$item:ID!,$field:ID!,$date:Date!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$project
        itemId:$item
        fieldId:$field
        value:{date:$date}
      }) {
        projectV2Item { id }
      }
    }`,
    { project: project.id, item: itemId, field: fieldId, date },
    { dryRun: options.dryRun, mutates: true },
  );
}

export async function updateProjectFields(
  options,
  project,
  itemId,
  state,
  metadata,
) {
  const statusOption = selectStatusOption(project.statusOptions, state);
  await updateSingleSelect(
    options,
    project,
    itemId,
    project.statusField.id,
    statusOption.id,
  );

  const textValues = {};
  if (Object.hasOwn(metadata, "agent")) {
    textValues[OPTIONAL_PROJECT_FIELDS.agent] = metadata.agent;
  }
  if (Object.hasOwn(metadata, "branch")) {
    textValues[OPTIONAL_PROJECT_FIELDS.branch] = metadata.branch;
  }
  if (Object.hasOwn(metadata, "claimId")) {
    textValues[OPTIONAL_PROJECT_FIELDS.claimId] = metadata.claimId;
  }
  if (Object.hasOwn(metadata, "pr")) {
    textValues[OPTIONAL_PROJECT_FIELDS.pr] = projectPrFieldValue(metadata.pr);
  }
  for (const [fieldName, value] of Object.entries(textValues)) {
    const field = findField(project, fieldName);
    if (field?.dataType === "TEXT") {
      await updateTextField(options, project, itemId, field.id, value);
    }
  }

  const claimedAtField = findField(project, OPTIONAL_PROJECT_FIELDS.claimedAt);
  if (
    claimedAtField?.dataType === "DATE" &&
    Object.hasOwn(metadata, "claimedAt")
  ) {
    await updateDateField(
      options,
      project,
      itemId,
      claimedAtField.id,
      projectDateFieldValue(metadata.claimedAt),
    );
  }
}
