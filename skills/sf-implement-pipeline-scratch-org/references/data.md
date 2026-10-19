# Test data: the synthetic seed

Every feature org gets the same synthetic records, so people, Flows and UI tests have something to work with. They're
never production records. Apex tests never see them: they create their own data.

## Format

`data/seed/` in the trusted checkout (start from `assets/data/seed/`), in `sf data import tree` format:

- `plan.json` lists the files in load order, parents first. `saveRefs` and `resolveRefs` let a child point at a parent
  with `@Acc01`.
- One file per object, `{ "records": [ { "attributes": { "type": "Account", "referenceId": "Acc01" }, ... } ] }`.
- Date tokens are filled in at load time, so dates never go stale: `${TODAY}`, `${THIS_YEAR}`, `${LAST_YEAR}`,
  `${NEXT_YEAR}`.

## Loading once

The engine inserts a **marker Account** named for the seed's id, and skips the seed when the marker is already in the
org. If the seed changes, the old version's accounts (and their children), its leads and its marker are deleted first,
matched by the names and emails in the files, then the new version loads. Records people made in the org are kept.

A feature that adds an object can ship its own records in `data/seed/stories/<key>/plan.json`, where `<key>` is the
branch's Jira key or slug. They load only into that branch's org. Fold them into the core seed after the feature ships.

## Writing a good seed

- **Small:** tens to hundreds of records. It loads into every org.
- **Realistic shape:** the record types, picklist values and parent-child links the features depend on. Use picklist
  **codes** (`BillingCountryCode`), not labels.
- **Obviously fake:** `example.invalid` emails, "(seed)" in last names, made-up company names.
- To build one: ask what the team's next features touch, then write records that reach each Flow and each validation
  rule's paths. Check them against the org's validation rules by loading into a fresh feature org.
- Avoid records that trigger automation that queues async Apex. A pending job blocks redeploying its classes.
  sf-lifecycle-labs dropped email-origin Cases for this reason.
