<!-- markdownlint-disable MD041 -->

## tl;dr

<!--
Plain words for a reader outside this codebase: who had the problem, what this
PR changes, what to expect after merge. No paths, flags, or identifiers.
-->

[Two to four plain sentences, about 60 words.]

## The Problem

<!--
Maximum three bullets: the old behavior, what failed, the concrete effect.
Raw HTML other than comments, paragraphs that contain it, and code blocks do not
count as an explanation. HTML comments do not invalidate adjacent Markdown prose.
-->

## The Solution

<!--
The new behavior, why it improves the situation, and any material limit or
non-goal. Same content rule as above: Markdown prose or bullets, not raw HTML.
-->

## Details

<!--
Only what a reviewer needs to read the diff: exact limits, invariants, caveats,
and scope boundaries.
-->

## Validation

<!--
One line per check. Group passes on one line with their counts. Give each
skipped, failed, not-run, or not-proven item its own line. Review rounds are a
count and an outcome, not a story. One "Not proven:" line covers the section
unless a gate needs its own. Name the head SHA once and give the step-4 scope
baseline as one line.
-->

- [Commands and results.]

## Deferrals

<!--
Everything knowingly deferred from this PR — reviewer findings you chose not
to address here, or work you judged out of scope — MUST have a GitHub issue
describing the problem (and solution ideas, if any). List the issue links
below. This section is OPTIONAL: delete it entirely when nothing was deferred.
When you keep it, CI requires each item to be "None" or link a GitHub issue.
-->

- None

## Checklist

- [ ] The tl;dr is two to four plain sentences a reader outside this codebase can follow.
- [ ] The Problem has no more than three bullets.
- [ ] The opening explains the old behavior, new behavior, and concrete benefit.
- [ ] The opening states any material limit or non-goal that applies.
- [ ] A reader can understand the opening without reading the diff.
- [ ] Deeper implementation details come after the opening two sections.
- [ ] Validation is one line per check; skipped, failed, and not-proven items each have their own line.
- [ ] Body is about 250 words, 400 at most, excluding this checklist.
- [ ] Every knowing deferral is listed under Deferrals with a GitHub issue link.
- [ ] Architecture decision? If this makes one, an ADR is added under `docs/adr/` (see `docs/pr-checklists/architecture-decisions.md`); otherwise not applicable.
