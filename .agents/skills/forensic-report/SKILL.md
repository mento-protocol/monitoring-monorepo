---
name: forensic-report
description: Use this skill when investigating a specific on-chain address (operator EOA, contract, attacker, MEV bot, suspicious counterparty, etc.) and producing a forensic report for the Mento address book. Triggers on requests like "investigate 0x...", "produce a forensic report on this address", "who is 0x...", "/forensic-report", "/onchain-sleuth", "/detective", or any time you're asked to identify an unknown address that interacts with Mento and the answer needs to land in the address-book report editor. Apply whenever the goal is a long-form attribution + activity write-up that gets stored in the `reports` Upstash hash.
---

# Forensic Report

Produce a structured investigation report for an on-chain address and (optionally) push it directly to the production `reports` hash in Upstash so it shows up in the address book without copy-paste.

## When to use this

You're looking at an address that matters to Mento — a counterparty pulling funds out of a Mento pool, an MEV bot whose pattern keeps showing up in swap traces, a deployer of a contract you don't recognise, a wallet flagged in an alert — and you want a durable attribution + activity write-up rather than a 500-char `notes` blurb. The output goes into the address book's Forensic Report tab and feeds the 📄 indicator on the address book index.

If the answer fits in `notes` (≤500 chars, single fact like "Binance hot 14"), use the label form instead.

## Inputs

- **address** (required): `0x…` (40 hex chars). Skill normalises to lowercase.
- **context** (optional, one line): why you started looking — "showed up in the breaker-trip post-mortem", "biggest counterparty on the Mento broker last month", etc. Used in the TL;DR.
- **chain hint** (optional): default Celo since that's where Mento lives. Used for the storage probe + tx-anatomy section.

## Output

Two artefacts:

1. **Local draft** at `.investigations/<address>-<slug>.md` (slug = first-3 words of derived display name, lowercase, kebab-cased). The `.investigations/` folder is gitignored — never commit drafts.
2. **Optional production upload**: an atomic Lua upsert (`EVAL`) against the `reports` hash in the `address-labels` Upstash database, called via `mcp__upstash__redis_database_run_redis_commands`. The script — same one `upsertReport()` in `ui-dashboard/src/lib/address-reports.ts` runs — increments `version`, preserves `createdAt` from any prior record, and stamps `updatedAt` inside a single Redis execution. Atomicity matters: the editor route uses the same script, and a split read-modify-write here would let two writers both observe `v=N` and both write `v=N+1`. The skill stamps `source: "Codex"` so the editor can distinguish skill-produced from hand-typed reports.

## Output template

The literal shape every report follows lives at `template.md` next to this file. Read it once, then mirror its structure exactly: same eight named H2 sections in the same order (TL;DR, Cast of characters, What it does, Transaction anatomy, Capital and scale, Why \_\_\_ why these venues, Arkham coverage, Bottom line), same code-fenced storage / tx blocks, same "Investigation date" footer. The template is the spec — don't invent new sections, don't drop existing ones, don't reorder.

## Procedure (how to fill the template)

Run these in order. Each step maps onto a section of the template — fill that section as evidence comes in, don't wait until the end.

### Step 1 — Bootstrap

```bash
ADDR=$(echo "0x…" | tr 'A-Z' 'a-z')   # always lowercase the storage key
CHAIN=celo                            # default; override if user said otherwise
DATE=$(date -u +%F)
mkdir -p .investigations
```

Check whether a report already exists (we may be UPDATING, not creating):

```js
mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [["HGET", "reports", "<addrLower>"]],
});
```

If a report exists, parse it for `version` and `createdAt` — you'll preserve them on upload.

Also pull any existing label so the H1 nickname matches what's in the address book:

```js
commands: [["HGET", "labels", "<addrLower>"]];
```

### Step 2 — Cast of characters (Arkham + funder graph)

Use the `arkham` skill (project-scoped). Arkham doesn't cover Celo or Monad, so the play is:

1. Run `address_enriched/all` on the target address — gets every chain Arkham DOES cover. Often returns zero hits for a Celo-native contract; that's a signal, not a failure.
2. Walk inbound funders on the target chain. Two pitfalls to handle explicitly:
   - **Sim's Activity API returns NEWEST first**, not oldest. Don't take the top result and call it the FIRST funder — paginate to the tail (or use a `block_time ASC` DuneSQL query) before treating any counterparty as the original funder. A recent counterparty mistaken for the original funder permanently mis-attributes the report.
   - **Sim's `--chain-ids` defaults to all configured chains** when omitted. For an EVM address that's been used on Ethereum / Base / Arbitrum / etc., the "first receive" without a chain filter can come from a totally different chain than the target. Always pass `--chain-ids $CHAIN_ID` so the funder graph is scoped to the chain the contract actually lives on.

   Example — first inbound transfer on Celo, oldest first via DuneSQL (Sim CLI doesn't expose an `--asc` flag at the time of writing):

   ```sql
   SELECT block_time, "from", value, hash
   FROM celo.transactions
   WHERE "to" = LOWER('<addr>')
   ORDER BY block_time ASC
   LIMIT 5;
   ```

   That funder is usually the operator EOA.

3. Run `address_enriched/all` on the operator EOA across all chains — this is where personas like ENS / opensea / multichain footprint usually surface.
4. Trace one more hop back: who funded the operator? If it's a bridge (Stargate, LayerZero, Hop, Across), name the bridge in the table.
5. For contracts: also pull the deployer (the `from` of the contract-creation tx) — it may differ from the operator. Note both rows in the table.

For each address you add to the Cast: include age (days since first activity), multichain footprint (which chains it's been seen on), and a one-line "what it does" note.

### Step 3 — What it does

**For a contract target** — read public storage directly. Most arb / MEV contracts leave trivial getters in (router addresses, allowlists, fee tiers, hardcoded principals). Use the chain's full-node RPC (NOT HyperRPC — `eth_call` requires a full node):

```bash
RPC=https://forno.celo.org   # or whatever full-node RPC for the target chain
cast call $ADDR "router()(address)" --rpc-url $RPC
cast call $ADDR "routerSushi()(address)" --rpc-url $RPC
cast call $ADDR "lastAddress()(address)" --rpc-url $RPC
# … etc, try every name a typical arb contract uses
```

If the contract is verified (sourcify or Celoscan): pull source, name the patterns. If unverified: look at the top selectors by frequency on Celoscan / explorer; OpenChain-decode any matching ones (`https://openchain.xyz/signatures?function=0x…`).

**For an EOA target** — behavioural profile. Top counterparties (`dune sim evm activity` filtered by counterparty), top tokens held (`dune sim evm balances`), tx-time distribution if relevant.

### Step 4 — Transaction anatomy

Pick a representative tx — preferably a recent successful one with the typical calldata shape. Use `cast tx <hash> --rpc-url $RPC` for the raw shape, then decode the selector via OpenChain.

Note the revert rate. For arb / MEV: ~30–50% reverts is normal (failed sniping). If it's lower, the bot is well-tuned; higher, it's overshooting.

### Step 5 — Capital and scale

Pass the chain hint through to Sim — Mento is on Celo (`42220`) but the skill also runs against Monad (`143`) and any future chain. Hardcoding `--chain-ids 42220` would return empty / unrelated holdings for a Monad principal:

```bash
CHAIN_ID=42220   # Celo mainnet. Monad mainnet is 143 (testnet is 10143 — use mainnet for prod investigations). Map other chains by their canonical mainnet chain id.
dune sim evm balances $PRINCIPAL --chain-ids $CHAIN_ID -o json | jq '.balance_data | length'
dune sim evm balances $PRINCIPAL --chain-ids $CHAIN_ID -o json | jq '.balance_data[] | {symbol, amount, value_usd}'
```

Sum the USD value, drop scam airdrops (zero-value tokens with names like `CLAIM`, `voucher`). For tx volume, hit the chain's block explorer API (Celoscan, MonadScan, etc.) or use the explorer UI count.

### Step 6 — Why \_\_\_, why these venues

Free-form prose, but be specific. Don't say "arbitrage" — say which mispricing (`Mento broker is oracle-priced, Uniswap V3 is AMM-priced — the spread between them is the alpha`). Don't say "MEV" — say which kind (statistical arb / sandwich / liquidation / JIT).

### Step 7 — Arkham coverage

Be candid about what Arkham did and didn't tell you. If the chain isn't supported, say it. If Arkham returned zero, say it. The "negative result" section is part of the audit trail — future you needs to know which leads were dead ends.

### Step 8 — Bottom line

Five bullets, one sentence each: Who / What / Where / How much / Goal. This is the section a Slack reader will copy-paste, so it has to stand alone without the rest of the report.

### Step 9 — Save the draft

Write the finished markdown to `.investigations/<addr>-<slug>.md`. Slug = first 3 words of the H1 display name, lowercased, kebab-cased. Example: H1 `Arbitrage Executor (idontloseiwin.eth)` → slug `arbitrage-executor`.

### Step 10 — Push to production (only on user confirmation)

By default the skill stops at the local draft and asks the user to review. On `--upload` (or after the user explicitly says "ship it"), upload to Upstash via the SAME atomic Lua upsert the API route uses — never split-read-modify-write, which races the editor and any other skill invocation.

**Derive the uploader's email at runtime, not from a hardcoded value.** The skill is committed and runs from any teammate's checkout; hardcoding one email would mis-attribute every other person's reports and leak PII into git. Pull from `git config user.email`:

```bash
AUTHOR_EMAIL=$(git config --get user.email)
if [ -z "$AUTHOR_EMAIL" ]; then
  echo "git config user.email is unset — set it before uploading" >&2
  exit 1
fi
```

`git config user.email` is local + unauthenticated — a teammate with a stale or impersonated config could persist wrong audit metadata. The dashboard's editor route stamps `authorEmail` from the Google-Workspace-authenticated session for that reason; the skill bypasses the route to keep atomicity (see Lua section below) and so loses the session-auth check. Mitigation: **always show the derived email and ask the user to confirm it matches their workspace identity before sending the EVAL**. If the email is wrong, abort and tell them to fix `git config user.email` (or upload via the editor UI). For a stricter audit trail, route the upload through the editor instead.

**Validate inputs before building the payload.** The skill bypasses the API route, so it also bypasses `sanitizeReportInput` and `isValidAddress` — mirror their checks here or risk persisting a blank report or a Redis key that isn't an `0x` address (ENS, typo, truncation):

```js
// 1. Address — must match isValidAddress (`/^0x[a-fA-F0-9]{40}$/`)
const addrLower = String(addrInput).toLowerCase();
if (!/^0x[a-f0-9]{40}$/.test(addrLower)) {
  throw new Error("address must be a 0x-prefixed 40-hex string");
}

// 2. Body — non-empty after trim, ≤ 50KB. Mirrors `sanitizeReportInput`
//    in `ui-dashboard/src/lib/address-reports-shared.ts`.
const body = readFile(".investigations/<addr>-<slug>.md");
if (body.trim() === "")
  throw new Error("body is empty / whitespace-only — refusing to upload");
if (body.length > 50000) throw new Error("body exceeds 50KB cap");
```

**Build the partial payload** (Lua script stamps `createdAt` / `updatedAt` / `version`):

```js
const title = extractTitleFromH1(body); // text after the ` — ` separator, ≤200 chars
const partial = {
  body,
  ...(title ? { title: title.slice(0, 200) } : {}),
  authorEmail: AUTHOR_EMAIL, // from git config user.email at runtime
  source: "Codex", // already in the AddressReport enum
};
```

**Write it via Lua EVAL** (atomic — same script as `upsertReport()` in `ui-dashboard/src/lib/address-reports.ts`):

```js
const UPSERT_SCRIPT = `
local key = KEYS[1]
local addr = ARGV[1]
local payload = cjson.decode(ARGV[2])
local now = ARGV[3]

local existing = redis.call('HGET', key, addr)
local prior = nil
if existing then
  prior = cjson.decode(existing)
end

payload.createdAt = (prior and prior.createdAt) or now
payload.updatedAt = now
-- Coerce non-numeric prior versions to 0 before incrementing.
-- cjson.decode maps JSON null to cjson.null (truthy in Lua), so a
-- stored {"version": null} from a legacy/partial record would
-- propagate cjson.null into the arithmetic and crash the EVAL.
local priorVersion = prior and prior.version
if type(priorVersion) ~= 'number' then priorVersion = 0 end
payload.version = priorVersion + 1

local encoded = cjson.encode(payload)
redis.call('HSET', key, addr, encoded)
return encoded
`;

mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [
    [
      "EVAL",
      UPSERT_SCRIPT,
      "1",
      "reports",
      addrLower,
      JSON.stringify(partial),
      new Date().toISOString(),
    ],
  ],
});
```

The script returns the persisted record (already JSON-encoded). It handles every edge case the dashboard data layer handles:

- `createdAt` preserved when updating; stamped fresh on first write
- `updatedAt` always = now
- `version` = `(prior.version or 0) + 1` — works even when the prior record is a legacy/partial entry without a numeric `version` field (Lua coerces `nil` → `0`, so first write is `1`, never `NaN`)
- Atomic against concurrent writers — the editor route + this skill + any future caller can interleave without losing updates

**Verify:**

```js
mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [["HGET", "reports", addrLower]],
});
```

The address-book index endpoint reads from the same hash on every request, so the 📄 indicator + the report editor will pick up the new content on the next page load — no SWR mutate hook needed from this side.

## Schema invariants (mirror these — the API enforces the same rules)

- `body`: required, non-empty, ≤ 50,000 characters (50KB)
- `title`: optional, ≤ 200 characters, dropped if empty after trim
- `source`: `"manual" | "Codex" | "import"` — always set `"Codex"` from this skill
- `version`: starts at 1, increments on each write; preserve `createdAt` from the prior write if updating

These match `MAX_BODY_LENGTH` / `MAX_TITLE_LENGTH` in `ui-dashboard/src/lib/address-reports-shared.ts`. If those constants change, mirror the changes here — the skill must not write a payload the API would reject on a manual edit.

## Reference: production database

The database id is non-secret. If the address-book database is replaced or
split, update this value from Terraform or the Upstash console before writing.

```
database_id: c687bf0d-f61f-498e-879a-016de335b4ce
hash:        reports
key shape:   <lowercase 0x address>
value shape: JSON-stringified AddressReport (see schema above)
```

The `address-labels` Upstash database also holds the `labels` hash (custom address labels) and `minipay:*` keys (the MiniPay tagging cron's bookkeeping). Don't touch those from this skill.

## Worked example

The seed report — `0xb64c8b0a3F8008d5028D8F9323b858F17b18C3C4` (Arbitrage Executor / `idontloseiwin.eth`) — is the canonical reference. If a section feels under-specified above, look at how that section is written in the production hash:

```js
mcp__upstash__redis_database_run_redis_commands({
  database_id: "c687bf0d-f61f-498e-879a-016de335b4ce",
  commands: [["HGET", "reports", "0xb64c8b0a3f8008d5028d8f9323b858f17b18c3c4"]],
});
```

Match its tone (specific, evidence-anchored, code-fenced for storage / tx data), structure (the eight named sections in order), and length (1500–2500 words for a meaty target; less is fine for a thin one).

## Rules

- **Never commit a draft.** `.investigations/` is gitignored for a reason. If a report belongs in the team's history, it lives in the production `reports` hash + the daily Vercel Blob backup, NOT in git.
- **Never write a label or the `labels` hash from this skill.** Labels are a separate concern; the `arkham` skill or the address-book modal handles those.
- **Never push to prod without explicit user confirmation.** Local draft is the default; upload only on `--upload` or after the user says "ship it" / "upload it" / equivalent.
- **Mirror the schema invariants.** Don't write a payload the API would reject — that includes the body length cap, title length cap, version monotonicity, and `createdAt` preservation on update.
- **Cite evidence.** Every claim about an address gets a tx hash, an Arkham response, a Sim balance snapshot, or a storage read backing it. "Probably MEV" is not enough; "selector `0x49aa2402` calls into a contract whose public `routerUniswap()` returns Uniswap V3 SwapRouter02 (factory `0xafe208a3…` matches official UniV3 on Celo)" is.
- **Skip the report if attribution is weak.** Better to write a label + notes blurb than to ship a forensic report full of "may be" / "appears to be" / "possibly". Reports are durable; uncertainty in them poisons the audit trail.
