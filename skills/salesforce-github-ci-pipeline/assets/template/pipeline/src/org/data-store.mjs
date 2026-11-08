// The sf adapters of test data's two ports: the Org data store (see data/load.mjs), the one place that knows how test
// data reaches an org through the `sf` seam (describe, `sf data import tree --files`, the REST composite delete, the Data
// ledger as a ContentVersion), and the Profile source (see data/profile.mjs): production read through aggregate queries
// only, batched in REST composite batch calls. Facts only; the use case decides. pipeline/test/data.test.mjs runs both on
// recorded CLI output.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVHUB } from "./fleet.mjs";
import { ledgerTitle, encodeLedger, decodeLedger, chunk } from "../data/ledger.mjs";
import { isAggregate } from "../data/profile.mjs";
import { soqlString } from "../data/soql.mjs";
import { DataRequestError } from "../data/request.mjs";

export const BATCH_SIZE = 200;   // sf data import tree and the composite delete both take up to 200 records
export const BATCH_QUERIES = 25;   // subrequests in one REST composite batch call (plain /composite runs only 5 queries)
const LEDGER_FILE = "data-ledger.json";
const ALREADY_GONE = /ENTITY_IS_DELETED|INVALID_CROSS_REFERENCE_KEY/;

const scratchFile = (name) => join(mkdtempSync(join(tmpdir(), "data-")), name);

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
    if (body !== undefined) {
      const file = scratchFile("body.json");
      writeFileSync(file, JSON.stringify(body));
      args.push(url, "-X", method, "-H", "Content-Type:application/json", "-b", `@${file}`);
    } else {
      const definition = scratchFile("request.json");
      writeFileSync(definition, JSON.stringify({ url, method, body: { mode: "raw", raw: "" } }));
      args.push("-f", definition);
    }
    // a failed call exits 1 with the HTTP reply still in its result: keep it (allowFail "json"), so the error says why
    const reply = sf(args, { allowFail: "json" });
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
  return {
    describe(names) {
      const missing = names.filter((n) => !describes.has(n));
      for (const [name, d] of Object.entries(describeIn(rest, apiVersion, missing))) describes.set(name, d);
      return Object.fromEntries(names.map((n) => [n, describes.get(n)]));
    },
    aggregate(queries) {
      const refused = queries.find((q) => !isAggregate(q.soql));
      if (refused) throw new Error(`refusing to read production (${alias}) with a query that is not an aggregate: ${refused.soql}`);
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

/** The Org data store for one org. sf: the io seam; active: the Dev Hub's active scratch orgs (ScratchOrgInfo rows). */
export function sfDataStore({ sf, alias, apiVersion = "67.0", active = () => [] }) {
  let identityOnce = null;
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

    describe: (names) => describeIn(rest, apiVersion, names),

    /** Every object in the org. An org that cannot be listed (a login or sf error) throws: an empty list would read a typed request without its did-you-mean, as if the names were the person's mistake. */
    objectNames() {
      const names = sf(["sobject", "list", "-s", "all", "-o", alias], { allowFail: true });
      if (!Array.isArray(names)) throw new Error(`could not list the objects in ${alias} (is the org logged in?)`);
      return names;
    },

    /** One tree file; all or nothing. Throws when the reply does not account for every record. */
    insert(object, records) {
      const file = scratchFile(`${object}.json`);
      writeFileSync(file, JSON.stringify({ records: records.map((r) => ({ attributes: { type: object, referenceId: r.ref }, ...r.fields })) }));
      // a failed import exits 1 with each record's error in its data: keep them (allowFail "json"), so the error says why
      const reply = sf(["data", "import", "tree", "--files", file, "-o", alias], { allowFail: "json" });
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
    },

    remove(ids) {
      const results = rest("DELETE", `/composite/sobjects?ids=${ids.join(",")}&allOrNone=false`);
      const failed = (Array.isArray(results) ? results : []).map((r, i) => ({ id: r.id || ids[i], ok: r.success || ALREADY_GONE.test(JSON.stringify(r.errors || [])), message: r.errors?.[0]?.message || "unknown" }))
        .filter((r) => !r.ok).map(({ id, message }) => ({ id, message }));
      return { failed };
    },

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
}
