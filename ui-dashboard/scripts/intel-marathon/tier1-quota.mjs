const ARKHAM_BASE = "https://api.arkm.com";
export function createQuota({
  fetch = globalThis.fetch,
  arkhamKey,
  console = globalThis.console,
} = {}) {
  // Trial plan: 10,000 unique labeled-address lookups per billing period
  // ("Intel Label Limit"). Observed rather than assumed — unlabeled 404s appear
  // not to consume quota, but the numbers come from the API either way.
  //
  // Two sources, in precedence order. Response headers are authoritative and
  // per-request, so once they have been seen they own the values. The
  // /subscription/intel-usage body is the fallback: the headers are unverified,
  // and without a fallback a header-less API would leave `remaining` null and the
  // --quota-floor stop would never fire.
  //
  // Precedence is tracked per-field for `remaining`, not for the header set as a
  // whole: an API that sends Usage/Limit but no Remaining must not switch off the
  // body fallback, or `remaining` would stay null and the stop would never fire.
  const quota = {
    usage: null,
    limit: null,
    remaining: null,
    seen: false, // any source has reported numbers
    fromHeaders: false, // response headers have reported numbers at least once
    remainingFromHeaders: false, // a header has reported Remaining specifically
  };

  const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

  function headerNumber(res, name) {
    const raw = res.headers.get(name);
    if (raw === null || raw.trim() === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Records the quota headers; returns true when Remaining dropped. */
  function noteQuotaHeaders(res) {
    const usage = headerNumber(res, "X-Intel-Datapoints-Usage");
    const limit = headerNumber(res, "X-Intel-Datapoints-Limit");
    const remaining = headerNumber(res, "X-Intel-Datapoints-Remaining");
    if (usage === null && limit === null && remaining === null) return false;
    const dropped =
      quota.remaining !== null &&
      remaining !== null &&
      remaining < quota.remaining;
    if (usage !== null) quota.usage = usage;
    if (limit !== null) quota.limit = limit;
    if (remaining !== null) {
      quota.remaining = remaining;
      quota.remainingFromHeaders = true;
    }
    quota.seen = true;
    quota.fromHeaders = true;
    return dropped;
  }

  function quotaLine() {
    if (!quota.seen) return "quota not yet observed";
    return `usage=${quota.usage ?? "?"} limit=${quota.limit ?? "?"} remaining=${
      quota.remaining ?? "?"
    } via=${quota.remainingFromHeaders ? "headers" : "intel-usage"}`;
  }

  // Live body shape (probed 2026-08-24):
  //   { totalCount, totalLimit, chainUsage: {...}, periodStart }
  // Derive remaining from that pair; the "*remaining*" key scan is the secondary
  // path in case the shape changes.
  function remainingFromUsageBody(body) {
    if (!body || typeof body !== "object") return null;
    if (isFiniteNumber(body.totalLimit) && isFiniteNumber(body.totalCount)) {
      return body.totalLimit - body.totalCount;
    }
    for (const [key, value] of Object.entries(body)) {
      if (/remaining/i.test(key) && isFiniteNumber(value)) return value;
    }
    return null;
  }

  /** Free endpoint — does not consume Intel Label quota. */
  async function logIntelUsage(context) {
    try {
      const res = await fetch(`${ARKHAM_BASE}/subscription/intel-usage`, {
        headers: { "API-Key": arkhamKey },
        signal: AbortSignal.timeout(15_000),
      });
      noteQuotaHeaders(res);
      if (!res.ok) {
        console.warn(`  ⚠ intel-usage (${context}): HTTP ${res.status}`);
        return;
      }
      const body = await res.json();
      // A Remaining header wins once seen. Until then every poll refreshes the
      // body-derived numbers, so the --quota-floor stop stays live on an API that
      // sends no Remaining header at all — or only Usage/Limit.
      if (!quota.remainingFromHeaders) {
        const remaining = remainingFromUsageBody(body);
        if (remaining !== null) {
          quota.remaining = remaining;
          quota.seen = true;
        }
        if (isFiniteNumber(body.totalCount)) quota.usage = body.totalCount;
        if (isFiniteNumber(body.totalLimit)) quota.limit = body.totalLimit;
      }
      console.log(`  intel-usage (${context}): ${JSON.stringify(body)}`);
    } catch (err) {
      console.warn(`  ⚠ intel-usage (${context}) failed: ${err.message}`);
    }
  }

  async function fetchEnriched(address) {
    const url = new URL(
      `/intelligence/address_enriched/${address}/all`,
      ARKHAM_BASE,
    );
    url.searchParams.set("includeTags", "true");
    url.searchParams.set("includeEntityPredictions", "true");
    url.searchParams.set("includeClusters", "false");
    const res = await fetch(url, {
      headers: { "API-Key": arkhamKey },
      signal: AbortSignal.timeout(15_000),
    });
    const dropped = noteQuotaHeaders(res);
    if (res.status === 404) return { status: 404, data: null, dropped };
    if (res.status === 401) throw new Error("ARKHAM_AUTH_FAIL");
    // 402 Payment Required / 403 Forbidden — the plan is refusing the call, so
    // the rest of the queue would refuse too. Halt rather than burn it.
    if (res.status === 402 || res.status === 403)
      throw new Error("ARKHAM_ENTITLEMENT");
    if (res.status === 429) throw new Error("ARKHAM_RATE_LIMITED");
    if (!res.ok) throw new Error(`arkham_http_${res.status}`);
    return { status: 200, data: await res.json(), dropped };
  }

  return {
    quota,
    noteQuotaHeaders,
    quotaLine,
    remainingFromUsageBody,
    logIntelUsage,
    fetchEnriched,
  };
}
