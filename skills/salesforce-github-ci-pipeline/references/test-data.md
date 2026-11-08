# Test data: what each org gets, and how to extend it

Every org starts with **synthetic** data, never production's. Production data reaches only UAT, only masked, and only
when the team turns it on. The handbook's "Test data" table is the operator view; this page is for setting it up.

## What ships with the template

| Layer | Where | How it loads |
|---|---|---|
| **Core seed** | `data/seed/` (`sf data import tree` plan + one file per object, standard fields only) | Every scratch org (story, CI, staging, UAT, the snapshot), once per org through a marker Account. Date tokens (`${TODAY}`, `${THIS_YEAR}`…) are filled at load time. A changed seed replaces the old one in long-lived orgs |
| **Story seed** | `data/seed/stories/<key>/plan.json` (same format) | Claude writes it with the build when a story adds an object (or a field people test): about 20 synthetic records, with a few synthetic parent Accounts made in the same plan (tree `@references` reach only their own plan). It loads into the story's org, then staging and UAT. After the release, `seed-fold` opens a PR folding it into the core seed |
| **Data request** | `data/seed/stories/<key>/request.json` (version 1: objects, counts, per-parent counts, set values) or `pipe data seed --org A --request F` | Generated at load time from the target org's describe, so it fits however the org is set up: required fields, picklist values (dependent picklists through `validFor`), lookups to parents it also makes. Loads into the story's org, then staging and UAT, whenever `SEED` is not `off`; one bad request in staging is a warning naming the story. Tracked by a **Data ledger** in the org (a file titled `[data ledger <scope>]`): the same request loads once, a changed one replaces only the ledger's records, `pipe data remove` undoes it. Production, the Dev Hub and any org that is not a sandbox or this Dev Hub's scratch org are refused |
| **Volume** | generated (`VOLUME_RECORDS`, default 5000) | Staging only: accounts with opportunities by anonymous Apex, so lists, reports and Flows meet production-like numbers |
| **Masked UAT sample** | `config/uat-sample/export.json` | Only with `UAT_SAMPLE=on`: SFDMU copies a production subset into UAT org to org, replacing names, emails and phones (`mockFields`). Then `pipe sample guard` fails if a production email domain (`UAT_SAMPLE_DOMAINS`) survived |

Apex tests never see any of this. They build their own data (a `TestDataFactory`: personas, bulk records).

## Rules that came from real failures

- **No seed record may start production automation that queues async Apex.** The lab's email-origin Cases fired a Flow
  that enqueued a Queueable. The pending job then blocked every redeploy of its classes, and every org build retried 6
  baseline files.
- **Picklist codes, not labels** (`BillingCountryCode`); keep the core seed to hundreds of records.
- **Seed records are read by name** in UI tests; a test creates only what its criterion changes.

## Data requests

```json
{ "version": 1, "objects": [
  { "object": "Account", "count": 3 },
  { "object": "Contact", "perParent": { "Account": 2 } },
  { "object": "Case", "count": 2, "scenario": "escalated", "set": { "Status": "Escalated" } } ] }
```

- **Where requests come from:** the AI plan's `### Test data` line (`/data Account 20; Contact 2 per Account`), which
  the build writes as the story's `request.json`; a `/data ...` comment on a started story (`story-data.yml` runs `pipe data apply`: read
  against the story's org with a did-you-mean, loaded, and only then written; one JSON outcome, `refused` (every
  problem) or `loaded`, and any other error fails the run; the workflow commits a changed file as the App, never as the
  person's code; the card's org row shows the story's test data); and **Actions › data-seed** for a Developer sandbox
  (sandbox name, `seed`/`status`/`remove`, typed request or file; it logs in as `<SF_CI_USERNAME>.<sandbox>` with the
  CI certificate, which needs the sandbox created or refreshed after the connected app existed).
- `pipe data check` (no file: every story's request, offline; CI's static job runs it) and `--request F` for one file;
  `pipe data seed --org A --request F | --data "Account 20; ..." [--scope S]` loads (typed requests default to the
  "by hand" set, which the next typed one replaces); `pipe data status|remove --org A --scope S` shows or undoes it.
  Up to 2,000 records per load.
- Values a request sets win; generated values never replace them (date tokens work: `${TODAY-30}`). Required lookups
  the generator cannot fill (polymorphic, User/RecordType/Profile..., or a lookup to the same object) are reported:
  set them in the request.
- `config/data-rules.json` `never` lists values no generated record may take (`"Case.Origin": ["Email"]`: the async
  automation rule above).
- **Data profile** (aggregates of production's shape, every count under 5 suppressed, never a single record's value)
  weights the choices. It is read **on demand**: when a request loads, and only then, its objects and their parents are
  read from production (the Dev Hub) with aggregate queries only, 25 per REST composite batch call (about 40 queries,
  2 calls, a few seconds). It lives in memory for that load and is never saved; a request already loaded reads nothing.
  `DATA_PROFILE=off` (or `pipe data seed --no-profile`) reads nothing and spreads values evenly, as does a run with no
  Dev Hub login (it warns). `profileExclude` in `config/data-rules.json` leaves sensitive fields (an average Amount) out.
  An object new in the story (not yet in production) has no profile: required fields only.
- Code: the use case `pipeline/src/data/load.mjs` talks to an org only through the **Org data store** port; the sf
  adapter is `pipeline/src/org/data-store.mjs`, the in-memory one `pipeline/test/data-store-memory.mjs`. Contract
  tests replay recorded CLI output (`pipeline/test/fixtures/sf/`).

## Turning on the masked UAT sample

1. **Read-only production user:** a user with read access to the sampled objects, and **no** modify-all, export or
   API-write permissions. Pre-authorize it on the CI connected app (the same certificate) and store its username as
   the secret `SF_PROD_READ_USERNAME`.
2. **Environment:** create the GitHub environment `production-read` with required reviewers. The sample job waits
   for approval.
3. **Settings:** `UAT_SAMPLE_DOMAINS=<production email domains>`, then `UAT_SAMPLE=on`.
4. **Edit `config/uat-sample/export.json` for the org:**
   - add objects and fields only with a `mockFields` entry for anything personal;
   - never select free text (descriptions, comments, notes);
   - set `Origin` (and similar trigger fields) to values that start no async automation.
5. **Run it once by hand** (Actions, `uat-sample`) and look at UAT before relying on it.

SFDMU is pinned (`sfdmu@5.8.0`). Its `--anonymise` flag only hashes values in its logs; the masking is
`updateWithMockData` with `mockFields` in `export.json`. Masking is per record, not format-preserving.

## Why these tools (researched October 2026, rechecked November 2026)

| Option | Verdict |
|---|---|
| `sf data import tree` (native) | Kept for the synthetic seeds: free, no plugin, plan files with references. The markers make it idempotent |
| **SFDMU** (free, Apache-2.0, maintained) | Used for the masked UAT sample: org to org with relationships, `mockFields` masking. For upsert-based seeding everywhere it needs an external-ID field on every object, which isn't worth it while markers work |
| Snowfakery | Good recipes, but its repository was archived in April 2026. Not adopted |
| Salesforce Data Mask & Seed | Paid, quote only, aimed at sandboxes. Consider it when UAT is a full-copy sandbox |
| `sf data-seeding generate` (Data Seed CLI, `@salesforce/plugin-data-seeding`) | The nearest standard to the generator plus profile: AI makes look-alike data from a source org. Paid (fails without the org's data seed permission), sends both orgs' tokens and the source data to a Salesforce service in us-east-1, not reproducible, scratch-org targets undocumented. Trial it only with the licence |
| `sf data upsert bulk` (Bulk API 2.0, CSV, external IDs) | Worth it above about 2,000 records. Needs an external-ID field on every seeded object (breaks "any org as it is"); each object is an async job, slower than tree for hundreds. The Data ledger already makes reruns safe |
| Partial / Full sandbox templates | Copy real production data, unmasked; Developer sandboxes get none. Not test data |
| Gearset seeding, Own (Salesforce), Prodly, Copado Data Deploy | Paid. Gearset's add-on is about 40% of its plan price, Own $1.85–2.50 per Salesforce user per month. Worth it only for teams already on those platforms, or that need format-preserving masking at scale |
