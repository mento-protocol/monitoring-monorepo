const HIGH_SEVERITIES = new Set(["high", "critical"]);
const MODERATE_PLUS_SEVERITIES = new Set(["moderate", "high", "critical"]);

const DISCORD_UNDICI_ADVISORY_IDS = new Set([
  "GHSA-p88m-4jfj-68fv",
  "GHSA-vxpw-j846-p89q",
  "CVE-2026-12151",
]);

const ROOT_DISCORD_UNDICI_PATHS = new Set([
  "governance-watchdog>discord.js>undici",
  "governance-watchdog>discord.js>@discordjs/rest>undici",
  "governance-watchdog>discord.js>@discordjs/ws>@discordjs/rest>undici",
]);

const GOVERNANCE_STANDALONE_DISCORD_UNDICI_PATHS = new Set([
  ".>discord.js>undici",
  ".>discord.js>@discordjs/rest>undici",
  ".>discord.js>@discordjs/ws>@discordjs/rest>undici",
  "discord.js>undici",
  "discord.js>@discordjs/rest>undici",
  "discord.js>@discordjs/ws>@discordjs/rest>undici",
]);

/**
 * @param {Record<string, any>} advisory
 * @returns {string[]}
 */
export function advisoryIds(advisory) {
  return [
    advisory.github_advisory_id,
    ...(Array.isArray(advisory.cves) ? advisory.cves : []),
    advisory.url,
    advisory.id !== undefined ? String(advisory.id) : undefined,
  ].filter((id) => typeof id === "string" && id.length > 0);
}

/**
 * @param {Record<string, any>} advisory
 * @returns {boolean}
 */
export function isBlockingSeverity(advisory) {
  const severity = String(advisory.severity ?? "").toLowerCase();
  return severity === "" || HIGH_SEVERITIES.has(severity);
}

/**
 * @param {Record<string, any>} advisory
 * @returns {boolean}
 */
export function isModeratePlusSeverity(advisory) {
  const severity = String(advisory.severity ?? "").toLowerCase();
  return MODERATE_PLUS_SEVERITIES.has(severity);
}

/**
 * @param {{dir: string; label: string}} options
 * @returns {boolean}
 */
function isGovernanceWatchdogAudit(options) {
  const normalizedDir = options.dir.replaceAll("\\", "/").replace(/\/+$/, "");
  return (
    normalizedDir === "governance-watchdog" ||
    normalizedDir.endsWith("/governance-watchdog") ||
    options.label === "governance-watchdog"
  );
}

/**
 * @param {{dir: string; label: string}} options
 * @returns {boolean}
 */
function isRootAudit(options) {
  const normalizedDir = options.dir.replaceAll("\\", "/").replace(/\/+$/, "");
  return (
    normalizedDir === "." || normalizedDir === "" || options.label === "root"
  );
}

/**
 * @param {Record<string, any>} advisory
 * @param {Record<string, any>} finding
 * @param {string} path
 * @param {{dir: string; label: string}} options
 * @returns {boolean}
 */
export function isAllowedDiscordUndiciFinding(
  advisory,
  finding,
  path,
  options,
) {
  if (advisory.module_name !== "undici") return false;
  if (finding.version !== "6.24.1") return false;
  if (
    !(isRootAudit(options) && ROOT_DISCORD_UNDICI_PATHS.has(path)) &&
    !(
      isGovernanceWatchdogAudit(options) &&
      GOVERNANCE_STANDALONE_DISCORD_UNDICI_PATHS.has(path)
    )
  ) {
    return false;
  }

  return advisoryIds(advisory).some((id) =>
    DISCORD_UNDICI_ADVISORY_IDS.has(id),
  );
}

/**
 * @param {Record<string, any>} advisory
 * @returns {Array<{finding: Record<string, any>; path: string}>}
 */
export function findingPaths(advisory) {
  const findings = Array.isArray(advisory.findings) ? advisory.findings : [];
  if (findings.length === 0) {
    return [{ finding: {}, path: "<missing finding path>" }];
  }

  return findings.flatMap((finding) => {
    const paths = Array.isArray(finding.paths) ? finding.paths : [];
    if (paths.length === 0) {
      return [{ finding, path: "<missing finding path>" }];
    }
    return paths.map((path) => ({ finding, path: String(path) }));
  });
}

/**
 * @param {Record<string, any>} report
 * @param {{dir: string; label: string}} options
 * @param {{includeAdvisory?: (advisory: Record<string, any>) => boolean}} [filters]
 * @returns {{allowed: string[]; disallowed: string[]}}
 */
export function evaluateAuditReport(report, options, filters = {}) {
  if (report.error) {
    const message = report.error.message ?? JSON.stringify(report.error);
    throw new Error(`pnpm audit failed: ${message}`);
  }

  const includeAdvisory = filters.includeAdvisory ?? (() => true);
  const allowed = [];
  const disallowed = [];
  const advisories = Object.values(report.advisories ?? {});

  for (const advisory of advisories) {
    if (!includeAdvisory(advisory)) continue;

    const ids = advisoryIds(advisory);
    const id = ids[0] ?? "unknown-advisory";
    const moduleName = advisory.module_name ?? "unknown-module";
    const severity = advisory.severity ?? "unknown-severity";

    for (const { finding, path } of findingPaths(advisory)) {
      const version = finding.version ?? "unknown-version";
      const summary = `${id} ${severity} ${moduleName}@${version} via ${path}`;
      if (isAllowedDiscordUndiciFinding(advisory, finding, path, options)) {
        allowed.push(summary);
      } else {
        disallowed.push(summary);
      }
    }
  }

  return { allowed, disallowed };
}

/**
 * @param {Record<string, any>} advisory
 * @param {Record<string, any>} finding
 * @param {string} path
 * @param {string} lockfile
 * @returns {Record<string, any>}
 */
export function advisoryRecord(advisory, finding, path, lockfile) {
  const ids = advisoryIds(advisory);
  return {
    id: ids[0] ?? "unknown-advisory",
    module_name: advisory.module_name ?? "unknown-module",
    severity: advisory.severity ?? "unknown-severity",
    title: advisory.title ?? "",
    vulnerable_versions: advisory.vulnerable_versions ?? "",
    patched_versions: advisory.patched_versions ?? "",
    version: finding.version ?? "unknown-version",
    path,
    lockfiles: [lockfile],
  };
}
