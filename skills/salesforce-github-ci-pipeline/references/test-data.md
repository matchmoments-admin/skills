# Test data: what each org gets, and how to extend it

Every org starts with **synthetic** data, never production's. Production data reaches only UAT, only masked, and only
when the team turns it on. The handbook's "Test data" table is the operator view; this page is for setting it up.

## What ships with the template

| Layer | Where | How it loads |
|---|---|---|
| **Core seed** | `data/seed/` (`sf data import tree` plan + one file per object, standard fields only) | Every scratch org (story, CI, staging, UAT, the snapshot), once per org through a marker Account. Date tokens (`${TODAY}`, `${THIS_YEAR}`…) are filled at load time. A changed seed replaces the old one in long-lived orgs |
| **Story seed** | `data/seed/stories/<key>/plan.json` (same format) | Claude writes it with the build when a story adds an object (or a field people test): about 20 synthetic records linked to the seed's Accounts by name. It loads into the story's org, then staging and UAT. After the release, `seed-fold` opens a PR folding it into the core seed |
| **Volume** | generated (`VOLUME_RECORDS`, default 5000) | Staging only: accounts with opportunities by anonymous Apex, so lists, reports and Flows meet production-like numbers |
| **Masked UAT sample** | `config/uat-sample/export.json` | Only with `UAT_SAMPLE=on`: SFDMU copies a production subset into UAT org to org, replacing names, emails and phones (`mockFields`). Then `pipe sample guard` fails if a production email domain (`UAT_SAMPLE_DOMAINS`) survived |

Apex tests never see any of this. They build their own data (a `TestDataFactory`: personas, bulk records).

## Rules that came from real failures

- **No seed record may start production automation that queues async Apex.** The lab's email-origin Cases fired a Flow
  that enqueued a Queueable. The pending job then blocked every redeploy of its classes, and every org build retried 6
  baseline files.
- **Picklist codes, not labels** (`BillingCountryCode`); keep the core seed to hundreds of records.
- **Seed records are read by name** in UI tests; a test creates only what its criterion changes.

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

## Why these tools (researched October 2026)

| Option | Verdict |
|---|---|
| `sf data import tree` (native) | Kept for the synthetic seeds: free, no plugin, plan files with references. The markers make it idempotent |
| **SFDMU** (free, Apache-2.0, maintained) | Used for the masked UAT sample: org to org with relationships, `mockFields` masking. For upsert-based seeding everywhere it needs an external-ID field on every object, which isn't worth it while markers work |
| Snowfakery | Good recipes, but its repository was archived in April 2026. Not adopted |
| Salesforce Data Mask & Seed | Paid, quote only, aimed at sandboxes. Consider it when UAT is a full-copy sandbox |
| Gearset seeding, Own (Salesforce), Prodly, Copado Data Deploy | Paid. Gearset's add-on is about 40% of its plan price, Own $1.85–2.50 per Salesforce user per month. Worth it only for teams already on those platforms, or that need format-preserving masking at scale |
