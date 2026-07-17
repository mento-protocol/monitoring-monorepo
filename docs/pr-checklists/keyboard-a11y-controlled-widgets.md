---
title: Keyboard Accessibility on Controlled Widgets Checklist
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
doc_type: checklist
scope: ui-dashboard
review_interval_days: 90
garden_lane: pr-checklists-process
---

# Keyboard a11y on controlled widgets PR Checklist

Use this checklist for any PR that adds or changes keyboard handling on a controlled widget — `role="radiogroup"`, `role="tablist"`, `role="listbox"`, `role="menu"` — in `ui-dashboard/`.

## Operating rule

> **WAI-ARIA roving-tabindex must follow the focused element, not the selected/active prop. Manual activation (Enter/Space) is required when activation has a side-effect like `router.replace`.**

The naive implementation — tying `tabIndex={0}` to a `selected` / `active` prop and firing `onSelect` per arrow key — passes both the WAI-ARIA APG and unit tests in isolation. Under React's render-cycle lag (URL-backed callers) and on widgets with expensive activation, it fails in two specific ways that the rules below close.

---

## 1. Roving `tabIndex` follows focus, not the selected prop

Use the shared `useRovingTabIndex` helper. It keeps the single tab stop on the
locally focused item while treating the controlled prop as the active item:

```tsx
const activeIndex = /* derive from selected prop */;
const { groupRef, getItemProps, handleKeyDown } = useRovingTabIndex({
  activeIndex,
  itemCount: options.length,
  activation: "manual", // or "automatic" for a radio group
  arrowKeys: "horizontal",
});

const rovingProps = getItemProps(i);
<button
  ref={rovingProps.ref}
  tabIndex={rovingProps.tabIndex}
  onFocus={rovingProps.onFocus}
  onClick={...}
>
```

- [ ] The group uses `ui-dashboard/src/lib/use-roving-tab-index.ts` instead of
      reimplementing keyboard/focus state.
- [ ] Every option spreads the helper's `ref`, `tabIndex`, and `onFocus`
      contract.
- [ ] External prop changes (for example browser back) re-sync only when focus
      is outside the group; the shared helper owns this behavior.

**Why this rule:** under URL-backed callers (e.g. a filter that calls `router.replace` in `onChange`), the `selected` prop lags one render cycle behind keyboard activity. If `tabIndex={0}` is tied to the stale prop, the user can `Tab` from the focused option BACK to the stale tab stop instead of leaving the group. Codex flagged this on PR #350 round 3 (BridgeStatusFilter + PoolTablist). Manual activation patterns make the divergence permanent — focus can sit on a non-selected option indefinitely.

---

## 2. Manual activation when `onSelect` has a side-effect

Default to **manual activation** (arrows move focus only; Enter/Space activates) for any tablist whose `onSelect` causes:

- A Next.js `router.replace` / `router.push` — RSC refetch per call.
- A network fetch (REST, GraphQL, SWR revalidation).
- Any work measured in tens of ms or more.

```tsx
function handleKeyDown(e) {
  // ...arrow / Home / End logic to compute nextIndex...
  // Manual activation: focus only. Activation lives on Enter/Space via
  // the native <button>'s onClick → onSelect.
  options[nextIndex]?.focus();
}
```

- [ ] If `onSelect` triggers `router.replace` / RSC refetch / network fetch, arrow keys move focus only.
- [ ] Enter/Space activate via the native `<button>`'s `onClick` (no manual key handling needed).
- [ ] Tests assert `onSelect` is NOT called on arrow keys, IS called on click.
- [ ] JSDoc on the component cites WAI-ARIA APG and the cost of activation as the reason for manual activation.

**Why this rule:** automatic activation (selection follows focus) on a URL-backed tablist fires a `router.replace` per arrow keystroke. A held arrow key turns into a navigation storm with N RSC refetches; a quick arrow reversal hits a stale-prop race because the prop hasn't re-rendered between keystrokes. Codex flagged this on PR #350 (PoolTablist / BridgeStatusFilter). The WAI-ARIA APG explicitly supports manual activation as the variant for expensive activation:

> _"When focus moves into the tab list, places focus on the active `tab` element. When the tab list contains the focus, moves focus to the next or previous tab. Optionally, activates the newly focused tab (See note below). [...] If the tab panels associated with each tab contain content that has been loaded via Ajax (or DOM manipulation) and is computationally expensive, then it is recommended that designers wait for users to explicitly activate tabs that change a tab panel's content."_ — [WAI-ARIA APG: Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)

Radio groups are tighter to spec — selection IS supposed to follow focus. For 5–10 pills with cheap callbacks, accept the per-arrow `onChange` fire and don't add an equality guard against the stale prop (see rule 3).

---

## 3. Never gate the keyboard `onChange` / `onSelect` against the stale prop

In the keyboard handler, do NOT skip `onChange(value)` when `value === selected`:

```tsx
// WRONG — racy with URL-backed callers:
if (newValue !== selected) onChange(newValue);

// RIGHT — always fire:
onChange(newValue);
```

- [ ] No `if (newValue !== selected)` (or equivalent equality guard) wrapping `onChange` / `onSelect` in keyboard paths.
- [ ] Same-URL `router.replace` is deduped by Next; don't try to dedupe in the widget.

**Why this rule:** the equality guard was supposed to suppress no-op activation, but on URL-backed widgets `selected` lags. End-then-Home before the URL re-renders computed `newValue === null === selected (stale)` and skipped the Home activation, leaving the End navigation as the final state with focus desynced from selection. Codex flagged this on PR #350 round 1.

---

## 4. Common gotchas

### `@eslint-react/hooks-extra/no-direct-set-state-in-use-effect`

The shared helper performs render-time prop sync, which avoids this lint rule.
If a genuinely different widget cannot use the helper, use the same guarded
pattern:

```tsx
const lastSeenRef = useRef(prop);
if (lastSeenRef.current !== prop) {
  lastSeenRef.current = prop;
  if (someCondition) setLocalState(prop);
}
```

`setState` during render is React-supported for derived-from-prop sync — React schedules a re-render and discards the in-progress one. Don't add `// eslint-disable` for this case; the render-time pattern is cleaner and idiomatic.

### `aria-required-children` violations

`role="tablist"` MUST contain only `role="tab"` children (axe critical: `aria-required-children`). If the visual layout puts a `<select>` or other interactive next to the tabs (e.g. an inline page-size selector), wrap the tablist in a flex container and put the sibling element OUTSIDE the tablist:

```tsx
// WRONG — <select> is a child of the tablist:
<div role="tablist">
  {tabs.map(...)}
  <select>...</select>  {/* axe critical */}
</div>

// RIGHT — sibling under a shared flex container:
<div className="flex">
  <div role="tablist">{tabs.map(...)}</div>
  <select>...</select>
</div>
```

### `aria-controls` referencing non-rendered panels in tests

When testing a tablist in isolation, render a stub `<div role="tabpanel" id="panel-${active}">` so the active tab's `aria-controls` resolves under axe's `aria-valid-attr-value` check.

---

## See also

- `ui-dashboard/src/components/bridge-status-filter.tsx` — radiogroup reference impl (selection follows focus, no equality guard).
- `ui-dashboard/src/app/pool/[poolId]/_components/pool-tablist.tsx` — tablist reference impl (manual activation).
- `ui-dashboard/src/lib/use-roving-tab-index.ts` — shared focus and keyboard helper.
- `ui-dashboard/src/__tests__/a11y/controls.a11y.test.tsx` — keyboard contract tests, including the roving-tabindex assertions and the tabpanel-stub pattern.
- WAI-ARIA APG: [Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/), [Radio](https://www.w3.org/WAI/ARIA/apg/patterns/radio/).
