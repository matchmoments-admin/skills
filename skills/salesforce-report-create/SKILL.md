---
name: salesforce-report-create
description: Create Salesforce reports programmatically via the Analytics REST API or the Metadata API. Use when asked to build, script, or version-control Salesforce reports, when a report deploy fails with "invalid report type" or "Invalid field name", when you need the real API name of a custom report type, or when reports must be created without clicking through Setup.
---

# Creating Salesforce reports programmatically

**Yes, reports can be created by API.** Both the Analytics REST API and the Metadata API
work. Most of the difficulty is naming, and the error messages point at the wrong thing.

## Start here: never guess a report type name

```bash
sf api request rest "/services/data/v67.0/analytics/reportTypes" -o <alias>
```

This is the single highest-value call. It returns every report type the org can use, with
its **exact** `type` string. Two families come back:

| Family | Looks like | Where it comes from |
|---|---|---|
| **Custom report types** | `Timesheet_Entries__c` | A `ReportType` you deployed |
| **Auto-generated** | `CustomEntity$Timesheet__c`<br>`CustomEntityCustomEntity$Parent__c$Child__c` | Free, for any object with `enableReports=true` |

🔴 **A custom report type is referenced with a `__c` suffix.** If you deployed
`Timesheet_Entries.reportType-meta.xml`, the reference is **`Timesheet_Entries__c`**, not
`Timesheet_Entries`.

Getting this wrong fails with **`invalid report type`**, which reads as *"this type is not
valid"* rather than *"no type by that name"*. It is easy to conclude the feature does not
work and give up. It is just a name.

## Prefer the auto-generated report types

They cost nothing and they expose fields a custom report type **cannot**:

- `CUST_OWNER_NAME`, `CUST_OWNER_ALIAS`, `CUST_OWNER_ROLE`
- `CUST_CREATED_DATE`, `CUST_CREATED_NAME`, `CUST_LAST_UPDATE`
- On a parent-child type: `CHILD_CREATED_DATE`, `CHILD_CREATED_NAME`

🔴 **Owner cannot be added to a custom report type.** `<field>OwnerId</field>` is rejected
("Could not find field"), and a `<table>Object__c.Owner</table>` join is rejected ("Could
not find table for path"). Do not add a formula field to work around it — use the
auto-generated type, which already has `CUST_OWNER_NAME`.

Reach for a custom report type only when you need a join the auto-generated ones do not
give you, or a curated column list.

## Get the real column names before writing a report

```bash
sf api request rest "/services/data/v67.0/analytics/reportTypes/<TYPE>" -o <alias>
```

URL-encode `$` as `%24` for auto-generated types. Read `reportTypeMetadata.categories[].columns`
— the keys are exactly what `detailColumns`, `groupingsDown` and `aggregates` accept.

Note the shape: on a parent-child type, child fields are **`Child__c.Field__c`**, not
`Parent__c.Children__r.Field__c`.

## Create it

```bash
sf api request rest "/services/data/v67.0/analytics/reports" \
  -o <alias> --method POST --body "@/tmp/report.json"
```

`--body "@file"` — the `--file` flag needs a `mode` and will reject a plain path.

```json
{"reportMetadata":{
  "name":"Hours by Activity Type",
  "reportType":{"type":"Timesheet_Entries__c"},
  "reportFormat":"SUMMARY",
  "folderId":"00l...",
  "detailColumns":["Time_Entry__c.Entry_Date__c","Time_Entry__c.Hours__c"],
  "groupingsDown":[
    {"name":"Time_Entry__c.Activity_Type__c","sortOrder":"Asc","dateGranularity":"None"}],
  "groupingsAcross":[],
  "aggregates":["s!Time_Entry__c.Hours__c","RowCount"],
  "reportFilters":[{"column":"Timesheet__c.Is_Complete__c","operator":"equals","value":"false"}]
}}
```

- `reportFormat`: `TABULAR` · `SUMMARY` · `MATRIX`. A matrix needs `groupingsAcross`.
- Aggregate prefixes: `s!` sum, `a!` average, `mx!` max, `mn!` min, plus the bare
  `RowCount`. **The aggregate must be listed in `aggregates` before a chart or dashboard
  component can use it.**
- `dateGranularity`: `None` for non-dates, else `Day` / `Week` / `Month` / `Quarter` / `Year`.
- Folder id: `SELECT Id FROM Folder WHERE Type='Report' AND DeveloperName='X'`.

## Version-control it afterwards

The API assigns a **random suffix** to the developer name — `Incomplete_Weeks_dIQ`. So:

```bash
sf data query -o <alias> -q "SELECT DeveloperName FROM Report WHERE FolderName = 'X'"
sf project retrieve start -o <alias> -m "Report:<FolderDevName>/<ReportDevName>"
```

Retrieve **one at a time**; batching several `-m` flags in a shell loop is easy to get wrong
and fails silently with zero files. Once retrieved you have canonical XML — which is also
the fastest way to learn the Metadata API's column syntax.

## Metadata API route

Works too, with the same naming rules, but **deploys are atomic**: one bad report rolls back
the report types and folder in the same payload, so they never persist and every retry fails
the same way. Deploy in three passes — `ReportFolder`, then `ReportType`, then `Report` — or
create via the Analytics API and retrieve.

Never leave broken report XML in the source tree: it will fail every unrelated deploy.

## Run one to check it

```bash
sf api request rest "/services/data/v67.0/analytics/reports/<id>?includeDetails=false" -o <alias>
```

Read `factMap`: `"T!T"` is the grand total, `"<groupingKey>!T"` is each group's.

**Do this.** Running the first report on a real org immediately exposed a production bug
that code review had not: a whole activity type showing as non-billable, because the default
was applied in one write path and not the others. A report is a cheap assertion over
production data.

## See also

`salesforce-dashboard-create` — dashboards reference these reports by
`<FolderDevName>/<ReportDevName>`, and have their own set of required attributes.
