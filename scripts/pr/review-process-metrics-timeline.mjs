const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function normalizedOid(value) {
  return typeof value === "string" && FULL_SHA_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

export function parseForcePushGraphqlPage(payload, requestCursor = null) {
  const connection = payload?.data?.repository?.pullRequest?.timelineItems;
  const pageInfo = connection?.pageInfo;
  if (
    payload?.errors != null ||
    !Array.isArray(connection?.nodes) ||
    !Number.isSafeInteger(connection?.totalCount) ||
    connection.totalCount < 0 ||
    typeof pageInfo?.hasNextPage !== "boolean"
  ) {
    throw new Error("force-push GraphQL returned an invalid page envelope");
  }
  if (
    pageInfo.hasNextPage &&
    (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0)
  ) {
    throw new Error("force-push GraphQL omitted the next-page cursor");
  }
  const items = connection.nodes.map((node) => {
    const beforeHead = normalizedOid(node?.beforeCommit?.oid);
    const afterHead = normalizedOid(node?.afterCommit?.oid);
    if (
      typeof node?.id !== "string" ||
      node.id.length === 0 ||
      !Number.isFinite(Date.parse(node.createdAt)) ||
      beforeHead === null ||
      afterHead === null ||
      beforeHead === afterHead
    ) {
      throw new Error("force-push GraphQL returned incomplete event evidence");
    }
    return {
      nodeId: node.id,
      createdAt: new Date(Date.parse(node.createdAt)).toISOString(),
      beforeHead,
      afterHead,
    };
  });
  return { items, pageInfo, totalCount: connection.totalCount, requestCursor };
}

export function assertCompleteForcePushGraphqlPages(pages, surface) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error(`${surface} pagination returned no page envelope`);
  }
  const totalCount = pages[0].totalCount;
  pages.forEach((page, index) => {
    if (page.totalCount !== totalCount) {
      throw new Error(
        `${surface} pagination returned conflicting total counts`,
      );
    }
    if (
      !Array.isArray(page.items) ||
      (page.pageInfo.hasNextPage && page.items.length === 0)
    ) {
      throw new Error(`${surface} pagination returned an invalid event page`);
    }
    const expectedCursor =
      index === 0 ? null : pages[index - 1].pageInfo.endCursor;
    if (page.requestCursor !== expectedCursor) {
      throw new Error(
        `${surface} pagination returned a conflicting cursor chain`,
      );
    }
    const finalPage = index === pages.length - 1;
    if (page.pageInfo.hasNextPage === finalPage) {
      throw new Error(
        `${surface} pagination ended with an incomplete page chain`,
      );
    }
  });
  const items = pages.flatMap(({ items: pageItems }) => pageItems);
  if (new Set(items.map(({ nodeId }) => nodeId)).size !== items.length) {
    throw new Error(`${surface} pagination returned duplicate events`);
  }
  return {
    items,
    pagination: {
      complete: true,
      proof: "graphql_cursor_chain_and_unique_event_ids",
      pages: pages.length,
      itemCount: items.length,
      expectedCount: null,
      source: "graphql",
      reportedUnfilteredTimelineItemCount: totalCount,
    },
  };
}

function restForcePushHead(event, field, fallback = null) {
  const value = event?.[field];
  const candidates = [
    typeof value === "string" ? value : null,
    value?.sha,
    field === "after_commit" ? event?.commit_id : null,
  ].filter((candidate) => candidate != null);
  if (candidates.length === 0) return fallback;
  const heads = candidates.map(normalizedOid);
  return heads.every((head) => head !== null) && new Set(heads).size === 1
    ? heads[0]
    : null;
}

export function enrichTimelineForcePushes(timeline, forcePushes) {
  const remaining = new Map(forcePushes.map((event) => [event.nodeId, event]));
  const conflicts = [];
  const items = timeline.map((event) => {
    if (event?.event !== "head_ref_force_pushed") return event;
    const proof = remaining.get(event.node_id);
    let reason = proof ? null : "force_push_enrichment_not_found";
    const createdAt = Date.parse(event.created_at);
    const proofCreatedAt = Date.parse(proof?.createdAt);
    if (
      proof &&
      (!Number.isFinite(createdAt) ||
        !Number.isFinite(proofCreatedAt) ||
        createdAt !== proofCreatedAt)
    ) {
      reason = "force_push_enrichment_timestamp_conflict";
    }
    const restAfter = restForcePushHead(
      event,
      "after_commit",
      proof?.afterHead,
    );
    const restBefore = restForcePushHead(
      event,
      "before_commit",
      proof?.beforeHead,
    );
    if (
      proof &&
      (restAfter !== proof.afterHead || restBefore !== proof.beforeHead)
    ) {
      reason = "force_push_enrichment_commit_conflict";
    }
    if (proof) remaining.delete(proof.nodeId);
    if (reason) conflicts.push({ nodeId: event.node_id ?? null, reason });
    return {
      ...event,
      force_push_proof: reason
        ? { kind: "unknown", reason }
        : { kind: "graphql", ...proof },
    };
  });
  for (const nodeId of remaining.keys()) {
    conflicts.push({
      nodeId,
      reason: "force_push_rest_timeline_event_not_found",
    });
  }
  return { items, complete: conflicts.length === 0, conflicts };
}

function evidenceTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function forcePushTarget(event) {
  const candidates = [
    event.commit_id,
    typeof event.after_commit === "string" ? event.after_commit : null,
    event.after_commit?.sha,
  ].filter((value) => value != null);
  if (candidates.length === 0) return null;
  const normalized = candidates.map(normalizedOid);
  return normalized.every((head) => head !== null) &&
    new Set(normalized).size === 1
    ? normalized[0]
    : null;
}

export function provenForcePush(event) {
  const proof = event?.force_push_proof;
  if (proof == null) {
    return {
      beforeHead: null,
      afterHead: null,
      timestamp: null,
      reason: "timeline_force_push_enrichment_missing",
    };
  }
  if (proof?.kind === "unknown") {
    return {
      beforeHead: null,
      afterHead: null,
      timestamp: null,
      reason: proof.reason ?? "timeline_force_push_enrichment_conflicts",
    };
  }
  const beforeHead = normalizedOid(proof?.beforeHead);
  const afterHead = normalizedOid(proof?.afterHead);
  const timestamp = evidenceTimestamp(proof?.createdAt);
  const eventTimestamp = evidenceTimestamp(event?.created_at);
  const restTarget = forcePushTarget(event);
  const hasRestTarget = event?.commit_id != null || event?.after_commit != null;
  if (
    proof?.kind !== "graphql" ||
    proof.nodeId !== event?.node_id ||
    beforeHead === null ||
    afterHead === null ||
    timestamp === null ||
    timestamp !== eventTimestamp ||
    (hasRestTarget && restTarget !== afterHead)
  ) {
    return {
      beforeHead: null,
      afterHead: null,
      timestamp: null,
      reason: "timeline_force_push_enrichment_conflicts",
    };
  }
  return { beforeHead, afterHead, timestamp, reason: null };
}

function initialHeadFromForcePush(timeline, commentIndex, commentTimestamp) {
  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index];
    if (item?.event === "head_ref_force_pushed") {
      const proof = provenForcePush(item);
      if (proof.reason !== null) {
        return { head: null, reason: proof.reason };
      }
      if (index >= commentIndex && proof.timestamp <= commentTimestamp) {
        return {
          head: null,
          reason: "timeline_order_conflicts_with_force_push_timestamp",
        };
      }
      if (index >= commentIndex) {
        return { head: null, reason: "timeline_head_not_established" };
      }
      return { head: proof.beforeHead, reason: null };
    }
    if (
      item?.event === "committed" ||
      item?.event === "head_ref_deleted" ||
      item?.event === "head_ref_restored"
    ) {
      break;
    }
  }
  return { head: null, reason: "timeline_head_not_established" };
}

function nextForcePush(timeline, index) {
  for (let cursor = index + 1; cursor < timeline.length; cursor += 1) {
    const item = timeline[cursor];
    if (item?.event === "head_ref_force_pushed") {
      return { ...provenForcePush(item), index: cursor };
    }
    if (
      item?.event === "head_ref_deleted" ||
      item?.event === "head_ref_restored"
    ) {
      break;
    }
  }
  return null;
}

export function effectiveHeadBeforeComment(
  timeline,
  commentIndex,
  commentTimestamp,
) {
  const initial = initialHeadFromForcePush(
    timeline,
    commentIndex,
    commentTimestamp,
  );
  let head = initial.head;
  let lastKnownHead = head;
  let deleted = false;
  let reason = initial.reason;
  for (let index = 0; index < commentIndex; index += 1) {
    const item = timeline[index];
    if (item?.event === "committed") {
      const committedHead = normalizedOid(item.sha);
      const upcomingForcePush = nextForcePush(timeline, index);
      if (committedHead === null || deleted) {
        head = null;
        reason = deleted
          ? "timeline_commit_while_head_ref_is_deleted"
          : "timeline_committed_head_is_invalid";
        if (deleted) lastKnownHead = null;
      } else if (
        upcomingForcePush?.reason === null &&
        upcomingForcePush.beforeHead === head
      ) {
        if (
          upcomingForcePush.index >= commentIndex &&
          upcomingForcePush.timestamp <= commentTimestamp
        ) {
          head = null;
          reason = "timeline_order_conflicts_with_force_push_timestamp";
        }
      } else {
        head = committedHead;
        lastKnownHead = committedHead;
        reason = null;
      }
      continue;
    }
    if (item?.event === "head_ref_force_pushed") {
      const proof = provenForcePush(item);
      if (proof.reason !== null) {
        head = null;
        reason = proof.reason;
      } else if (proof.timestamp > commentTimestamp) {
        head = null;
        reason = "timeline_order_conflicts_with_force_push_timestamp";
      } else if (deleted || (head !== null && head !== proof.beforeHead)) {
        head = null;
        reason = deleted
          ? "timeline_force_push_while_head_ref_is_deleted"
          : "timeline_force_push_before_head_conflicts";
        if (deleted) lastKnownHead = null;
      } else {
        head = proof.afterHead;
        lastKnownHead = proof.afterHead;
        reason = null;
      }
      continue;
    }
    if (item?.event === "head_ref_deleted") {
      const timestamp = evidenceTimestamp(item.created_at);
      if (
        timestamp === null ||
        timestamp > commentTimestamp ||
        deleted ||
        head === null
      ) {
        head = null;
        lastKnownHead = null;
        reason = "timeline_head_ref_deletion_is_unprovable";
      } else {
        lastKnownHead = head;
        head = null;
        deleted = true;
        reason = "timeline_head_ref_is_deleted";
      }
      continue;
    }
    if (item?.event === "head_ref_restored") {
      const timestamp = evidenceTimestamp(item.created_at);
      if (
        timestamp === null ||
        timestamp > commentTimestamp ||
        !deleted ||
        lastKnownHead === null
      ) {
        head = null;
        lastKnownHead = null;
        reason = "timeline_head_ref_restoration_is_unprovable";
      } else {
        head = lastKnownHead;
        deleted = false;
        reason = null;
      }
    }
  }
  return { head, reason };
}
