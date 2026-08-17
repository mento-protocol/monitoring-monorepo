/**
 * pnpm override selector parsing, shared by every reader of `pnpm.overrides`
 * and `resolutions`.
 *
 * A selector may carry a path qualifier (`parent>child`) and a version range
 * (`body-parser@<1.20.3`), and the range itself may contain `>` and `>=`. The
 * split between the two meanings is the whole problem this module solves.
 *
 * Two callers read the same selectors with different consequences:
 * `scripts/supply-chain/lockfile-lint-override-ranges.mjs` fails CI on an
 * unbounded minimum, and `scripts/supply-chain/override-prune-report.mjs`
 * files an advisory issue that never fails anything. They used to carry
 * separate copies of this parser, so a divergence would have shown up as the
 * gate and the advisor disagreeing about the same syntax with nothing going
 * red. One module, one answer.
 */

/**
 * Decides whether the `>` at `index` separates two packages rather than
 * opening or continuing a version-range comparator.
 * @param {string} selector
 * @param {number} index
 */
export function isPeerSelectorSeparator(selector, index) {
  const previous = selector[index - 1] ?? "";
  const next = selector[index + 1] ?? "";
  return (
    next !== "" &&
    next !== "=" &&
    previous !== "@" &&
    previous !== "<" &&
    previous !== ">" &&
    previous !== "=" &&
    !/\s|\|/.test(previous)
  );
}

/**
 * Splits a pnpm override selector on bare `>` path separators (e.g.
 * `parent>child`), distinct from `>`/`>=` used inside a version range.
 * @param {string} selector
 * @returns {string[]}
 */
export function peerQualifiedSelectorParts(selector) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    if (selector[index] === ">" && isPeerSelectorSeparator(selector, index)) {
      parts.push(selector.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts;
}

/**
 * Strips any path qualifiers (`parent>child`) and version-range suffix from a
 * pnpm override selector, leaving the bare package name.
 * @param {string} selector
 * @returns {string}
 */
export function packageNameFromOverrideSelector(selector) {
  const parts = peerQualifiedSelectorParts(selector);
  const packageSelector = parts[parts.length - 1] ?? selector;
  const rangeSeparator = packageSelector.indexOf("@", 1);
  return rangeSeparator === -1
    ? packageSelector
    : packageSelector.slice(0, rangeSeparator);
}
