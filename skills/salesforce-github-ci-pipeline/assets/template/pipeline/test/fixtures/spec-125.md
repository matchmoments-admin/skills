<!-- pipeline:spec -->
### Spec

### Problem

Sales managers cannot see how their accounts and their won business split by sales region. Territory planning is done in spreadsheets every quarter: someone exports accounts and opportunities, matches them by hand and rebuilds the split. It is slow, it goes stale, and managers do not trust the numbers.

### Solution

Managers open one report, and a dashboard component built on it, showing for this year:

- the number of accounts per sales region (APAC, EMEA, Americas), and
- the closed-won opportunity amount per sales region.

Managers get this without administrator rights. Reps keep seeing only what they see today: the report and dashboard are not shared with them, and nothing about record access changes. Sales region stays visible only to people with the `Sales_Region_Access` permission set, so managers need that set (through a manager persona group) to see the region column.

### User stories

1. As a sales manager, I want a report of accounts grouped by sales region, so that I can see how many accounts each territory has.
2. As a sales manager, I want a report of closed-won opportunity amounts grouped by the account's sales region for this year, so that I can compare territories without a spreadsheet.
3. As a sales manager, I want a dashboard component of won amount by sales region, so that I can see the split at a glance.
4. As a sales manager, I want the "this year" range to move on its own on 1 January, so that nobody edits the report each year.
5. As a sales manager, I want accounts with no sales region shown as their own "no region" row, so that I can see which accounts still need a territory.
6. As a sales manager, I want to open these reports without Modify All Data, View All Data or any other administrator permission, so that I stay within least privilege.
7. As a sales manager, I want the numbers to include only the accounts and opportunities I am allowed to see, so that the report agrees with the records I open.
8. As a sales rep, I want to keep seeing only what I see today, so that the new reporting does not expose region data, reports or other people's records to me.
9. As a sales rep without the `Sales_Region_Access` permission set, I want the region field to stay hidden from me, so that the territory data stays sales-management only.
10. As an admin, I want one permission set for managers' reporting access, so that I can grant or remove it for a whole persona and review it.
11. As an admin, I want the reports in a folder shared only with the manager group, so that I control who sees them.

### Decisions

**Account**
- No new fields. Sales Region (`Sales_Region__c`, picklist) already exists in production and is used as is. It is not in the repo today, so a scratch org gets it from production's shape; the story must confirm it is present before building and must not redefine it.
- No automation: no trigger, no record-triggered Flow, no Apex. This is reporting only.
- Page or layout: no change. No Lightning page or page layout is touched, because managers do not edit anything.
- Permission set: managers get `Sales_Region_Access` (existing, unchanged) so the region field is readable to them.

**Opportunity**
- No new fields, no automation. The report uses standard Amount, Stage and Close Date.

**Reports and dashboard** (new metadata, the only thing this story ships)
- A custom report type: Opportunities with Accounts, so the report can group by the account's Sales Region.
- Report 1: Accounts by Sales Region (summary, grouped by Sales Region, record count).
- Report 2: Won Opportunity Amount by Account Sales Region (summary, grouped by Account Sales Region, filter Stage = Closed Won and Close Date = THIS_YEAR, sum of Amount).
- One dashboard, "Regional Sales", with a component per report. The dashboard runs as the viewing user (not a fixed running user), so each manager sees only their own records.
- Both reports and the dashboard live in one folder, shared with the manager group only (view access), not with all internal users.

**Permission set**
- A new permission set, `Regional_Reporting_Access`, grants the report-running permissions the persona needs (Run Reports, and read on Account and Opportunity if the managers' profile lacks it). It contains no administrator permissions: no Modify All Data, View All Data, Manage Users or similar, and no View All / Modify All on Account or Opportunity. Whether the manager profile already carries Run Reports is an open question.
- Folder sharing is by group or role, not by the permission set.

**Access decision**
- Org-wide defaults do not change. In production Account and Opportunity are internal ReadWrite and external Private; reports run in user mode, so the manager's own access decides the rows. No `without sharing` code is added.
- Because internal users see all accounts and opportunities by default, a manager's report covers every sales region, not only their own territory. Restricting a manager to their own region would be a sharing change and is out of scope.
- Region data stays gated by field access (`Sales_Region_Access`), not by hiding the report alone.

### Testing

There is no Apex, Flow or LWC in this change, so the seams are access and what a person sees. Prior art: the permission tests in `AccountTierValidationTest` and `AccountSelectorTest`, and the Playwright pattern in `e2e/`.

- **Who may see it (Apex permission test, `System.runAs`):** a user with `Regional_Reporting_Access` and `Sales_Region_Access` can read `Account.Sales_Region__c` (Schema describe) and has run-report access; a user with neither is refused or does not see the field. Test data (accounts across regions plus one with no region, won and not-won opportunities, 200+ rows) is created in system mode and the user is created in the test, because the CI user has none of the story permission sets. Do not rely on the ReadWrite default.
- **Permission set content:** an Apex test (or a CI access check) asserts the set holds no administrator permissions and no View All / Modify All.
- **Report results (Apex, report API `Reports.ReportManager.runReport` as the manager):** the won-amount report returns the expected sum per region for the current year, excludes open and lost opportunities, excludes last year's wins, and shows the no-region group. A bulk case with 200+ opportunities across regions.
- **What a person sees (Playwright, `e2e/story-125.spec.ts`):** a manager opens the dashboard and sees a row per region with the expected figures, read back from the org (`sf data get record`) rather than typed; a rep does not find the folder. Use realistic past Close Dates inside this year, and role/label locators.
- Because the report depends on "this year", test dates are built relative to today's year.

### One-way doors

None. This adds reports, a dashboard, a folder and a permission set. No field is deleted or retyped, no org-wide default changes and no production data changes. Sharing the folder with a wider group later would expose region figures and is a decision to make deliberately.

### Out of scope

- Restricting a manager to only their own territory (sharing rules, territory management, role changes).
- Changing the org-wide defaults for Account or Opportunity.
- New fields or changes to the Sales Region picklist values, or filling in missing regions on accounts.
- Giving reps the reports or the Sales Region field.
- Forecasting, quota, pipeline (open opportunities) or regional comparison with previous years.
- Scheduled report emails, subscriptions, and a Lightning home or record page placement of the dashboard.
- Profile edits, and any administrator permission.

### Open questions

1. Does the manager persona already have Run Reports and read access on Account and Opportunity through its profile, or must `Regional_Reporting_Access` grant them? (The repo holds no profiles or permission set groups for a manager persona.)
2. Which group or role is "sales managers" for the folder share, and does that group already exist in production?
3. "This year": calendar year or fiscal year? The spec assumes calendar year.
4. Should accounts with no Sales Region appear as a "no region" row (assumed yes), or be excluded?
5. Should the accounts report count all accounts, or only accounts that are customers (those with a won opportunity)?

**Next:** answer the 5 questions in a comment, then comment **/spec** to revise it; or split it as it is.

**Do it from here:** tick a box; the pipeline does it and the card updates.

- [ ] 🧩 Split it into stories with Claude (you approve the breakdown before anything is created) <!-- act:tickets -->

