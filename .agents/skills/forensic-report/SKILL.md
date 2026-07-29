---
name: forensic-report
description: '[repo-skill] Use this skill when investigating a specific on-chain address (operator EOA, contract, attacker, MEV bot, suspicious counterparty, etc.) and producing a forensic report for the Mento address book. Triggers on requests like "investigate 0x...", "produce a forensic report on this address", "who is 0x...", "/forensic-report", "/onchain-sleuth", "/detective", or any time you''re asked to identify an unknown address that interacts with Mento and the answer needs to land in the address-book report editor. Apply whenever the goal is a long-form attribution + activity write-up that gets stored in the `reports` Upstash hash.'
title: Forensic Report Skill
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Forensic Report

Produce a structured investigation report for an on-chain address and (optionally) push it directly to the production `reports` hash in Upstash so it shows up in the address book without copy-paste.

## When to use this

You're looking at an address that matters to Mento — a counterparty pulling funds out of a Mento pool, an MEV bot whose pattern keeps showing up in swap traces, a deployer of a contract you don't recognise, a wallet flagged in an alert — and you want a durable attribution + activity write-up rather than a 500-char `notes` blurb. The output goes into the address book's Forensic Report tab and feeds the 📄 indicator on the address book index.

If the answer fits in `notes` (≤500 chars, single fact like "Binance hot 14"), use the label form instead.

## Inputs

- **address** (required): `0x…` (40 hex chars). Skill normalises to lowercase.
- **context** (optional, one line): why you started looking — "showed up in the breaker-trip post-mortem", "biggest counterparty on the Mento broker last month", etc. Used in the TL;DR.
- **chain hint** (optional): default Celo since that's where Mento lives. Used for the storage probe + tx-anatomy section. See the chain doctrine below — the _target_ chain is one thing, the operator's _cross-chain footprint_ is another.

## Chains & cross-chain doctrine

Two facts shape every tool choice in this skill:

1. **Mento is multi-chain and growing.** Celo (`42220`), Monad (`143`),
   Polygon (`137`), and Ethereum (`1`) are live in the production indexer.
   Ethereum currently carries reserve-yield monitoring. **Never hardcode
   `42220`**; thread the target chain id through every chain-scoped call.
2. **One key, many chains.** If someone controls a private key on Celo, the same EOA almost always has a history on other EVM chains (Ethereum, Base, Arbitrum, …). That cross-chain footprint is usually where the _identity_ lives — ENS, OpenSea, CEX deposits, prior bots — because the richest attribution tools (Arkham, Nansen, EigenPhi, MetaSleuth) index Ethereum/L2s but **not** Celo.

So split the work into two legs and pick tools per leg:

- **On-chain behaviour leg** (what the address _does_ — swaps, storage, capital, venues): use chain-native sources for Celo, Monad, or Polygon (the Mento Envio indexer where promoted, Blockscout/Polygonscan, Dune chain tables, GeckoTerminal / DexScreener, `cast` against the chain's RPC). These are the sources that actually see the target chain.
- **Cross-chain identity leg** (who is _behind_ the address): pivot the operator EOA onto the chains the heavyweight attributors cover and let them work there.

**Corollary — never drop a source just because it lacks Celo.** A Celo-blind tool (Nansen, EigenPhi, GoPlus, Across, …) can still be the right tool for the identity leg or for supported Mento chains such as Polygon. `references/tooling-matrix.md` records what each source covers and which leg it serves — consult it instead of assuming "no Celo = useless".

**Contract-target identity rule.** The same 20-byte address on another chain is
usually an unrelated account. So a cross-chain hit keyed on a **contract**
target's own address — including an `intel_*` cache hit — mis-attributes the
report. Identify the deployer/operator EOA first and run the identity leg on
**that** EOA. Only treat a same-address cross-chain hit as the target when
CREATE2/bytecode evidence proves the address is intentionally shared. For an
**EOA** target, a hit on the target's own address is fair game.

## Output

Two artefacts:

1. **Local draft** at `.investigations/<address>-<slug>.md` (slug = first-3 words of derived display name, lowercase, kebab-cased). The `.investigations/` folder is gitignored — never commit drafts.
2. **Optional production upload** to the `reports` hash via the exact
   optimistic-concurrency (CAS) Lua upsert owned by `upsertReport()` in
   `ui-dashboard/src/lib/address-reports.ts`. See Step 10.

## Output template

The literal shape every report follows lives at `template.md` next to this file.
Its frontmatter is governance metadata and is **not** copied into a report. Read
the body once, then mirror its named H2 sections, order, evidence blocks,
confidence tags, and two-line provenance footer exactly. The template is the
spec: do not invent, drop, or reorder sections. Keep "Related addresses /
fleet" even when clustering found nothing and record that result in one line.
Match the template's evidence-anchored, plain-language tone and aim for
**1,500–2,500 words** in the finished report.

Existing production reports can help calibrate tone, but they are historical
data and may predate this contract. `template.md` is the sole structural
authority. Never copy a seed report's facts, section omissions, provider
assumptions, or provenance into a new investigation.

## Procedure (how to fill the template)

Run these in order. Each step maps onto a section of the template — fill that
section as evidence comes in, don't wait until the end. A step whose heading
names a file under `references/` keeps its deep procedure there; every other
step carries its full procedure here.

### Step 1 — Bootstrap → `references/chain-setup.md`

Lowercase the address, set `CHAIN`, and derive `CHAIN_ID` / `RPC` / `DUNE_NS` / `DL_NS` from it in **one** case switch so a non-Celo investigation can't silently read Celo data. Capture provenance up front — `HEAD_BLOCK`, RPC endpoint, `cast --version`, and the UTC timestamp of each Sim/DefiLlama query — because mutable-state reads are only reproducible pinned to a block. Then discover the `address-labels` database by exact name (never hardcode its opaque id) and `HGET` both `reports` and `labels` for the address: an existing report means you're updating, and an existing label sets the H1 nickname.

### Step 1.5 — Check Upstash caches first → `references/chain-setup.md`

Five Arkham-derived caches live in that same database — three address-keyed (`intel_deep`, `intel_transfers`, `intel_wealth`) and two entity-slug-keyed (`intel_entities`, `intel_entity_cps`, joined via `intel_deep`'s `arkhamEntity.id`). Prefer a current cache hit over a live call. **These caches ARE the cross-chain identity leg**: they see the chains Arkham covers, not Celo/Monad, so for a Celo-native address an empty result is itself the finding, not a failure. Consume them subject to the contract-target identity rule above.

### Step 1.6 — Mento indexer fingerprint → `references/indexer-queries.md`

The production Envio endpoint is the **primary on-chain-behaviour source** for the target chain, and the only one that answers "what did this address do with Mento" on Celo and Monad. Probe liveness and per-chain coverage before trusting any empty result — a pruned deployment is not a "no activity" finding — then run the address battery with `chainId` scoped to the target chain and the filter field matched to the target type (`caller` for an EOA; `sender`/`txTo`/`recipient`/`brokerCaller` for a contract, or a `caller`-only filter returns a false EMPTY). A verified-live empty result is a real signal. Query this before the funder graph.

### Step 2 — Cast of characters (multi-chain attribution + funder graph)

**Known-infra check first.** Before walking the funder graph or decompiling anything, match the target and its counterparties against the repo's canonical registries so you never mislabel protocol infrastructure as a suspicious actor:

- `indexer-envio/config/aggregators.json` + shared-config `getAggregatorName(chainId, addr)` → instant match to `mento-router-v2` / `squid` / `lifi` / `0x` / `openocean`, **and** to any named MEV fleet cluster already documented there (those carry a pre-written narrative you can reuse verbatim in Steps 3/6/8).
- shared-config `chainAddressLabels(chainId)` / `tokenSymbol()` (from `@mento-protocol/contracts`) → labels broker / reserve / pools / stables / fee recipients, and gives correct explorer links via `explorerAddressUrl`.
- `indexer-envio/config/oracle-reporters.json` + `protocolActors.json` + active `PoolLiquidityStrategy` rows → flags Chainlink feeds / reporters / listed rebalancers as infra. An active strategy row means an authorised protocol strategy contract, not an independent bot.

Then attribution, via the `arkham` skill (project-scoped) for the identity leg:

1. **Branch on target type before any cross-chain enrichment** — see the contract-target identity rule above. EOA target → run `address_enriched/all` on it. Contract target → identify the deployer/operator EOA first, then run the identity leg on that EOA.
2. Walk inbound funders on the target chain. Three pitfalls, all of which permanently mis-attribute a report:
   - **Sim's Activity API returns NEWEST first.** Don't take the top result and call it the FIRST funder — paginate to the tail, or use a `block_time ASC` DuneSQL query.
   - **Sim's `--chain-ids` defaults to all configured chains** when omitted, so a "first receive" can come from a different chain entirely. Always pass `--chain-ids $CHAIN_ID`.
   - **The native-`value` query has an ERC20 blind spot.** If funding arrived as a stablecoin, an oldest-first scan of `value > 0` misses it — repeat the scan over ERC20 `Transfer` logs (Dune) or Sim token transfers before naming a funder.

   ```sql
   SELECT block_time, "from", value, hash
   FROM <chain>.transactions
   WHERE "to" = FROM_HEX('<40 hex chars without 0x>') AND value > 0
   -- Dune addresses are varbinary: use FROM_HEX or a bare 0x literal, never LOWER(text).
   ORDER BY block_time ASC
   LIMIT 5;
   ```

3. Run `address_enriched/all` on the operator EOA **across all chains** — this is where personas (ENS / OpenSea / prior bots / CEX deposits) surface, and often the whole attribution.
4. Trace one more hop back: who funded the operator? **Mento's own bridge is Wormhole NTT**, not the generic Ethereum bridges. Check indexer `BridgeTransfer` / `BridgeBridger` first, then confirm via **Wormholescan** (free, no key): `GET https://api.wormholescan.io/api/v1/operations?address=0x…&appId=NATIVE_TOKEN_TRANSFER` — Wormhole uses its own chain ids (Celo=14, Monad=48), NOT EVM chain ids. Match counterparties against `indexer-envio/config/nttAddresses.json` so NTT infra is labelled a bridge flow, not a funder. For non-Mento inbound bridges: **LayerZeroScan** covers Celo (`GET https://scan.layerzero-api.com/v1/messages/wallet/{eoa}`, Celo EID=30125); Across/deBridge cover **Monad only**.
5. For contracts: pull the deployer (the `from` of the contract-creation tx) — it may differ from the operator. Note both rows in the table; the deployer seeds Step 2.5.
6. **ENS de-anon pivot.** A Celo address's ENS primary name lives in the **Ethereum L1** reverse registry — forno can't answer it. Resolve via `viem` `getEnsName({ address, coinType })` against an L1 RPC with the ENSIP-11 coinType **`0x80000000 | $CHAIN_ID`** (Celo `42220` → `0x8000A4EC`, namespace `a4ec.reverse`; Monad `143` → `0x8000008F`). **A common doc example mis-states Celo as `0x8000A4DC`, which decodes to chain 42204 — wrong.** Also try the default L1 reverse record: viem's `getEnsName` defaults to Ethereum coinType `60`, which many owners set regardless of chain. Call it once with the default and once with the chain-specific coinType. Mostly negatives for bot EOAs; one hit is gold.

For each address you add to the Cast: age (days since first activity), multichain footprint, a one-line "what it does" note, and a **confidence tier**.

### Step 2.5 — Operator-fleet clustering (find the OTHER bots)

The highest-confidence attribution signal is **linkage**: what else did this operator deploy, fund, or run identical bytecode for. Three heuristics, all on Dune `<chain>.*` (existing `dune` skill, no new credential) plus `cast`; feed results into the template's "Related addresses / fleet" table.

```sql
-- (1) DEPLOYER FAN-OUT: every contract a deployer created.
--     For CREATE2 the trace "from" is the FACTORY — recurse to the factory's own deployer.
SELECT address, block_time, length(code) AS code_len, tx_hash
FROM <chain>.creation_traces WHERE "from" = <deployer> ORDER BY block_time ASC;
-- (2) COMMON-FUNDER CLUSTERING: every sibling EOA the operator's gas-refill EOA funded.
SELECT "to" AS funded, count(*) n, min(block_time) first_fund
FROM <chain>.transactions WHERE "from" = <funder> AND value > 0 GROUP BY 1 ORDER BY n DESC;
-- (3) CODEHASH CLUSTERING: byte-identical bots, across different deployers/factories. Pre-filter
--     creation_traces candidates by length(code), then confirm the runtime codehash by keccak match:
--       CODE=$(cast code "$ADDR" --rpc-url "$RPC"); cast keccak "$CODE"
```

**Mandatory false-positive gates** — an unverified link is worse than none:

- `value > 0` on funder edges; **never** treat a CEX hot wallet or a public CREATE2 factory as a "funder" — they fan out to thousands and create a garbage super-cluster.
- EIP-1167 minimal-proxy clones share a codehash that differs only by the embedded impl address — cluster on the **impl**, not the clone shell.
- Require a **second independent signal** (codehash + funder, or + activity-clock from Step 3) before asserting a link. Tag each link with a confidence tier.
- **Never auto-merge.** Propose links a human ratifies; the report states the evidence, not a verdict.

### Step 3 — What it does → `references/contract-analysis.md`

For a **contract target**, read public storage directly with block-pinned `cast call` against the chain's full node (`eth_call` needs one, so not HyperRPC) — most arb/MEV contracts leave trivial getters in. Before concluding "no interesting getters": check the EIP-1967 impl/admin/beacon and EIP-1822 slots (a non-zero value means you've been reading an empty shell, and the **beacon slot's last 20 bytes are the beacon, not the implementation** — call `beacon.implementation()`), check Sourcify for verified source, then decompile with Dedaub / heimdall-rs / WhatsABI. For an **EOA target**, build a behavioural profile: top counterparties, top tokens, and the activity-clock / first-seen / approval-graph fingerprints. If the target is a Gnosis Safe, pull `getOwners()` and `getThreshold()` and link Safes by intersecting owner sets.

### Step 4 — Transaction anatomy

Pick a representative tx — a recent successful one with the typical calldata shape. Use `cast tx <hash> --rpc-url $RPC` for the raw shape, then decode the top-level selector via OpenChain.

**For internal calls and raw state deltas, use Blockscout — not `cast`.** `forno.celo.org` (and most public full nodes) **exposes no trace methods**. The free Blockscout v2 API returns paginated, flat internal-transaction records and raw state changes; it does not return a nested call tree or dollar-valued flow. Pick the base per chain (`celo` → `https://celo.blockscout.com/api/v2`, `polygon` → `https://polygon.blockscout.com/api/v2`; Monad has none), then:

```bash
curl -s "$BS/transactions/$TX/internal-transactions" | jq '{next_page_params, items: [.items[] | {type, from:.from.hash, to:.to.hash, value, error}]}'
curl -s "$BS/transactions/$TX/state-changes"         | jq '{next_page_params, items: [.items[] | {addr:.address.hash, type, change}]}'
```

Follow `next_page_params` until exhausted; expect internal transactions to be empty on simple transfers. Reconstruct nesting only from trace evidence, and price raw token/native deltas separately at the transaction timestamp. On chains without Blockscout, use `debug_traceTransaction` only against an archive endpoint that supports it.

> **Do NOT use `cast run` on Celo.** It chokes on Celo's CIP-64 fee-currency tx type `0x7b` — the _dominant_ tx type since Gingerbread — with `unknown variant 0x7b`, failing on essentially every Mento-active block; forno is non-archive anyway. For a full trace prefer Blockscout or an RPC-native `debug_traceTransaction` against a Celo archive endpoint that understands CIP-64 (dRPC / QuickNode / Tenderly on `42220`).

**Revert rate — measure, don't assume.** Since 2025-03 Celo is an OP-Stack L2 with a single sequencer: no public mempool, no Flashbots/PBS bundle market, ordering is sequencer-internal priority-fee. The revert mechanism is therefore priority-fee "first-spammed-first-served" backrunning, not competitive sandwich PGA wars, and Ethereum-PGA revert-rate rules of thumb don't transfer. Compute the actual revert rate for _this_ target and interpret it against that model. Monad's ordering differs again (own consensus / FastLane) — don't copy Celo's framing onto Monad.

### Step 5 — Capital and scale → `references/pricing.md`

Snapshot holdings with `dune sim evm balances $PRINCIPAL --chain-ids $CHAIN_ID`, paginating on `--offset` until `next_offset` is absent, and run it a second time with `--exclude-unpriced=false` for the scam/noise inventory. Sum supported USD values and inventory unpriced assets separately: a missing or low-confidence price is evidence needing corroboration, not proof of a scam.

### Step 5.5 — Historical USD valuation → `references/pricing.md`

Sim's `value_usd` is current spot, so "moved $2M in March" is wrong the moment the token moves. Price flows at the time they happened via DefiLlama's free coins.llama.fi oracle, keyed `$DL_NS:{tokenLower}`; no Pro key is needed or useful here. Note that the coins.llama.fi host is **not on the default sandbox network allowlist** — allowlist it or run the single read-only GET unsandboxed.

### Step 6 — Why \_\_\_, why these venues

Free-form prose, but be specific. Don't say "arbitrage" — say which mispricing (`Mento broker is oracle-priced, Uniswap V3 is AMM-priced — the spread between them is the alpha`). Don't say "MEV" — say which kind (statistical arb / sandwich / liquidation / JIT).

**Name the venue, don't guess it.** Resolve any non-Mento pool or token through GeckoTerminal (`https://api.geckoterminal.com/api/v2/networks/$GT_NS/pools/{poolAddr}`, header `accept: application/json;version=20230302`) and DexScreener (`https://api.dexscreener.com/token-pairs/v1/$DS_NS/{tokenAddr}`). Both use their **own** network slugs, not chain ids (`celo`/`celo`, `monad`/`monad`, `polygon_pos`/`polygon`, `eth`/`ethereum`) — select both in one case switch on `$CHAIN` and verify against `api.geckoterminal.com/api/v2/networks` before trusting a negative, since a chain may be on one and not the other. Use the chain-scoped `token-pairs/v1` endpoint so a same-address token on another chain can't lend its venue or TVL to your report. GeckoTerminal's public limit is roughly 10 requests/minute; pace and cache rather than reading a rate-limit response as empty coverage.

**MEV classification across chains.** Borrow the standard taxonomy (arb / sandwich / backrun / JIT / liquidation), then derive the classification from the indexer and Dune's unified `dex.trades` table filtered by `blockchain`, grouping cycles by transaction. For sandwiches, use a curated sandwich dataset where supported; otherwise prove ordering with transaction position, event index, and trace evidence — block number alone cannot order transactions. Use an Ethereum/L2 EigenPhi or zeromev result only as cross-chain corroboration.

### Step 7 — Coverage and dead ends

A per-source audit trail: a future reader needs to know what you _looked at_ and why a lead was dead, not just what you found. Render it as the table `template.md` shows — one row per source attempted, marked `HIT` / `EMPTY` / `NOT-COVERED` / `NOT-ATTEMPTED` with a one-line why.

The distinction between `EMPTY` (source covers this chain, found nothing) and `NOT-COVERED` (source can't see this chain) is the whole point — don't collapse them into "nothing found".

### Step 7.5 — Sanctions & risk screening

Screen every target. Primary path, zero new dependency: the Chainalysis OFAC oracle is live on Celo at `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` and reuses the `cast` tooling from Steps 3/4 — `cast call 0x40C57923924B5c5c5455c48D93317139ADDaC8fb 'isSanctioned(address)(bool)' "$ADDR" --block "$HEAD_BLOCK" --rpc-url "$RPC"`, repeated for each Step-2 funder/counterparty. It is not deployed on every chain (e.g. Monad), so only call it where it exists on `$CHAIN`.

**Caveat to write into the report: the per-chain Celo oracle's SDN set is not identical to Ethereum's — a `false` on Celo is not an authoritative global negative.** For a definitive verdict also hit a chain-agnostic free path: TRM's keyless `POST https://api.trmlabs.com/public/v1/sanctions/screening` with `[{"address":"0x…"}]`, or set-membership against a static OFAC list file (`raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/main/data/sanctioned_addresses_ETH.txt`, one 0x address per line, EVM-wide). For scam/phishing rather than sanctions, cross-check counterparties against the Scam Sniffer blacklist and — on chains it covers (Monad `143`, not Celo) — GoPlus. Most Mento targets return clean; the value is the rare hit and a citable verified negative.

### Step 8 — Bottom line

Five bullets, one sentence each: Who / What / Where / How much / Goal. This is the section a Slack reader will copy-paste, so it has to stand alone without the rest of the report.

### Step 8.5 — Adversarial verification gate (before save/upload)

Invert your own confirmation bias. Lightweight but mandatory — leave a one-line trace in the report ("Top alternative considered: …, rejected because …"):

- **State the top alternative hypothesis** and hunt disconfirming evidence (arb bot vs MM rebalancer vs exchange sweep vs protocol keeper). Does your evidence _entail_ the headline, or merely fail to contradict it?
- **Re-confirm the original funder** is genuinely the oldest inbound (Sim returns newest-first — the classic mis-attribution), and that `--chain-ids` was scoped to the target chain on every funder query.
- **Re-confirm each fleet link** in Step 2.5 has its required second signal.
- Downgrade any claim that can't survive this to a lower confidence tier, or cut it.

### Step 9 — Save the draft

Write the finished markdown to `.investigations/<addr>-<slug>.md`. Slug = first 3 words of the H1 display name, lowercased, kebab-cased. Example: H1 `Arbitrage Executor (idontloseiwin.eth)` → slug `arbitrage-executor`.

End the report with a **provenance footer** so mutable-state reads are reproducible (this lives in the markdown body — the report JSON has no field for it, and the API silently drops unknown keys):

```
_Provenance: <chain> head block <N> (hash <0x…>), RPC <endpoint>, cast <version>. Sim/DefiLlama queried <UTC ts>._

_Investigation date: YYYY-MM-DD._
```

### Step 10 — Push to production → `references/upload.md`

By default the skill stops at the local draft and asks the user to review; upload only on `--upload` or an explicit equivalent. Three safety properties are non-negotiable and live here, not only in the reference file:

- Keep `mcp__upstash__redis_database_run_redis_commands` out of repo-shared auto-allow lists. **The MCP approval prompt is the production write guard for this path.**
- **Derive `AUTHOR_EMAIL` from `git config user.email` at runtime** — never hardcode it, or every teammate's reports get mis-attributed and PII lands in git. `git config` is local and unauthenticated, so **show the derived email and have the user confirm** it matches their workspace identity before sending the EVAL.
- Re-read the record immediately before writing and pass the derived expected version to the CAS Lua upsert: `""` means **create-only** (fail if another writer creates it first); otherwise the fresh base version. On a conflict, stop, show it, and ask — **never auto-retry with a new base version.**

The payload the script stamps `createdAt` / `updatedAt` / `version` onto:

```js
const partial = {
  body,
  ...(title ? { title: title.slice(0, 200) } : {}),
  authorEmail: AUTHOR_EMAIL, // from git config user.email, confirmed with the user
  source: "Codex", // the Claude mirror uses "claude"
};
```

## Confidence tiers

Grade **load-bearing attribution claims only** — Cast of characters rows, fleet links, Bottom line — not every sentence. Grading lets the report keep a useful "likely but unproven" lead instead of discarding it, as long as it's labelled honestly:

- **CONFIRMED** — a deterministic on-chain fact (creation-tx `from`, a storage read, a codehash match, a decoded selector) or external ground truth (an ENS reverse record). No hedging words.
- **PROBABLE** — a funder-graph or behavioural inference corroborated by **≥2 independent signals** (e.g. codehash + common-funder, or activity-clock + approval-graph).
- **POSSIBLE** — a single uncorroborated heuristic. Allowed in the report, but must carry the tag so a reader never mistakes it for fact.

Tag inline, e.g. **Operator EOA** `0x…` **[PROBABLE: codehash + funder]**. A claim that can't reach POSSIBLE doesn't belong in the report at all.

## Output contract (the API enforces the same rules)

- `body`: required, non-empty, ≤ 50,000 characters (50KB)
- `title`: optional, ≤ 200 characters, dropped if empty after trim
- `source`: `"Codex"` in this canonical skill and `"claude"` in its Claude mirror
- `version`: starts at 1, increments on each write; preserve `createdAt` from the prior write if updating

These match `MAX_BODY_LENGTH` / `MAX_TITLE_LENGTH` in `ui-dashboard/src/lib/address-reports-shared.ts`, and the address key must satisfy `isValidAddress` in `ui-dashboard/src/lib/validators.ts`. If those constants change, mirror the changes here — the skill must not write a payload the API would reject on a manual edit.

## Reference: production database

Discover the opaque database id at runtime by exact name (`address-labels`).
Terraform owns the database; this skill owns only the `reports` hash workflow.

```
database name: address-labels
hash:        reports
key shape:   <lowercase 0x address>
value shape: JSON-stringified AddressReport (see the output contract above)
```

The `address-labels` Upstash database also holds the `labels` hash (custom address labels) and `minipay:*` keys (the MiniPay tagging cron's bookkeeping). Don't touch those from this skill.

## Rules

- **Never commit a draft.** `.investigations/` is gitignored for a reason. If a report belongs in the team's history, it lives in the production `reports` hash + the daily Vercel Blob backup, NOT in git.
- **Never write a label or the `labels` hash from this skill.** Labels are a separate concern; the `arkham` skill or the address-book modal handles those.
- **Never push to prod without explicit user confirmation.** Local draft is the default; upload only on `--upload` or after the user says "ship it" / "upload it" / equivalent.
- **Mirror the output contract.** Don't write a payload the API would reject — that includes the body length cap, title length cap, version monotonicity, and `createdAt` preservation on update.
- **Cite evidence.** Every claim about an address gets a tx hash, an Arkham response, a Sim balance snapshot, an indexer row, or a storage read backing it. "Probably MEV" is not enough; "selector `0x49aa2402` calls into a contract whose public `routerUniswap()` returns Uniswap V3 SwapRouter02 (factory `0xafe208a3…` matches official UniV3 on Celo)" is.
- **Grade, don't hedge.** Tag load-bearing attribution claims with a confidence tier (CONFIRMED / PROBABLE / POSSIBLE) instead of weasel words. A claim that can't reach POSSIBLE doesn't ship; if the whole attribution is sub-POSSIBLE, write a label + notes blurb instead of a durable report. Run the Step 8.5 adversarial gate before saving.
- **Think multi-chain; never disable a source just because it lacks Celo.** The target chain (Celo, Monad, or Polygon) drives the behaviour leg; the operator's cross-chain footprint drives the identity leg. A Celo-blind tool can be the right tool for the identity leg or a supported non-Celo chain — consult `references/tooling-matrix.md` instead of dropping it. Thread the target chain id through every chain-scoped call; never hardcode `42220`.
