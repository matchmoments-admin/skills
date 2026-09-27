---
name: salesforce-dashboard-create
description: Create Salesforce dashboards as deployable metadata. Use when asked to build or version-control a Salesforce dashboard, when a dashboard deploy fails with "is not a valid value for the enum DashboardComponentType" or "missing indicatorLowColor" or "require the sortBy attribute", or when a scheduled dashboard email arrives empty or shows the wrong person's data.
---

# Creating Salesforce dashboards as metadata

Dashboards deploy cleanly through the Metadata API once you know the required attributes.
Each missing one fails the whole deploy with a message naming just that attribute, so you
discover them one round trip at a time. They are listed here to save the round trips.

**Reports first.** A dashboard component references a report by
`<FolderDeveloperName>/<ReportDeveloperName>`, so the reports must exist. See
`salesforce-report-create` — and note the API gives reports a random developer-name suffix
(`Incomplete_Weeks_dIQ`), which is what the component must reference.

## The decision that matters more than the layout

```xml
<dashboardType>SpecifiedUser</dashboardType>
<runningUser>ops.user@example.com</runningUser>
```

| Value | Behaviour |
|---|---|
| `SpecifiedUser` | Everyone sees the data **the running user** can see |
| `LoggedInUser` | Everyone sees **only their own** data |
| `MyTeamUser` | Manager's team |

🔴 **`LoggedInUser` is how a dashboard ships broken.** On an object with Private OWD, a
scheduled email to Ops arrives **empty**, and each recipient sees a different dashboard.
Nobody reports it as a bug; they assume there is no data.

Use `SpecifiedUser`, and make the running user someone who holds View All on the objects.

## Layout

Three fixed sections. There is no free-form grid.

```xml
<leftSection><columnSize>Medium</columnSize><components>…</components></leftSection>
<middleSection>…</middleSection>
<rightSection>…</rightSection>
```

`columnSize`: `Narrow` · `Medium` · `Wide`.

## The four requirements that each fail a deploy on their own

**1. Component types.** `HorizontalBar` does not exist. Valid:

```
Metric · Table · Gauge
Bar · BarGrouped · BarStacked · BarStacked100
Column · ColumnGrouped · ColumnStacked · ColumnStacked100
Line · LineGrouped · LineCumulative
Pie · Donut · Funnel · Scatter
```

`Bar` is horizontal, `Column` is vertical.

**2. `Metric`, `Table` and `Gauge` require all five indicator attributes** — even when
nothing is colour-coded and the values are meaningless:

```xml
<indicatorBreakpoint1>25.0</indicatorBreakpoint1>
<indicatorBreakpoint2>75.0</indicatorBreakpoint2>
<indicatorHighColor>#54C254</indicatorHighColor>
<indicatorLowColor>#C25454</indicatorLowColor>
<indicatorMiddleColor>#D9A13B</indicatorMiddleColor>
```

**3. Every chart requires `sortBy`** — `RowLabelAscending` · `RowLabelDescending` ·
`RowValueAscending` · `RowValueDescending`.

**4. Every chart requires `chartAxisRange`** — `Auto` or `Manual` (with
`chartAxisRangeMin` / `chartAxisRangeMax`).

## A component

```xml
<components>
    <componentType>Bar</componentType>
    <header>Where the time goes</header>
    <footer>Selling vs delivery vs internal</footer>
    <report>Timesheets_Ops/Hours_by_Activity_Type_9H0</report>
    <legendPosition>Right</legendPosition>
    <showValues>true</showValues>
    <sortBy>RowValueDescending</sortBy>
    <chartAxisRange>Auto</chartAxisRange>
</components>
```

**The component can only show aggregates the report already declares.** If the chart is
empty, check the report's `aggregates` before suspecting the dashboard.

## Folder, and deploy order

A dashboard needs a `DashboardFolder` — separate from a `ReportFolder`, even with the same
name.

```
force-app/main/default/dashboards/My_Folder.dashboardFolder-meta.xml
force-app/main/default/dashboards/My_Folder/My_Dashboard.dashboard-meta.xml
```

Deploy the folder **first, in its own pass**. Metadata deploys are atomic, so a failing
dashboard rolls the folder back with it and the next attempt fails identically — which
looks like the folder being the problem when it is not.

## Verify

```bash
sf data query -o <alias> -q "SELECT Id, Title, FolderName, Type FROM Dashboard"
sf org open -o <alias> -p "/lightning/r/Dashboard/<id>/view"
```

`Type` must read `SpecifiedUser`. **Open it as someone other than the running user** —
that is the only way to catch the empty-dashboard failure before a real user does.

Add `<tabs>standard-Dashboard</tabs>` to the Lightning app, or it is only reachable through
the App Launcher.
