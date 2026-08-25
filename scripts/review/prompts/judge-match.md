You are matching a code review against a list of defects that were actually reported
on this exact change by other reviewers, and later fixed by the author.

For each numbered defect, decide whether THE REVIEW BELOW identifies that same defect.

Same defect means: the review names the same underlying problem. Different wording, different
severity, or a different suggested fix still counts as a match. Naming the same file while
describing an unrelated problem does NOT count. Being vaguely worried about an area does NOT
count — the review must identify the actual problem.

DEFECTS:
{{DEFECTS}}

THE REVIEW:
<<<REVIEW
{{REVIEW}}
REVIEW

Reply with ONLY a JSON object:
{"matches": [<defect numbers the review identifies>],
"reasoning": {"<defect number>": "<one line: what in the review matched, or why it did not>"}}
