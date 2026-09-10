const HIGH_CONFIDENCE = 0.85;
/**
 * Compare-and-set refresh, adapted from
 * HSET_ARKHAM_REFRESH_IF_UNCHANGED_SCRIPT in
 * ui-dashboard/src/lib/address-labels.ts. ARGV is (field, expectedUpdatedAt,
 * value) triples. Writes only while the stored row is still arkham-sourced and
 * its `updatedAt` still matches what this run read at start; a row edited,
 * re-sourced, or deleted mid-run is left alone.
 *
 * Returns the list of SKIPPED fields rather than the lib's written count, so
 * the caller can attribute each skip to its address in the progress file.
 */
const REFRESH_IF_UNCHANGED_SCRIPT = `
local skipped = {}
for i = 1, #ARGV, 3 do
  local field = ARGV[i]
  local expected_updated_at = ARGV[i + 1]
  local value = ARGV[i + 2]
  local write_ok = false
  local current = redis.call("HGET", KEYS[1], field)
  if current ~= false then
    local ok, parsed = pcall(cjson.decode, current)
    if ok and type(parsed) == "table" then
      local is_arkham = parsed["source"] == "arkham"
      local tags = parsed["tags"]
      if not is_arkham and type(tags) == "table" then
        for _, tag in ipairs(tags) do
          if tag == "arkham" then
            is_arkham = true
            break
          end
        end
      end
      local raw_updated_at = parsed["updatedAt"]
      local current_updated_at = type(raw_updated_at) == "string" and raw_updated_at or ""
      if is_arkham and current_updated_at == expected_updated_at then
        write_ok = true
      end
    end
  end
  if write_ok then
    redis.call("HSET", KEYS[1], field, value)
  else
    skipped[#skipped + 1] = field
  end
end
return skipped
`;

const ARKHAM_TAG = "arkham";

// Mirrors isArkhamSourced() in ui-dashboard/src/lib/address-labels-shared.ts:
// new entries carry `source: "arkham"`, pre-source-field entries carry the
// exact `"arkham"` tag sentinel. Non-exact display tags stay manual.
export function isArkhamSourced(entry) {
  if (!entry || typeof entry !== "object") return false;
  return entry.source === "arkham" || entry.tags?.includes(ARKHAM_TAG) === true;
}

// Mirrors arkham.ts toAddressEntry().
export function toAddressEntry(data, now = () => new Date()) {
  let label, entity, topPred;
  const tagSet = new Set();
  for (const perChain of Object.values(data)) {
    const trimmed = perChain.arkhamLabel?.name?.trim();
    if (!label && trimmed) label = trimmed;
    if (!entity && perChain.arkhamEntity?.name?.trim())
      entity = perChain.arkhamEntity;
    if (entity?.type) tagSet.add(entity.type);
    // `populatedTags[].id` is the current field; `tags[].slug` is the one it
    // replaced in 2026-08. Union both so either shape yields tags.
    for (const t of perChain.populatedTags ?? []) if (t.id) tagSet.add(t.id);
    for (const t of perChain.tags ?? []) if (t.slug) tagSet.add(t.slug);
    for (const p of perChain.entityPredictions ?? []) {
      if (p.confidence < HIGH_CONFIDENCE) continue;
      if (!topPred || p.confidence > topPred.confidence) topPred = p;
    }
  }
  const name = (label || entity?.name?.trim() || topPred?.entityId || "").slice(
    0,
    200,
  );
  if (!name) return null;
  const note =
    !label && !entity && topPred
      ? `Arkham prediction (${Math.round(topPred.confidence * 100)}% confidence)`
      : undefined;
  // sanitizeEntry(), as the lib's toAddressEntry does — a NEW entry gets the
  // same trim / case-insensitive tag dedup / length caps the dashboard's own
  // writes get, not just the merged refresh path below.
  return sanitizeEntry({
    name,
    tags: Array.from(tagSet),
    notes: note,
    isPublic: false,
    source: "arkham",
    updatedAt: now().toISOString(),
  });
}

// Entry-shape limits, mirroring ui-dashboard/src/lib/address-labels-shared.ts.
const MAX_NAME_LENGTH = 200;
const MAX_NOTES_LENGTH = 500;
const MAX_TAGS_COUNT = 20;
const MAX_TAG_LENGTH = 50;
const AUTO_NOTE_PREFIX = "Arkham prediction (";

// Mirrors sanitizeEntry(): truncate name/notes, cap tag count and length,
// trim and case-insensitively dedup tags. Needed after a merge because the
// union of fresh + existing tags can exceed the cap.
function sanitizeEntry(entry) {
  const seenTags = new Set();
  // Dedupe/drop-blank BEFORE capping — otherwise a blank or duplicate tag
  // early in the list consumes a slot in the 20-item cap that a later,
  // genuinely unique tag never gets to fill.
  const tags = entry.tags
    .flatMap((raw) => {
      const t = String(raw).trim().slice(0, MAX_TAG_LENGTH);
      if (!t) return [];
      const key = t.toLowerCase();
      if (seenTags.has(key)) return [];
      seenTags.add(key);
      return [t];
    })
    .slice(0, MAX_TAGS_COUNT);
  const notes = entry.notes?.slice(0, MAX_NOTES_LENGTH);
  return {
    ...entry,
    name: entry.name.trim().slice(0, MAX_NAME_LENGTH),
    tags,
    ...(notes !== undefined ? { notes } : {}),
  };
}

// Mirrors withoutArkhamTags(): the legacy provenance sentinel never survives
// into a merged tag set — provenance lives in `source`.
function withoutArkhamTags(tags) {
  return tags.filter((tag) => String(tag).trim().toLowerCase() !== ARKHAM_TAG);
}

/**
 * Merge a fresh Arkham result into the existing entry, mirroring
 * `mergeRefreshEntry` in ui-dashboard/src/lib/arkham.ts exactly.
 *
 * Arkham owns `name` and contributes tags; `createdAt`, `isPublic`, and
 * user-edited `notes` survive the refresh. A pass-1 entry that a human later
 * curated or published in the address-book UI keeps that state — an overwrite
 * would silently un-publish it, since fresh entries always carry
 * `isPublic: false`. Only our own auto-generated "Arkham prediction (…)" note
 * is replaced by the fresh one.
 *
 * A null fresh entry (quality gate failed) never reaches here, so the existing
 * entry survives untouched. Manual entries never reach here either — buildQueue
 * drops them — which is why the non-arkham branch just returns `fresh`, as the
 * lib does.
 */
export function buildWriteEntry(fresh, current) {
  if (!current || !isArkhamSourced(current)) {
    return { ...fresh, createdAt: current?.createdAt ?? fresh.updatedAt };
  }
  const isAutoNote = current.notes?.startsWith(AUTO_NOTE_PREFIX) === true;
  // Existing tags first: `current.tags` can carry Tier 2's forensic ctp:/type:
  // tags (curated, one-shot) ahead of a bulk Arkham tag dump. Now that
  // populatedTags can fill the 20-tag cap on its own, putting `fresh` first
  // would let a routine refresh silently evict that curated content.
  const tags = withoutArkhamTags(
    Array.from(new Set([...(current.tags ?? []), ...fresh.tags])),
  );
  return sanitizeEntry({
    name: fresh.name,
    tags,
    notes: isAutoNote ? fresh.notes : (current.notes ?? fresh.notes),
    isPublic: current.isPublic ?? fresh.isPublic,
    source: "arkham",
    createdAt: current.createdAt ?? fresh.updatedAt,
    updatedAt: fresh.updatedAt,
  });
}

export function createLabelStore({
  redisUrl,
  redisToken,
  fetch = globalThis.fetch,
}) {
  async function upstash(path, init = {}) {
    const res = await fetch(`${redisUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${redisToken}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok)
      throw new Error(`Upstash ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async function pipeline(commands) {
    const res = await fetch(`${redisUrl}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${redisToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok)
      throw new Error(`Upstash pipeline → ${res.status}: ${await res.text()}`);
    const json = await res.json();
    // Upstash pipeline returns HTTP 200 even when individual commands fail; scan
    // each entry for a per-command .error so a silent HSET/HVALS failure can't
    // pass as empty success.
    for (let i = 0; i < json.length; i++) {
      if (json[i] && json[i].error) {
        throw new Error(
          `Upstash pipeline cmd[${i}] (${commands[i][0]}): ${json[i].error}`,
        );
      }
    }
    return json;
  }

  async function getLabels() {
    // HGETALL of the entire `labels` hash — the manual/arkham split below is
    // decided from it.
    const { result } = await upstash(`/hgetall/labels`);
    const map = {};
    for (let i = 0; i < result.length; i += 2) {
      const field = result[i];
      try {
        map[field] = JSON.parse(result[i + 1]);
      } catch {
        map[field] = result[i + 1];
      }
    }
    return map;
  }

  return { getLabels, pipeline };
}

// Progress is appended only after the write outcome is known.
export function createWriter({ pipeline, appendFileSync, progressFile }) {
  let written = 0;
  let newSkippedExists = 0;
  let refreshSkippedChanged = 0;
  const pendingWrites = [];
  function noteSkip(address, reason) {
    appendFileSync(
      progressFile,
      JSON.stringify({ address, write: reason }) + "\n",
    );
  }

  /** HSETNX batch — anything that appeared at the field mid-run wins. */
  async function flushNewWrites(batch) {
    const results = await pipeline(
      batch.map((w) => [
        "HSETNX",
        "labels",
        w.address,
        JSON.stringify(w.entry),
      ]),
    );
    for (let i = 0; i < batch.length; i++) {
      if (Number(results[i]?.result) === 1) {
        written++;
        appendFileSync(
          progressFile,
          JSON.stringify({ address: batch[i].address, write: "written" }) +
            "\n",
        );
        continue;
      }
      newSkippedExists++;
      noteSkip(batch[i].address, "skipped_exists");
    }
  }

  /** Compare-and-set batch — a row edited or deleted mid-run wins. */
  async function flushRefreshWrites(batch) {
    const argv = batch.flatMap((w) => [
      w.address,
      w.expectedUpdatedAt,
      JSON.stringify(w.entry),
    ]);
    const [response] = await pipeline([
      ["EVAL", REFRESH_IF_UNCHANGED_SCRIPT, "1", "labels", ...argv],
    ]);
    const skipped = new Set(response?.result ?? []);
    for (const w of batch) {
      if (!skipped.has(w.address)) {
        written++;
        appendFileSync(
          progressFile,
          JSON.stringify({ address: w.address, write: "written" }) + "\n",
        );
        continue;
      }
      refreshSkippedChanged++;
      noteSkip(w.address, "skipped_changed");
    }
  }

  async function flushWrites() {
    if (pendingWrites.length === 0) return;
    const batch = pendingWrites.splice(0, pendingWrites.length);
    const news = batch.filter((w) => w.mode === "new");
    const refreshes = batch.filter((w) => w.mode === "refresh");
    try {
      if (news.length > 0) await flushNewWrites(news);
      if (refreshes.length > 0) await flushRefreshWrites(refreshes);
    } catch (err) {
      // Put the batch back (protects an in-process retry, e.g. a later
      // threshold flush succeeding after a transient blip) and re-throw so
      // the caller halts rather than silently grinding through the queue.
      // recordResult() deliberately never wrote a progressFile line for
      // these addresses, so if the process halts here instead of retrying,
      // a resumed run re-fetches and re-attempts them rather than skipping
      // addresses whose write never landed.
      pendingWrites.unshift(...batch);
      throw err;
    }
  }

  return {
    pendingWrites,
    flushWrites,
    get counts() {
      return { written, newSkippedExists, refreshSkippedChanged };
    },
  };
}
