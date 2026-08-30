/**
 * GitHub Projects V2 field IO for the issue board.
 *
 * Resolves the project and its Status field, finds or creates the item for an
 * issue, reads the human-owned Status, and reads or writes the optional Agent /
 * Branch / Claim ID / Claimed At / PR fields.
 *
 * Owner-field mutators require the active per-issue mutex capability. The
 * static proof confines both raw owner-mutation operations to the guarded
 * executor in this module.
 */

import {
  OPTIONAL_PROJECT_FIELDS,
  PROSPECTIVE_PROJECT_ITEM_ID,
  projectDateFieldValue,
  projectPrFieldValue,
} from "./issue-board-state.mjs";
import { executeIssueOwnerMutation } from "./issue-board-lock.mjs";
import { getIssue, ghGraphql } from "./issue-board-transport.mjs";

export const MAX_PROJECT_FIELD_VALUE_PAGES = 100;
export const MAX_PROJECT_FIELD_VALUE_NODES = 10_000;
export { PROSPECTIVE_PROJECT_ITEM_ID };

export async function getProject(options, { graphql = ghGraphql } = {}) {
  const response = await graphql(
    `
      query ($org: String!, $number: Int!) {
        organization(login: $org) {
          projectV2(number: $number) {
            id
            title
            url
            fields(first: 50) {
              nodes {
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
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      }
    `,
    { org: options.projectOwner, number: options.projectNumber },
  );
  const project = response?.data?.organization?.projectV2;
  if (!project) {
    throw new Error(
      `Project ${options.projectOwner}/${options.projectNumber} was not found`,
    );
  }
  if (
    !Array.isArray(project.fields?.nodes) ||
    project.fields?.pageInfo?.hasNextPage !== false
  ) {
    throw new Error(
      `Project ${options.projectOwner}/${options.projectNumber} field lookup was incomplete`,
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

export function findField(project, name) {
  return project.fields.find((field) => field.name === name);
}

export function requireBackfillFields(project) {
  const expected = {
    [OPTIONAL_PROJECT_FIELDS.agent]: "TEXT",
    [OPTIONAL_PROJECT_FIELDS.claimId]: "TEXT",
    [OPTIONAL_PROJECT_FIELDS.branch]: "TEXT",
    [OPTIONAL_PROJECT_FIELDS.claimedAt]: "DATE",
    [OPTIONAL_PROJECT_FIELDS.pr]: "TEXT",
  };
  const fields = {};
  for (const [name, dataType] of Object.entries(expected)) {
    const field = findField(project, name);
    if (field?.dataType !== dataType) {
      throw new Error(
        `Project must have a ${dataType} ${name} field for backfill`,
      );
    }
    fields[name] = field;
  }
  return fields;
}

function findIssueProjectItemInNodes(nodes, project) {
  const selectedItems = nodes.filter(
    (item) => item?.project?.id === project.id,
  );
  if (selectedItems.length > 1) {
    throw new Error(
      `Issue has duplicate Project items for selected Project ${project.id}`,
    );
  }
  const selectedItem = selectedItems[0];
  if (!selectedItem) return null;
  if (typeof selectedItem.id !== "string" || selectedItem.id.length === 0) {
    throw new Error(
      `Issue Project item for selected Project ${project.id} has no node ID`,
    );
  }
  return selectedItem.id;
}

export async function findIssueProjectItem(
  options,
  issue,
  project,
  { graphql = ghGraphql } = {},
) {
  if (issue.projectItemsPageInfo?.hasNextPage === false) {
    if (!Array.isArray(issue.projectItems)) {
      throw new Error(
        `Issue #${issue.number ?? issue.id} Project membership snapshot has no item nodes`,
      );
    }
    return findIssueProjectItemInNodes(issue.projectItems, project);
  }

  const response = await graphql(
    `
      query ($issue: ID!) {
        node(id: $issue) {
          ... on Issue {
            projectItems(first: 50) {
              nodes {
                id
                project {
                  id
                  title
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      }
    `,
    { issue: issue.id },
  );
  const projectItems = response?.data?.node?.projectItems;
  if (
    !Array.isArray(projectItems?.nodes) ||
    projectItems?.pageInfo?.hasNextPage !== false
  ) {
    throw new Error(
      `Issue #${issue.number ?? issue.id} Project membership lookup was incomplete; refusing to treat the selected Project item as absent`,
    );
  }
  return findIssueProjectItemInNodes(projectItems.nodes, project);
}

export async function readProjectItemStatus(
  options,
  project,
  itemId,
  { graphql = ghGraphql } = {},
) {
  if (!project.statusField?.id) {
    throw new Error("Project must have a Status field ID");
  }
  const response = await graphql(
    `
      query ($item: ID!) {
        node(id: $item) {
          ... on ProjectV2Item {
            fieldValues(first: 100) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                  field {
                    ... on ProjectV2FieldCommon {
                      id
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      }
    `,
    { item: itemId },
  );
  const values = response?.data?.node?.fieldValues;
  if (!values) throw new Error(`Project item ${itemId} was not found`);
  if (
    !Array.isArray(values.nodes) ||
    typeof values.pageInfo?.hasNextPage !== "boolean"
  ) {
    throw new Error(
      `Project item ${itemId} Status lookup was incomplete; refusing to treat Status as empty`,
    );
  }
  if (values.pageInfo.hasNextPage) {
    throw new Error(
      `Project item ${itemId} has more than 100 field values; refusing an inconsistent Status snapshot`,
    );
  }
  const status = values.nodes.find(
    (value) => value?.field?.id === project.statusField.id,
  );
  return status
    ? { name: status.name ?? null, optionId: status.optionId ?? null }
    : null;
}

export async function readProjectTextField(
  options,
  itemId,
  fieldId,
  { graphql = ghGraphql } = {},
) {
  const response = await graphql(
    `
      query ($item: ID!) {
        node(id: $item) {
          ... on ProjectV2Item {
            fieldValues(first: 50) {
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
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      }
    `,
    { item: itemId },
  );
  const connection = response?.data?.node?.fieldValues;
  if (!connection) throw new Error(`Project item ${itemId} was not found`);
  if (
    !Array.isArray(connection.nodes) ||
    connection.pageInfo?.hasNextPage !== false
  ) {
    throw new Error(
      `Project item ${itemId} text-field lookup was incomplete; refusing to treat field ${fieldId} as empty`,
    );
  }
  const values = connection.nodes;
  const match = values.find((value) => value?.field?.id === fieldId);
  return match?.text ?? null;
}

export async function readBackfillProjectFields(
  options,
  project,
  itemId,
  {
    graphql = ghGraphql,
    maxPages = MAX_PROJECT_FIELD_VALUE_PAGES,
    maxNodes = MAX_PROJECT_FIELD_VALUE_NODES,
  } = {},
) {
  const fields = requireBackfillFields(project);
  const valuesById = new Map();
  let cursor = null;
  const seenCursors = new Set();
  let pages = 0;
  let nodesRead = 0;
  while (true) {
    if (pages >= maxPages) {
      throw new Error(
        `Project item ${itemId} field pagination exceeded ${maxPages} pages`,
      );
    }
    const response = await graphql(
      `
        query ($item: ID!, $cursor: String) {
          node(id: $item) {
            ... on ProjectV2Item {
              fieldValues(first: 100, after: $cursor) {
                nodes {
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field {
                      ... on ProjectV2FieldCommon {
                        id
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldDateValue {
                    date
                    field {
                      ... on ProjectV2FieldCommon {
                        id
                      }
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      { item: itemId, cursor },
    );
    const connection = response?.data?.node?.fieldValues;
    if (!connection) throw new Error(`Project item ${itemId} was not found`);
    if (
      !Array.isArray(connection.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== "boolean"
    ) {
      throw new Error(
        `Project item ${itemId} field pagination returned an incomplete page`,
      );
    }
    pages += 1;
    const nodes = connection.nodes;
    nodesRead += nodes.length;
    if (nodesRead > maxNodes) {
      throw new Error(
        `Project item ${itemId} field pagination exceeded ${maxNodes} nodes`,
      );
    }
    for (const value of nodes) {
      if (value?.field?.id)
        valuesById.set(value.field.id, value.text ?? value.date ?? null);
    }
    if (connection.pageInfo.hasNextPage === false) break;
    const nextCursor = connection.pageInfo.endCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error(
        `Project item ${itemId} field pagination did not advance cursor`,
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      valuesById.get(field.id) ?? null,
    ]),
  );
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
  if (options.dryRun) return PROSPECTIVE_PROJECT_ITEM_ID;
  try {
    const added = await addIssueToProject(options, project, issue);
    if (!added) {
      throw new Error(
        `GitHub did not return the selected Project item ID after adding issue #${issue.number}`,
      );
    }
    return added;
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

function ownerMutationBinding(
  options,
  project,
  itemId,
  fieldId,
  { dataType, field, issueNumber, operation },
) {
  return {
    repo: options.repo,
    issueNumber,
    projectOwner: options.projectOwner,
    projectNumber: options.projectNumber,
    projectId: project.id,
    operation,
    field,
    fieldId,
    dataType,
    itemId,
  };
}

function clearProjectField(
  capability,
  options,
  project,
  itemId,
  fieldId,
  { dataType, field, graphql = ghGraphql, issueNumber, operation } = {},
) {
  return executeIssueOwnerMutation(
    capability,
    ownerMutationBinding(options, project, itemId, fieldId, {
      dataType,
      field,
      issueNumber,
      operation,
    }),
    (trustedTarget) =>
      graphql(
        `
          mutation ($project: ID!, $item: ID!, $field: ID!) {
            clearProjectV2ItemFieldValue(
              input: { projectId: $project, itemId: $item, fieldId: $field }
            ) {
              projectV2Item {
                id
              }
            }
          }
        `,
        {
          project: trustedTarget.projectId,
          item: trustedTarget.itemId,
          field: trustedTarget.fieldId,
        },
        { dryRun: options.dryRun, mutates: true },
      ),
  );
}

export function updateTextField(
  capability,
  options,
  project,
  itemId,
  fieldId,
  text,
  { field, graphql = ghGraphql, issueNumber, operation } = {},
) {
  if (text === undefined || text === "") return;
  if (text === null) {
    return clearProjectField(capability, options, project, itemId, fieldId, {
      dataType: "TEXT",
      field,
      graphql,
      issueNumber,
      operation,
    });
  }
  return executeIssueOwnerMutation(
    capability,
    ownerMutationBinding(options, project, itemId, fieldId, {
      dataType: "TEXT",
      field,
      issueNumber,
      operation,
    }),
    (trustedTarget) =>
      graphql(
        `
          mutation ($project: ID!, $item: ID!, $field: ID!, $text: String!) {
            updateProjectV2ItemFieldValue(
              input: {
                projectId: $project
                itemId: $item
                fieldId: $field
                value: { text: $text }
              }
            ) {
              projectV2Item {
                id
              }
            }
          }
        `,
        {
          project: trustedTarget.projectId,
          item: trustedTarget.itemId,
          field: trustedTarget.fieldId,
          text,
        },
        { dryRun: options.dryRun, mutates: true },
      ),
  );
}

function updateDateField(
  capability,
  options,
  project,
  itemId,
  fieldId,
  date,
  { field, graphql = ghGraphql, issueNumber, operation } = {},
) {
  if (date === undefined || date === "") return;
  if (date === null) {
    return clearProjectField(capability, options, project, itemId, fieldId, {
      dataType: "DATE",
      field,
      graphql,
      issueNumber,
      operation,
    });
  }
  return executeIssueOwnerMutation(
    capability,
    ownerMutationBinding(options, project, itemId, fieldId, {
      dataType: "DATE",
      field,
      issueNumber,
      operation,
    }),
    (trustedTarget) =>
      graphql(
        `
          mutation ($project: ID!, $item: ID!, $field: ID!, $date: Date!) {
            updateProjectV2ItemFieldValue(
              input: {
                projectId: $project
                itemId: $item
                fieldId: $field
                value: { date: $date }
              }
            ) {
              projectV2Item {
                id
              }
            }
          }
        `,
        {
          project: trustedTarget.projectId,
          item: trustedTarget.itemId,
          field: trustedTarget.fieldId,
          date,
        },
        { dryRun: options.dryRun, mutates: true },
      ),
  );
}

export async function writeBackfillProjectFields(
  capability,
  options,
  project,
  itemId,
  writes,
  { graphql = ghGraphql, issueNumber, operation } = {},
) {
  const fields = requireBackfillFields(project);
  const writableFields = new Set([
    OPTIONAL_PROJECT_FIELDS.claimId,
    OPTIONAL_PROJECT_FIELDS.agent,
    OPTIONAL_PROJECT_FIELDS.branch,
    OPTIONAL_PROJECT_FIELDS.claimedAt,
  ]);
  for (const write of writes) {
    if (!writableFields.has(write.field)) {
      throw new Error(`Backfill cannot write field: ${write.field}`);
    }
    const field = fields[write.field];
    if (!field) throw new Error(`Unknown backfill field: ${write.field}`);
    if (field.dataType === "DATE") {
      await updateDateField(
        capability,
        options,
        project,
        itemId,
        field.id,
        write.value,
        {
          field: write.field,
          graphql,
          issueNumber,
          operation,
        },
      );
    } else {
      await updateTextField(
        capability,
        options,
        project,
        itemId,
        field.id,
        write.value,
        {
          field: write.field,
          graphql,
          issueNumber,
          operation,
        },
      );
    }
  }
}

export async function updateProjectMetadata(
  capability,
  options,
  project,
  itemId,
  metadata,
  {
    updateText = updateTextField,
    updateDate = updateDateField,
    graphql = ghGraphql,
    issueNumber,
    operation,
  } = {},
) {
  const writeContext = { graphql, issueNumber, operation };
  const textValues = {};
  if (Object.hasOwn(metadata, "agent")) {
    textValues[OPTIONAL_PROJECT_FIELDS.agent] = metadata.agent;
  }
  if (Object.hasOwn(metadata, "branch")) {
    textValues[OPTIONAL_PROJECT_FIELDS.branch] = metadata.branch;
  }
  if (Object.hasOwn(metadata, "pr")) {
    textValues[OPTIONAL_PROJECT_FIELDS.pr] = projectPrFieldValue(metadata.pr);
  }
  for (const [fieldName, value] of Object.entries(textValues)) {
    const field = findField(project, fieldName);
    if (field?.dataType === "TEXT") {
      await updateText(capability, options, project, itemId, field.id, value, {
        ...writeContext,
        field: fieldName,
      });
    }
  }

  const claimedAtField = findField(project, OPTIONAL_PROJECT_FIELDS.claimedAt);
  if (
    claimedAtField?.dataType === "DATE" &&
    Object.hasOwn(metadata, "claimedAt")
  ) {
    await updateDate(
      capability,
      options,
      project,
      itemId,
      claimedAtField.id,
      projectDateFieldValue(metadata.claimedAt),
      { ...writeContext, field: OPTIONAL_PROJECT_FIELDS.claimedAt },
    );
  }

  // Claim ID is the ownership commit marker. Clear it only after every other
  // release field has cleared, so a failed release still has an owner token.
  if (Object.hasOwn(metadata, "claimId")) {
    const claimField = findField(project, OPTIONAL_PROJECT_FIELDS.claimId);
    if (claimField?.dataType === "TEXT") {
      await updateText(
        capability,
        options,
        project,
        itemId,
        claimField.id,
        metadata.claimId,
        { ...writeContext, field: OPTIONAL_PROJECT_FIELDS.claimId },
      );
    }
  }
}
