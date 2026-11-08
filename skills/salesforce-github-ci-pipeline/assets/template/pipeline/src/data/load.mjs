// Loading test data (see GLOSSARY.md: Data request, Data ledger, Org data store): the use case behind `pipe data` and
// org provisioning. It decides; the Org data store port below does the talking to an org. Two adapters fill the port:
// org/data-store.mjs (sf) and test/data-store-memory.mjs (in memory), so every ordering and failure rule here is
// tested without an org.

import { requestId, describeEntry, didYouMean, DataRequestError } from "./request.mjs";
import { schemaOf } from "./schema.mjs";
import { objectsNeeded, loadPlan } from "./load-plan.mjs";
import { generateRecords } from "./generate.mjs";
import { decide, begin, record, finish, deletions, leftoversOf, summary, ledgerTitle, chunk } from "./ledger.mjs";

/**
 * @typedef {object} OrgDataStore  One org's data, as the use case needs it. Facts only: no policy.
 * @property {string} alias
 * @property {number} batchSize  the most records one insert takes
 * @property {() => { orgId: string|null, username: string|null, isSandbox: boolean, isDevHub: boolean, isOurScratchOrg: boolean }} identity
 * @property {(names: string[]) => Record<string, object|null>} describe  sobject describes; null for an unknown object
 * @property {() => string[]} objectNames  every object in the org (for "did you mean")
 * @property {(object: string, records: { ref: string, fields: object }[]) => { ref: string, id: string }[]} insert  all or nothing
 * @property {(ids: string[]) => { failed: { id: string, message: string }[] }} remove  an id already gone counts as removed
 * @property {(scope: string) => { state: "none" } | { state: "unreadable", detail: string } | { state: "found", ledger: object }} readLedger
 * @property {(scope: string, ledger: object) => void} saveLedger  one file per scope; each save is a new version
 * @property {(scope: string) => void} dropLedger
 */

/** Refuse any org that may be production: the Dev Hub, an org that cannot be identified, and anything not a sandbox or the Dev Hub's own scratch org. */
export function guardAgainstProduction(identity, alias) {
  if (!identity.orgId) throw new Error(`refusing to load test data into ${alias}: it is production or unknown (sf cannot identify it)`);
  if (identity.isDevHub) throw new Error(`refusing to load test data into ${alias}: it is production (the Dev Hub)`);
  if (!identity.isSandbox && !identity.isOurScratchOrg) throw new Error(`refusing to load test data into ${alias}: it is not a sandbox, nor one of this Dev Hub's scratch orgs`);
}

/**
 * Load a Data request into the store's org, once. The same request already loaded: nothing happens. A changed request:
 * the earlier records are removed by id (children first; any that fail are carried into the new ledger), then the new
 * ones are inserted batch by batch, the ledger saved after each. A request that does not fit the org throws
 * DataRequestError before anything is deleted. Returns { loaded, summary, warnings }.
 */
export function loadTestData(store, { request, scope, profile = null, rules = {}, today = new Date() }) {
  guardAgainstProduction(store.identity(), store.alias);
  const id = requestId(request);
  const decision = decide({ ...store.readLedger(scope), scope }, id);
  if (decision.action === "skip") return { loaded: false, summary: summary(decision.ledger), warnings: [] };
  if (decision.action === "refuse") throw new Error(decision.reason);
  const schema = describeAll(store, request);
  const plan = loadPlan(schema, request);
  if (plan.problems.length) throw new DataRequestError(plan.problems);
  const { records, warnings } = generateRecords({ schema, plan, profile, rules, seed: `${scope} ${id}`, today });
  const leftovers = decision.previous ? removeTracked(store, decision.previous) : {};
  let ledger = begin({ scope, requestId: id, loadedAt: today.toISOString(), order: plan.order, leftovers });
  const ids = {};
  for (const batch of batchesOf(records, store.batchSize)) {
    const loaded = store.insert(batch.object, withParentIds(batch.records, ids));
    for (const { ref, id: recordId } of loaded) ids[ref] = recordId;
    ledger = record(ledger, batch.object, loaded.map((l) => l.id));
    saveOrExplain(store, scope, ledger, { object: batch.object, ids: loaded.map((l) => l.id) });
  }
  ledger = finish(ledger);
  saveOrExplain(store, scope, ledger, { object: null, ids: [] });
  return { loaded: true, summary: `${summary(ledger)} from ${request.objects.map(describeEntry).join("; ")}`, warnings };
}

/** Remove everything a scope's ledger tracks (the undo). Ids that fail stay in the ledger; the ledger goes once it is empty. */
export function removeTestData(store, scope) {
  guardAgainstProduction(store.identity(), store.alias);
  const found = store.readLedger(scope);
  const decision = decide({ ...found, scope }, null);
  if (decision.action === "refuse") throw new Error(decision.reason);
  if (!decision.previous) return { removed: false, summary: `no test data for ${scope}` };
  const leftovers = removeTracked(store, decision.previous);
  if (Object.keys(leftovers).length) {
    const kept = begin({ scope, requestId: null, loadedAt: decision.previous.loadedAt, order: decision.previous.order, leftovers });
    store.saveLedger(scope, finish(kept));
    return { removed: true, summary: summary(finish(kept)) };
  }
  store.dropLedger(scope);
  return { removed: true, summary: `removed the test data for ${scope}` };
}

/** What the org holds for a scope: { state: "none" | "unreadable" | "found", summary }. */
export function testDataStatus(store, scope) {
  const found = store.readLedger(scope);
  if (found.state === "found") return { state: "found", requestId: found.ledger.requestId, loadedAt: found.ledger.loadedAt, summary: summary(found.ledger) };
  return { state: found.state, summary: found.state === "none" ? `no test data for ${scope}` : `${ledgerTitle(scope)} cannot be read (${found.detail})` };
}

/** Describe the request's objects and every parent they need, until nothing new is needed. Unknown objects: did-you-mean. */
function describeAll(store, request) {
  const describes = {};
  for (let round = 0; round < 6; round++) {
    const pending = objectsNeeded(schemaOf(Object.values(describes)), request).filter((name) => !(name in describes));
    if (!pending.length) break;
    Object.assign(describes, store.describe(pending));
  }
  const unknown = [...new Set(request.objects.map((e) => e.object).filter((name) => !describes[name]))];
  if (unknown.length) {
    const known = store.objectNames();
    throw new DataRequestError(unknown.map((name) => `"${name}" is not an object in ${store.alias}${didYouMean(name, known)}`));
  }
  return schemaOf(Object.values(describes));
}

/** Delete a ledger's records and leftovers, children first. Returns the ids that would not go, by object. */
function removeTracked(store, ledger) {
  const failures = deletions(ledger, store.batchSize).map(({ object, ids }) => ({ object, ids: store.remove(ids).failed.map((f) => f.id) }));
  return leftoversOf(failures);
}

/** Save the ledger, once more if the first save fails; then say exactly which records are now untracked. */
function saveOrExplain(store, scope, ledger, justLoaded) {
  try { store.saveLedger(scope, ledger); return; } catch { /* one retry: a save failing once is usually transient */ }
  try { store.saveLedger(scope, ledger); } catch (e) {
    const untracked = justLoaded.ids.length ? ` The ${justLoaded.ids.length} ${justLoaded.object} records just loaded (${justLoaded.ids.slice(0, 5).join(", ")}${justLoaded.ids.length > 5 ? ", ..." : ""}) are not in it: delete them by hand or recreate the org.` : "";
    throw new Error(`could not save ${ledgerTitle(scope)} in ${store.alias}: ${e.message}.${untracked}`);
  }
}

/** Records cut into batches of one object each, in insert order. */
function batchesOf(records, size) {
  const byObject = [];
  for (const r of records) {
    const last = byObject[byObject.length - 1];
    if (last?.object === r.object) last.records.push(r); else byObject.push({ object: r.object, records: [r] });
  }
  return byObject.flatMap(({ object, records: list }) => chunk(list, size).map((part) => ({ object, records: part })));
}

/** Each record's parent references replaced by the ids those parents got. A parent with no id yet is a bug: say which. */
function withParentIds(records, ids) {
  return records.map((r) => ({
    ref: r.ref,
    fields: {
      ...r.fields,
      ...Object.fromEntries(Object.entries(r.parents).map(([field, ref]) => {
        if (!ids[ref]) throw new Error(`${r.ref}.${field}: its parent ${ref} has no id yet (parents must load first)`);
        return [field, ids[ref]];
      })),
    },
  }));
}
