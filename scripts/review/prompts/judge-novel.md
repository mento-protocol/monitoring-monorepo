You are verifying claims made by a code reviewer against the real code.

The repository is at {{FIXTURE}}. The change under review is `git diff --no-ext-diff --no-textconv base HEAD`.
You have shell access. VERIFY each claim by reading the actual files — do not judge from plausibility.

These claims were made by the reviewer. Some are real defects; some are wrong; some are
vague hand-waving that names no concrete problem.

{{CLAIMS}}

Already-known defects (do NOT count these — they are scored separately):
{{KNOWN}}

For each numbered claim, classify it as exactly one of:
"real" — a genuine defect in this change, verified by you against the code
"wrong" — the claim is false; the code does not do what it says
"vague" — too unspecific to verify, or a style/preference note with no defect
"known" — restates one of the already-known defects above

Reply with ONLY JSON:
{"verdicts": {"1": {"class": "...", "why": "<one line, citing what you checked>"}, ...}}
