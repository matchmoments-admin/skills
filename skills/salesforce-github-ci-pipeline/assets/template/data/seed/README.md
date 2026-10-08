# Test data (seed)

Synthetic records every scratch org gets (story, CI, staging, UAT and the snapshot): for people, the Playwright UI tests,
Flow checks and demos. **Never production data.** Apex tests never see these records (they make their own with
`TestData` and `TestPersonas`).

- `plan.json` and the `*.json` files: `sf data import tree` format (reference ids like `@Acc01` link children to parents).
- Date tokens are filled in at load time, so "this year" never goes stale: `${TODAY}`, `${THIS_YEAR}`, `${LAST_YEAR}`,
  `${NEXT_YEAR}`. `${SEED_MARKER}` names the marker Account the pipeline uses to load the seed only once per org.
- A story that needs its own records adds `stories/<story key>/plan.json` (same format): loaded into that story's org.
  When the story ships, fold what everyone needs into the files here.
- Keep it small (hundreds of records) and use picklist codes (`BillingCountryCode`, not `BillingCountry`).
- Changing anything here rebuilds the snapshot (`snapshot-refresh`).
