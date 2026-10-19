# Research behind v2: feature org per branch at scale

Why v1 (one combined deploy of all of production on every push, drop failures, retry once) breaks on a large org, and
where each v2 rule comes from. Read it when a limit or rule in `SKILL.md` looks wrong, or before arguing for a change.

**Verdict.** No-go for v1 at thousands of components. Conditional go for v2 (snapshot first, tiered and chunked golden
build, per-branch deltas, scoped baseline) if the Phase 0 spikes show:

- the scoped baseline converges to fewer than ~100 exclusions within 4 passes and ~2 hours;
- non-test Apex is ≤ 10 MB, or Support raises `MaxApexCodeSize` for the Dev Hub;
- the Dev Hub's active allocation fits the concurrent branches (Unlimited: yes; Enterprise: cap at ~30);
- the golden snapshot stays under 200 MB of data.

If the full production baseline won't converge, use Developer / Developer Pro sandboxes for the teams that need it.

---

## Sources, by claim

**Official** = Salesforce documentation (DX Developer Guide, Metadata API Developer Guide v68.0 Winter '27, Limits
cheatsheet, REST API, CLI environment variables, Salesforce Help, Salesforce Developers blog).
**Practitioner** = vendor or community evidence: forcedotcom/cli issues, Gearset help, Beyond the Cloud, Apex Anvil,
Salto, and the DX@Scale deck by Azlam Abdulsalam and Ramzi Akremi.

| Claim | Value | Source |
| --- | --- | --- |
| Files per deploy or retrieve | 10,000 | Official |
| Zip per deploy or retrieve | 39 MB compressed (SOAP), 600 MB uncompressed | Official. Base64 inside the 50 MB SOAP message leaves ~39 MB |
| REST deploy | Not bound by 39 MB; the file limit still applies | Official (`SF_ORG_METADATA_REST_DEPLOY`) |
| Custom fields per deploy | 45,000 | Official |
| Apex code units per deploy | 5,000 | Official. Third-party copies say 7,500 |
| CLI chunking | None. It warns at 80% of a limit and sends anyway | Official (CLI env vars) |
| Sequential package dirs | `sf project deploy start` doesn't support `pushPackageDirectoriesSequentially`; run separate commands | forcedotcom/cli discussion #2402 |
| Shape contents | Boolean Metadata API settings and licences (package licences, not packages). No integer/string settings, metadata or data. One active per Dev Hub; recreating deactivates the old one. Tied to a release. 15-char org id | Official |
| Not captured by shape | Chatbot, DevOpsCenter, MultiCurrency, PersonAccounts; Field Service Enhanced Scheduling and Integration | Official (Troubleshoot Org Shape) |
| Shape breakage across releases | Summer '23 MultiCurrency auto-enable broke shape creation (`C-9999`, "Do not have an access to enableMultiCurrency"); a "fatal signup error" is fixed by regenerating the shape | forcedotcom/cli #2214; Official |
| Shape + Field Service / Experience Cloud | Shift Status picklists empty; a Digital Experience site fails on missing welcome/password templates (no workaround) | Official |
| Production Apex default | 6 MB non-test unmanaged | Official. Raised to 15M/25M characters on real projects (Beyond the Cloud) |
| Scratch `MaxApexCodeSize` | Default 10 MB; more needs Support. Integer-valued, so a shape won't carry it | Official |
| Snapshot contents | Packages, features, limits, licences, metadata, data. Not connected apps, named or external credentials. Can't snapshot a snapshot-built or namespaced org. Static: delete and recreate to update | Official |
| Snapshot expiry | 90 days; data retained 100 days | Official. Earlier research said 30 days |
| Snapshot allowance | Equal to the active scratch allowance (ActiveOrgSnapshots, DailyOrgSnapshots) | Official |
| Snapshot definition file | Can't hold `features`, `sourceOrg` or `releaseVersion`; can override settings | Salesforce Developers blog, Aug 2024 |
| Snapshot intent | "Static dependencies of a project, and not the entire happy soup of your production org"; not a UAT substitute | Official. A full-production baseline is outside intended use, not prohibited |
| Scratch storage | 200 MB data, 50 MB files; snapshots the same | Official |
| Allocations | Developer 3/6, Enterprise 40/80, Unlimited/Performance 100/200 (active/daily); daily is a rolling 24 h | Official. Raising them via Support is unverified |
| sObject Tree import | 200 records across all trees, 5 levels, 5 types per request; atomic; all automation fires | Official |
| `rootTypesWithDependencies` | 25 retrieve requests a day, 100 components per request | Official |
| Synchronous compile on deploy | Turning it off "can greatly speed up your CI/CD pipeline"; compile errors move to run time | Salesforce blog, Oct 2025 ("Master Metadata API Deployments") |
| `--ignore-errors` | Scratch orgs accept it; production rejects it ("rollbackOnError option must be true on a production org") | Official; forcedotcom/cli #2601 |
| `--wait` | Default 33 min; on expiry the deploy continues in the org | Apex Anvil, 2026 |
| Flow deletion | One Flow that can't be deleted fails the whole deploy | Known Issue W-10538057; forcedotcom/cli #3401 |
| Source tracking cost | Extra SourceMember queries and waits on medium/large projects; tracked retrieves over 15 min | Official; forcedotcom/cli #3272 |
| Non-tracked orgs | Need explicit `-d` / `-m` / `-x` source (Dec 2025 CLI change) | CLI release notes |
| Large-project timings | Org preparation ~80 min without pools, ~20 s with a pool; goal "build below 30 minutes" | DX@Scale deck |
| Batching retrieves | Gearset splits by an "educated guess", "not deterministic", "not guaranteed to always be successful" | Gearset help, Nov 2023 |
| Hyperforce | Scratch orgs from a Hyperforce Dev Hub are created in its region | Official |

## Conflicts between sources

- Snapshot expiry: 90 days (current DX guide) vs 30 days (earlier research). Use 90.
- Uncompressed zip: 600 MB (current) vs 400 MB (older docs and blogs). Use 600.
- Apex units per deploy: 5,000 (official) vs 7,500 (third-party copies). Plan for 5,000.
- `rollbackOnError` default: the Oct 2025 blog says false; the CLI and production behave as true. Pass the flag
  explicitly.
- Sandbox allowances: older blogs say 1 Developer sandbox for Enterprise and 15 for Unlimited. Current Help says 25 and
  100.

## Not verified anywhere

A member cap on `sf org list metadata`; SourceMember paging at tens of thousands of rows; whether a shape carries
raised integer limits; whether Salesforce raises scratch allocations; large-org deploy and snapshot timings. The
~8 min (snapshot) vs 15–40 min (shape) creation times came from a small org. Treat them as a floor. Only the
team's spike numbers should set the timeouts.

## Why "drop failures, retry once" fails

In an all-or-nothing deploy, one missing feature or field fails every component that references it: layouts,
FlexiPages, permission sets, Flows, Apex. The failures are mostly victims, not causes. Dropping them all throws away
much of the baseline in one go, and the "branch only" fallback then fails because the branch references the
baseline. v2's tiered `--ignore-errors` loop to a fixed point, with classified exclusions, replaces it.

**Failure classes to expect:**
- features or limits the shape doesn't carry;
- lookup filters;
- Person Accounts (its own DX limitations);
- Experience Cloud sites;
- Flows and approvals naming specific users, queues or roles;
- email templates needing letterheads or folders;
- sharing rules and territories needing features;
- StandardValueSets, which aren't captured but are referenced by fields and record types;
- CustomObjectTranslation for languages that aren't enabled;
- Apex with hard-coded ids;
- Flow deletions;
- credentials stripped from snapshots;
- scheduled jobs from the seed blocking redeploys of their classes.

## Scoping the baseline (the biggest lever)

Salesforce discourages deploying all of production into scratch orgs. Salto sums up why: dependency and feature
gaps, slow creation, and "you are essentially just creating a sandbox". Build the baseline from the dependency closure of
what branches touched recently (`rootTypesWithDependencies` or the Dependency API, within the limits above). Reports,
Dashboards, EmailTemplates and ListViews are usually most of the file count and rarely needed for development, so
leave them out unless a branch references them.

## Definition file, shape, snapshot, seed: which is needed

| Piece | Gives the org | Needed? |
| --- | --- | --- |
| Definition file | Creation settings: a shape (`sourceOrg`) or edition, features and settings by hand | Always. `sf org create scratch` needs one |
| Org Shape | Production's boolean settings and licences | Only behind the golden definition |
| Snapshot | A frozen golden org: packages, metadata, data | Yes. It makes feature orgs fast |
| `baseline/` + branch | Production's customisations and the feature | Always. No shape or definition carries metadata |
| Seed (sf tree JSON) | A few dozen linked records | Yes, small, loaded into the golden org |
| CSV / Bulk | Large flat loads linked by external ids | No. Volume testing belongs in a sandbox |
| Sandbox template | Which data a Partial Copy *sandbox* copies | No. Doesn't apply to scratch orgs. "Implementation Template" is not a Salesforce DX concept |

## Alternatives and complements

- **Developer / Developer Pro sandboxes** (current Help): Enterprise includes 25 Developer and 1 Partial Copy.
  Unlimited includes 100 Developer, 5 Developer Pro, 1 Partial Copy and 1 Full. Developer and Developer Pro refresh
  daily, copy all metadata and need no baseline. Developer storage is 200 MB data + 200 MB files; Developer Pro is
  1 GB + 1 GB. The trade-offs are hours to create and drift between refreshes.
- **Pools** (sfp/Flxbl, CumulusCI): prepare orgs ahead, build on a snapshot pool, and keep partially prepared orgs
  (`succeedOnDeploymentErrors`). They take creation from ~80 min to ~20 s, but cost allocation headroom. DX@Scale
  needs 3 pools, and a rebuild takes 1–3 hours.
- **Modularisation** into unlocked or org-dependent packages is Salesforce's long-term answer to happy soup
  (Trailhead "Break Up Your Metadata"). It's a multi-quarter refactor, not a CI change.
- **In practice, large teams run a hybrid:**
  - scratch orgs (pooled or snapshotted) for bounded work;
  - Developer / Developer Pro sandboxes for work that needs all of production;
  - Partial / Full sandboxes for integration and UAT.

## Platform changes to track

- Metadata API is v68.0 in Winter '27. Pin `sourceApiVersion` and bump it deliberately each release.
- Recent CLI notes, exact versions unverified:
  - `org create scratch --async` and `org resume scratch` work again;
  - the `CMTRecordManagedDeletion` feature is deprecated;
  - `org login device` was removed.
- Financial-services orgs often use Person Accounts and multi-currency. Declare both in the golden definition.
