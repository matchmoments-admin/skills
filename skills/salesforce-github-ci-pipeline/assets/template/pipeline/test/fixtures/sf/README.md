# Recorded sf CLI replies

The `--json` stdout of the `sf` commands the sf adapters (`pipeline/src/org/data-store.mjs`) run, recorded
from a real scratch org with `sf` 2.151.7 on 8 Nov 2026. The response headers are dropped and the ids are replaced. The
contract tests in `pipeline/test/data.test.mjs` replay them through `sfFrom`, the same reply-unwrapping the pipeline
uses. Re-record them when the CLI changes how it replies:

- `import-tree.json`: `sf data import tree --files <file>`
- `rest-post-contentversion.json`: `sf api request rest <url> -X POST -b @<file>`
- `rest-get-versiondata.json`: `sf api request rest -f <definition>` (GET); the ledger comes back already parsed
- `rest-delete-composite.json`: the composite delete; an id already deleted answers `ENTITY_IS_DELETED`
- `rest-error.json`: a 404, which exits 1 with the HTTP reply in `result`
- `import-tree-error.json`: a failed `sf data import tree` (exit 1); each record's reason is in `data`, not `message`
- `rest-composite-batch-query.json`: the Profile source's `/composite/batch` of aggregate queries, one counted and one
  failed (`INVALID_FIELD`). Recorded from the scratch org, never production: no production figure goes into git
- `query-ledgers.json`: `sf data query` listing every Data ledger in the org (`Title LIKE '[data ledger %]'`), newest
  first. A ledger's content cannot come in a batch: `/composite/batch` answers `VersionData` with
  `INVALID_BATCH_REQUEST` ("Cannot access this resource in a batch request"), so each is one GET (`rest-get-versiondata.json`)
- `query-markers.json`: `sf data query` for the marker Accounts the earlier seed mechanism left (`Name LIKE '[seed %'`;
  the record shape recorded, the names those of the live check)
- `apex-run.json` and `apex-run-error.json`: `sf apex run --file`, run and failed at run time (exit 1, the reason in
  `message`); the logs are dropped
- `bulk-import.json`, `bulk-import-failed.json`: `sf data import bulk --file <csv> --sobject Contact --wait N`; a job
  with failed records exits 1 (`FailedRecordDetailsError`) with only `data.jobId` and `data.state` (`JobComplete`)
- `bulk-results.json` with `bulk-success-records.csv` and `bulk-failed-records.csv`: `sf data bulk results --job-id`,
  which writes the two CSV files where it runs (27 loaded, 3 refused for a missing `LastName`; `sf__Id`, `sf__Error`)
