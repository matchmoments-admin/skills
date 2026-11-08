// The sf adapters of test data's two ports: the Org data store (see data/load.mjs), the one place that knows how test
// data reaches an org through the `sf` seam (describe, `sf data import tree --files`, Bulk API 2.0 for big loads, the REST
// composite delete, the Data ledger as a ContentVersion), and the Profile source (see data/profile.mjs): production read
// through aggregate queries only, batched in REST composite batch calls. Facts only; the use case decides.
// pipeline/test/data.test.mjs runs both on recorded CLI output.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVHUB } from "./fleet.mjs";
import { ledgerTitle, scopeOfTitle, encodeLedger, decodeLedger, chunk } from "../data/ledger.mjs";
import { isAggregate, groupedField, GROUPABLE_TYPES } from "../data/profile.mjs";
import { soqlString } from "../data/soql.mjs";
import { DataRequestError } from "../data/request.mjs";

export const BATCH_SIZE = 200;   // sf data import tree and the composite delete both take up to 200 records
export const BATCH_QUERIES = 25;   // subrequests in one REST composite batch call (plain /composite runs only 5 queries)
// More records of one object than BULK_FROM, none of them a parent of a later record (Bulk API results come back in no
// set order, so they cannot be matched to their references): one Bulk API 2.0 job of up to BULK_MAX instead of
// BULK_FROM / 200 tree imports and ledger saves. BULK_WAIT: minutes `sf data import bulk` waits for the job.
export const BULK_FROM = 2000;
export const BULK_MAX = 10000;
export const BULK_WAIT = 15;
const LEDGER_FILE = "data-ledger.json";
const ALREADY_GONE = /ENTITY_IS_DELETED|INVALID_CROSS_REFERENCE_KEY/;

/** `text` in a file of its own for the length of `use(path)`, removed afterwards (a 10,000-record load writes hundreds). */
function withScratchFile(name, text, use) {
  const dir = mkdtempSync(join(tmpdir(), "data-"));
  try { const path = join(dir, name); writeFileSync(path, text); return use(path, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * GET requests sent 25 to a REST composite batch call (haltOnError false: each answers alone; plain /composite stops
 * after 5 queries with PROCESSING_HALTED, found live 8 Nov). paths: relative to /services/data ("v67.0/query?q=...").
 * Returns one { ok, result } per path, in order.
 */
function batchGet(rest, paths) {
  const answers = [];
  for (const part of chunk(paths, BATCH_QUERIES)) {
    const reply = rest("POST", "/composite/batch", { haltOnError: false, batchRequests: part.map((url) => ({ method: "GET", url })) });
    part.forEach((_, i) => { const a = reply?.results?.[i]; answers.push({ ok: Boolean(a) && Number(a.statusCode) < 300, result: a?.result ?? "no reply" }); });
  }
  return answers;
}

/** sobject describes, batched (one call per 25 objects instead of one sf process each); null for an object the org lacks. */
function describeIn(rest, apiVersion, names) {
  const answers = names.length ? batchGet(rest, names.map((name) => `v${apiVersion}/sobjects/${name}/describe`)) : [];
  return Object.fromEntries(names.map((name, i) => [name, answers[i].ok ? answers[i].result : null]));
}

/**
 * One REST call in an org; the reply's `body` is unwrapped and a 4xx or 5xx throws. A body goes as a file (`-b @file`:
 * without the @ the CLI sends the path itself). A call without one goes as a request definition with an empty raw body:
 * `sf api request rest -X DELETE` alone fails with "No 'mode' found in 'body' entry" (sf 2.151.7, checked 8 Nov).
 */
function restIn({ sf, alias, apiVersion }) {
  return function rest(method, path, body) {
    const url = `/services/data/v${apiVersion}${path}`;
    const args = ["api", "request", "rest", "-o", alias];
    // a failed call exits 1 with the HTTP reply still in its result: keep it (allowFail "json"), so the error says why
    const reply = body !== undefined
      ? withScratchFile("body.json", JSON.stringify(body), (file) => sf([...args, url, "-X", method, "-H", "Content-Type:application/json", "-b", `@${file}`], { allowFail: "json" }))
      : withScratchFile("request.json", JSON.stringify({ url, method, body: { mode: "raw", raw: "" } }), (file) => sf([...args, "-f", file], { allowFail: "json" }));
    if (reply?.failed && reply.statusCode === undefined) throw new Error(`sf api request rest ${method} ${path} failed in ${alias} (no HTTP reply: is the org logged in?)`);
    const status = Number(reply?.statusCode ?? 200);
    if (status >= 400) throw new Error(`${method} ${path} in ${alias} answered ${status}: ${JSON.stringify(reply?.body ?? "").slice(0, 300)}`);
    return reply?.body;
  };
}

/**
 * Production as the Profile source (data/profile.mjs): describes and aggregate queries, each sent 25 to a REST composite
 * batch call (batchGet: one query that fails is an error for that query alone). A query that is not an aggregate is
 * refused before anything is sent: the profile never reads a record. Results are kept for the run, so staging, which loads every story's request,
 * reads each object once.
 */
export function sfProfileSource({ sf, alias = DEVHUB, apiVersion = "67.0" }) {
  const rest = restIn({ sf, alias, apiVersion });
  const describes = new Map(), results = new Map();
  function describe(names) {
    const missing = names.filter((n) => !describes.has(n));
    for (const [name, d] of Object.entries(describeIn(rest, apiVersion, missing))) describes.set(name, d);
    return Object.fromEntries(names.map((n) => [n, describes.get(n)]));
  }
  return {
    describe,
    aggregate(queries) {
      const refused = queries.find((q) => !isAggregate(q.soql));
      if (refused) throw new Error(`refusing to read production (${alias}) with a query that is not an aggregate: ${refused.soql}`);
      // a group by returns the values themselves: only a picklist's or a checkbox's, by production's own describe
      const groups = queries.map((q) => groupedField(q.soql)).filter(Boolean);
      const types = describe([...new Set(groups.map((g) => g.object))]);
      const text = groups.find((g) => !GROUPABLE_TYPES.includes(types[g.object]?.fields?.find((f) => f.name === g.field)?.type));
      if (text) throw new Error(`refusing to read production (${alias}) grouped by ${text.object}.${text.field}: only picklists and checkboxes are grouped (their values are not typed by people)`);
      const todo = [...new Set(queries.map((q) => q.soql).filter((soql) => !results.has(soql)))];
      batchGet(rest, todo.map((soql) => `v${apiVersion}/query?q=${encodeURIComponent(soql)}`)).forEach(({ ok, result }, i) => {
        results.set(todo[i], ok ? { records: result?.records || [] } : { error: JSON.stringify(result).slice(0, 200) });
      });
      return queries.map((query) => ({ query, ...results.get(query.soql) }));
    },
  };
}

/** A failed tree import's record errors, each distinct one once with how many records it hit: "FIELD_INTEGRITY_EXCEPTION ... (BillingCountryCode) x5". */
function importErrors(reply) {
  const errors = Object.values(reply).filter((e) => e && typeof e === "object" && e.StatusCode).map((e) => `${e.StatusCode}: ${e.Message}${e.fields ? ` (${e.fields})` : ""}`);
  if (!errors.length) return null;
  const counts = errors.reduce((acc, e) => acc.set(e, (acc.get(e) || 0) + 1), new Map());
  return [...counts].map(([e, n]) => `${e}${n > 1 ? ` x${n}` : ""}`).join("; ");
}

/** Field values as Bulk API 2.0 CSV: a header of every field, each value quoted ("" for a quote), empty for none. Pure. */
export function toCsv(rows) {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => (v === null || v === undefined ? "" : `"${String(v).replace(/"/g, '""')}"`);
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

/** A Bulk API results CSV (quoted fields, "" escapes, newlines inside quotes) as rows keyed by its header. Pure. */
export function fromCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...data] = rows;
  return data.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
}

const counted = (texts) => [...texts.reduce((acc, t) => acc.set(t, (acc.get(t) || 0) + 1), new Map())].map(([t, n]) => `${t}${n > 1 ? ` x${n}` : ""}`).join("; ");

/**
 * Anonymous Apex that removes a tree seed loaded the earlier way (marker Accounts, before the Data ledger tracked tree
 * seeds), by the seed's own keys: its accounts by name (their cases, opportunities and contacts first) and its
 * unconverted leads by email. The markers are among the names. Records people made on other accounts stay. Pure.
 */
export function legacySeedApex({ accountNames, leadEmails = [] }) {
  const list = (xs) => xs.map((x) => soqlString(x)).join(", ");
  return [
    `Set<String> names = new Set<String>{ ${list(accountNames)} };`,
    "List<Account> a = [SELECT Id FROM Account WHERE Name IN :names];",
    "delete [SELECT Id FROM Case WHERE AccountId IN :a];",
    "delete [SELECT Id FROM Opportunity WHERE AccountId IN :a];",
    "delete [SELECT Id FROM Contact WHERE AccountId IN :a];",
    "delete a;",
    ...(leadEmails.length ? [`Set<String> emails = new Set<String>{ ${list(leadEmails)} };`, "delete [SELECT Id FROM Lead WHERE Email IN :emails AND IsConverted = false];"] : []),
  ].join("\n");
}

/** The Org data store for one org. sf: the io seam; active: the Dev Hub's active scratch orgs (ScratchOrgInfo rows). */
export function sfDataStore({ sf, alias, apiVersion = "67.0", active = () => [] }) {
  let identityOnce = null;
  const describes = new Map();
  const rest = restIn({ sf, alias, apiVersion });

  const query = (soql, opts) => sf(["data", "query", "-o", alias, "-q", soql], opts)?.records || [];

  // Every Data ledger in the org, listed once per store on first use (one query), so a scope with no ledger costs nothing
  // and one with a ledger one GET of its content, read once and kept: staging reads every story's ledger, which was two
  // sf calls per story. Title -> { versionId, documentId, found }. Saves and drops keep it current, so a ledger written
  // during the run reads back as written. The listing query throws when it fails: "no ledger" would load a second,
  // untracked set. The contents cannot be batched: /composite/batch answers VersionData with INVALID_BATCH_REQUEST
  // ("Cannot access this resource in a batch request"), and /composite with JSON_PARSER_ERROR (live, 8 Nov).
  let ledgers = null;
  function allLedgers() {
    if (ledgers) return ledgers;
    const rows = query(`SELECT Id, ContentDocumentId, Title FROM ContentVersion WHERE Title LIKE ${soqlString(ledgerTitle("%"))} AND IsLatest = true ORDER BY CreatedDate DESC`);
    ledgers = new Map();
    for (const r of rows) if (!ledgers.has(r.Title)) ledgers.set(r.Title, { versionId: r.Id, documentId: r.ContentDocumentId, found: null });   // newest first
    return ledgers;
  }
  const readContent = (content) => {
    const ledger = decodeLedger(content);
    return ledger ? { state: "found", ledger } : { state: "unreadable", detail: `${LEDGER_FILE} is not a ledger` };
  };
  function contentOf(entry) {
    if (entry.found) return entry.found;
    try { entry.found = readContent(rest("GET", `/sobjects/ContentVersion/${entry.versionId}/VersionData`)); } catch (e) { entry.found = { state: "unreadable", detail: e.message }; }
    return entry.found;
  }

  return {
    alias,
    batchSize: BATCH_SIZE,

    /** Read once per store: who the org is. isOurScratchOrg is asked only when the org is not a sandbox. */
    identity() {
      if (identityOnce) return identityOnce;
      const me = sf(["org", "display", "-o", alias], { allowFail: true });
      const hub = sf(["org", "display", "-o", DEVHUB], { allowFail: true });
      const sameOrg = Boolean(me?.id && hub?.id && String(me.id).slice(0, 15) === String(hub.id).slice(0, 15));
      const isSandbox = query("SELECT IsSandbox FROM Organization", { allowFail: true })[0]?.IsSandbox === true;
      identityOnce = {
        orgId: me?.id || null, username: me?.username || null, isSandbox, isDevHub: sameOrg,
        get isOurScratchOrg() { return active().some((o) => o.SignupUsername === me?.username); },
      };
      return identityOnce;
    },

    /** Each object described once per store (staging loads every story's request: the same objects each time). */
    describe(names) {
      const missing = names.filter((n) => !describes.has(n));
      for (const [name, d] of Object.entries(describeIn(rest, apiVersion, missing))) describes.set(name, d);
      return Object.fromEntries(names.map((n) => [n, describes.get(n)]));
    },

    /** Every object in the org. An org that cannot be listed (a login or sf error) throws: an empty list would read a typed request without its did-you-mean, as if the names were the person's mistake. */
    objectNames() {
      const names = sf(["sobject", "list", "-s", "all", "-o", alias], { allowFail: true });
      if (!Array.isArray(names)) throw new Error(`could not list the objects in ${alias} (is the org logged in?)`);
      return names;
    },

    /** How many of `count` records of one object to send per insert: a Bulk API job above BULK_FROM when no later record needs their ids by reference. */
    batchSizeFor: (count, { refsNeeded = true } = {}) => (!refsNeeded && count > BULK_FROM ? BULK_MAX : BATCH_SIZE),

    /**
     * All or nothing. Up to 200 records: one tree file (each { ref, id }). More (only when the caller said no reference
     * needs them, refsNeeded false): one Bulk API 2.0 job, whose ids come back with ref null; if any record fails, the
     * ones that loaded are deleted again and the reasons thrown.
     */
    insert(object, records, { refsNeeded = true } = {}) {
      if (records.length <= BATCH_SIZE) return treeInsert(object, records);
      if (refsNeeded) throw new Error(`${records.length} ${object} records in one insert: a tree import takes ${BATCH_SIZE}, and a Bulk API job cannot say which reference got which id`);
      return bulkInsert(object, records);
    },

    removeBatchSize: BULK_MAX,   // removeTracked hands one object's ids up to this many at a time; removeIds picks REST or Bulk API
    remove: (ids, { object = null } = {}) => removeIds(ids, object),

    /** The marker Accounts the earlier seed mechanism left whose Name starts with `prefix`. A query that fails throws. */
    legacyMarkers(prefix) {
      return query(`SELECT Name FROM Account WHERE Name LIKE ${soqlString(`${prefix}%`)}`).map((r) => r.Name);
    },

    /** Which of these Account names the org holds, 200 names per query. A query that fails throws. */
    accountsNamed(names) {
      return chunk(names, BATCH_SIZE).flatMap((part) => query(`SELECT Name FROM Account WHERE Name IN (${part.map((n) => soqlString(n)).join(", ")})`).map((r) => r.Name));
    },

    /** Remove a tree seed loaded the earlier way, by its keys (legacySeedApex), in one anonymous Apex call. Throws when it fails. */
    removeLegacySeed(keys) {
      withScratchFile("legacy-seed.apex", legacySeedApex(keys), (file) => sf(["apex", "run", "--file", file, "-o", alias]));
    },

    ledgerScopes: () => [...allLedgers().keys()].map(scopeOfTitle).filter(Boolean),

    readLedger(scope) {
      const entry = allLedgers().get(ledgerTitle(scope));
      return entry ? contentOf(entry) : { state: "none" };
    },

    saveLedger(scope, ledger) {
      const title = ledgerTitle(scope);
      const documentId = allLedgers().get(title)?.documentId ?? null;
      const created = rest("POST", "/sobjects/ContentVersion", {
        Title: title, PathOnClient: LEDGER_FILE, VersionData: Buffer.from(encodeLedger(ledger)).toString("base64"),
        ...(documentId ? { ContentDocumentId: documentId } : {}),
      });
      if (!created?.id) throw new Error(`the org did not return an id for ${title}`);
      const savedIn = documentId || query(`SELECT ContentDocumentId FROM ContentVersion WHERE Id = ${soqlString(created.id)}`)[0]?.ContentDocumentId;
      ledgers.set(title, { versionId: created.id, documentId: savedIn, found: readContent(encodeLedger(ledger)) });
    },

    dropLedger(scope) {
      const title = ledgerTitle(scope);
      const documentId = allLedgers().get(title)?.documentId;
      if (documentId) rest("DELETE", `/sobjects/ContentDocument/${documentId}`);
      ledgers.delete(title);
    },
  };

  /** One tree file; all or nothing. Throws when the reply does not account for every record. */
  function treeInsert(object, records) {
    const tree = JSON.stringify({ records: records.map((r) => ({ attributes: { type: object, referenceId: r.ref }, ...r.fields })) });
    // a failed import exits 1 with each record's error in its data: keep them (allowFail "json"), so the error says why
    const reply = withScratchFile(`${object}.json`, tree, (file) => sf(["data", "import", "tree", "--files", file, "-o", alias], { allowFail: "json" }));
    if (reply?.failed) {
      const refused = importErrors(reply);
      // the org refused the records (a validation rule, a restricted value): the request's to change, so say it as one
      if (refused) throw new DataRequestError([`${alias} refused the ${records.length} ${object} records: ${refused}`]);
      throw new Error(`sf data import tree loaded none of ${records.length} ${object} records into ${alias} (no reason given)`);
    }
    const rows = Array.isArray(reply) ? reply : reply?.records || [];
    const loaded = rows.filter((r) => r?.refId && r?.id).map((r) => ({ ref: r.refId, id: r.id }));
    if (loaded.length !== records.length) throw new Error(`sf data import tree loaded ${loaded.length} of ${records.length} ${object} records into ${alias}`);
    return loaded;
  }

  /**
   * One Bulk API 2.0 job (`sf data import bulk`, then `sf data bulk results` for the ids, written as CSV files where it
   * runs). A job that finished with failed records (exit 1, FailedRecordDetailsError) is made all or nothing: the records
   * that loaded are deleted again by id, then the distinct reasons are a DataRequestError. A job that did not finish
   * (timed out) cannot be taken back by id: the error names it.
   */
  function bulkInsert(object, records) {
    return withScratchFile(`${object}.csv`, toCsv(records.map((r) => r.fields)), (file, dir) => bulkInsertJob(object, records, file, dir));
  }

  function bulkInsertJob(object, records, file, dir) {
    const job = sf(["data", "import", "bulk", "--file", file, "--sobject", object, "--line-ending", "LF", "--wait", String(BULK_WAIT), "-o", alias], { allowFail: "json" });
    if (!job?.jobId) throw new Error(`sf data import bulk loaded none of ${records.length} ${object} records into ${alias} (no job started)`);
    if (job.failed && job.state !== "JobComplete") {
      throw new Error(`the Bulk API job ${job.jobId} for ${records.length} ${object} records in ${alias} did not finish (${job.state || "timed out"}): what it loaded is not tracked; see Setup > Bulk Data Load Jobs, delete them by hand or recreate the org`);
    }
    const results = sf(["data", "bulk", "results", "--job-id", job.jobId, "-o", alias], { cwd: dir });
    const read = (path) => (path ? fromCsv(readFileSync(join(dir, path), "utf8")) : []);
    const ids = read(results?.successFilePath).map((row) => row.sf__Id).filter(Boolean);
    const failed = Number(results?.failedRecords || 0) ? read(results.failedFilePath).map((row) => row.sf__Error.replace(/:?\s*--\s*$/, "")) : [];
    if (!failed.length && ids.length === records.length) return ids.map((id) => ({ ref: null, id }));
    const kept = removeIds(ids, object).failed.map((f) => f.id);
    if (kept.length) throw new Error(`the Bulk API job ${job.jobId} loaded ${ids.length} of ${records.length} ${object} records into ${alias}, and ${kept.length} of them could not be deleted again (${kept.slice(0, 5).join(", ")}${kept.length > 5 ? ", ..." : ""}): delete them by hand or recreate the org`);
    if (!failed.length) throw new Error(`the Bulk API job ${job.jobId} loaded ${ids.length} of ${records.length} ${object} records into ${alias}; they were deleted again`);
    throw new DataRequestError([`${alias} refused ${failed.length} of the ${records.length} ${object} records: ${counted(failed)} (the ${ids.length} that loaded were deleted again)`]);
  }

  /**
   * Delete ids (of one object, when `object` is given): up to BULK_FROM by REST composite deletes of 200 each; more, of
   * a named object, as one Bulk API 2.0 delete job (one sf process instead of one per 200). An id already gone counts as
   * deleted. Returns { failed: [{ id, message }] }.
   */
  function removeIds(ids, object = null) {
    if (object && ids.length > BULK_FROM) return bulkDelete(object, ids);
    const failed = chunk(ids, BATCH_SIZE).flatMap((part) => {
      const results = rest("DELETE", `/composite/sobjects?ids=${part.join(",")}&allOrNone=false`);
      return (Array.isArray(results) ? results : []).map((r, i) => ({ id: r.id || part[i], ok: r.success || ALREADY_GONE.test(JSON.stringify(r.errors || [])), message: r.errors?.[0]?.message || "unknown" }));
    });
    return { failed: failed.filter((r) => !r.ok).map(({ id, message }) => ({ id, message })) };
  }

  /**
   * One Bulk API 2.0 delete job. Its reply differs by outcome (sf 2.151.7, recorded 9 Nov): all deleted, `{ jobInfo: { id,
   * state } }`; some rows failed, exit 1 with `{ jobId, state: "JobComplete" }` (FailedRecordDetailsError), and the
   * failed rows are read from the job's results. A job that did not finish throws: what it deleted is unknown.
   */
  function bulkDelete(object, ids) {
    return withScratchFile(`${object}-delete.csv`, toCsv(ids.map((Id) => ({ Id }))), (file, dir) => {
      const job = sf(["data", "delete", "bulk", "--file", file, "--sobject", object, "--line-ending", "LF", "--wait", String(BULK_WAIT), "-o", alias], { allowFail: "json" });
      const jobId = job?.jobId || job?.jobInfo?.id, state = job?.state || job?.jobInfo?.state;
      if (!jobId || state !== "JobComplete") throw new Error(`the Bulk API delete of ${ids.length} ${object} records in ${alias} did not finish (${state || "no job started"}): the Data ledger still lists them, so the next load deletes them again`);
      if (!job.failed) return { failed: [] };
      const results = sf(["data", "bulk", "results", "--job-id", jobId, "-o", alias], { cwd: dir });
      const rows = results?.failedFilePath ? fromCsv(readFileSync(join(dir, results.failedFilePath), "utf8")) : [];
      return { failed: rows.filter((r) => !ALREADY_GONE.test(r.sf__Error || "")).map((r) => ({ id: r.sf__Id || r.Id, message: (r.sf__Error || "unknown").replace(/:?\s*--\s*$/, "") })) };
    });
  }
}
