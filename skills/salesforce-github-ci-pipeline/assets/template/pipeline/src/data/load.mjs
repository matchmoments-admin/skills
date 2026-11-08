// Loading test data (see GLOSSARY.md: Data request, Core seed, Data ledger, Org data store): the use case behind
// `pipe data` and org provisioning, for Data requests and tree seeds alike, each tracked by its own Data ledger. It
// decides; the Org data store port below does the talking to an org. Two adapters fill the port:
// org/data-store.mjs (sf) and test/data-store-memory.mjs (in memory), so every ordering and failure rule here is
// tested without an org.

import { requestId, describeEntry, didYouMean, parseDataCommand, parseRequest, requestFile, DataRequestError, DATA_COMMAND_EXAMPLE } from "./request.mjs";
import { schemaOf } from "./schema.mjs";
import { objectsNeeded, loadPlan } from "./load-plan.mjs";
import { generateRecords } from "./generate.mjs";
import { profileFor } from "./profile.mjs";
import { decide, begin, record, finish, deletions, leftoversOf, summary, ledgerTitle, chunk } from "./ledger.mjs";
import { treeSeedRecords, expandSeed } from "./tree-seed.mjs";

/**
 * @typedef {object} OrgDataStore  One org's data, as the use case needs it. Facts only: no policy.
 * @property {string} alias
 * @property {number} batchSize  the most records one insert takes
 * @property {() => { orgId: string|null, username: string|null, isSandbox: boolean, isDevHub: boolean, isOurScratchOrg: boolean }} identity
 * @property {(names: string[]) => Record<string, object|null>} describe  sobject describes; null for an unknown object
 * @property {() => string[]} objectNames  every object in the org (for "did you mean")
 * @property {(object: string, records: { ref: string, fields: object }[], options?: { refsNeeded: boolean }) => { ref: string|null, id: string }[]} insert
 *   all or nothing; ref is null only when refsNeeded is false (no later record references these)
 * @property {(count: number, options: { refsNeeded: boolean }) => number} [batchSizeFor]  records per insert for a run of
 *   `count` records of one object (optional: batchSize otherwise; the sf adapter goes to Bulk API for big unreferenced runs)
 * @property {(ids: string[], options?: { object: string }) => { failed: { id: string, message: string }[] }} remove  ids of
 *   `object` (when given); an id already gone counts as removed
 * @property {number} [removeBatchSize]  the most ids one remove takes (optional: batchSize otherwise)
 * @property {(scope: string) => { state: "none" } | { state: "unreadable", detail: string } | { state: "found", ledger: object }} readLedger
 * @property {(scope: string, ledger: object) => void} saveLedger  one file per scope; each save is a new version
 * @property {(scope: string) => void} dropLedger
 * @property {() => string[]} ledgerScopes  the scope of every Data ledger in the org
 * @property {(prefix: string) => string[]} legacyMarkers  names of the marker Accounts the earlier seed mechanism left
 * @property {(names: string[]) => string[]} accountsNamed  which of these Account names the org holds (a tree seed copy no ledger tracks)
 * @property {(keys: { accountNames: string[], leadEmails: string[] }) => void} removeLegacySeed  those accounts with their
 *   cases, opportunities and contacts, and the unconverted leads with those emails (the one-time migration); throws on failure
 */

/** Refuse any org that may be production: the Dev Hub, an org that cannot be identified, and anything not a sandbox or the Dev Hub's own scratch org. */
export function guardAgainstProduction(identity, alias) {
  if (!identity.orgId) throw new Error(`refusing to load test data into ${alias}: it is production or unknown (sf cannot identify it)`);
  if (identity.isDevHub) throw new Error(`refusing to load test data into ${alias}: it is production (the Dev Hub)`);
  if (!identity.isSandbox && !identity.isOurScratchOrg) throw new Error(`refusing to load test data into ${alias}: it is not a sandbox, nor one of this Dev Hub's scratch orgs`);
}

/**
 * Load a Data request into the store's org, once. The same request already loaded: nothing happens (and production is
 * not read). Otherwise production's profile of the plan's objects is read through `profileSource` (a ProfileSource, see
 * profile.mjs; null: none), unless a `profile` is given. A changed request: the earlier records are removed by id
 * (children first; any that fail are carried into the new ledger), then the new ones are inserted batch by batch, the
 * ledger saved after each. A request that does not fit the org throws DataRequestError before anything is deleted.
 * refresh: load it even when the org already holds it, so the records follow production's shape today (a new picklist
 * value, a changed mix); the earlier records are replaced by id, as for a changed request.
 * Returns { loaded, summary, warnings, profiled } (profiled: what was read from production, in words, or null).
 */
export function loadTestData(store, { request, scope, refresh = false, profile = null, profileSource = null, rules = {}, today = new Date() }) {
  guardAgainstProduction(store.identity(), store.alias);
  const id = requestId(request);
  const decision = decide({ ...store.readLedger(scope), scope }, id, { refresh });
  if (decision.action === "skip") return { loaded: false, summary: summary(decision.ledger), warnings: [], profiled: null };
  if (decision.action === "refuse") throw new Error(decision.reason);
  const schema = describeAll(store, request);
  const plan = loadPlan(schema, request);
  if (plan.problems.length) throw new DataRequestError(plan.problems);
  const shape = profile ? { profile, warnings: [], profiled: null } : productionProfile(profileSource, plan.order, { rules, today });
  const { records, warnings } = generateRecords({ schema, plan, profile: shape.profile, rules, seed: `${scope} ${id}`, today });
  const ledger = replaceTracked(store, { scope, id, records, order: plan.order, previous: decision.previous, today, request: requestFile(request) });
  return { loaded: true, summary: `${summary(ledger)} from ${request.objects.map(describeEntry).join("; ")}`, warnings: [...shape.warnings, ...warnings], profiled: shape.profiled };
}

/**
 * Load a tree seed (the core seed, or a story's plan.json: tree-seed.mjs) into the store's org, once, tracked by a Data
 * ledger like a request: its id is the seed's (a hash of its files), so the same seed already loaded does nothing and a
 * changed one replaces exactly the earlier records by id. `legacy` ({ prefix, except }) names the marker Accounts the
 * earlier mechanism left ("[seed <hash>]", "[seed story <key> <hash>]"): an org with no ledger for this scope but such a
 * marker had the seed loaded the old way, so that copy (its accounts by name with their children, its leads by email,
 * and the markers) is removed once before this load. `supersedes`: scopes whose records this seed now holds (a story
 * seed folded into the core seed): after a load their ledgers' records go. Records people made stay.
 * Returns { loaded, summary, migrated: [marker names] | null, warnings }.
 */
export function loadTreeSeed(store, { scope, id, files, legacy = null, supersedes = [], today = new Date() }) {
  guardAgainstProduction(store.identity(), store.alias);
  const found = store.readLedger(scope);
  const decision = decide({ ...found, scope }, id);
  if (decision.action === "skip") return { loaded: false, summary: summary(decision.ledger), migrated: null, warnings: [] };
  if (decision.action === "refuse") throw new Error(decision.reason);
  const records = treeSeedRecords(expandSeed(files, { today }));
  const warnings = [];
  const migrated = found.state === "none" && legacy ? removeLegacySeed(store, records, legacy, warnings) : null;
  const ledger = replaceTracked(store, { scope, id, records, order: [...new Set(records.map((r) => r.object))], previous: decision.previous, today });
  for (const other of supersedes) if (store.readLedger(other).state === "found") warnings.push(`${removeTestData(store, other).summary} (folded into ${scope})`);
  return { loaded: true, summary: summary(ledger), migrated, warnings };
}

/**
 * A copy of a tree seed no ledger tracks, removed by the seed's own keys before the tracked load: the earlier
 * mechanism's (found by its marker Accounts), or, with no marker, the seed's own accounts already in the org (a
 * snapshot whose ledger file did not come with its records would otherwise give every new org two of each). Returns
 * what was found (marker names, or "<n> untracked accounts"), or null.
 */
function removeLegacySeed(store, records, { prefix, except = null }, warnings) {
  const seedNames = [...new Set(records.filter((r) => r.object === "Account").map((r) => r.fields.Name).filter(Boolean))];
  const markers = store.legacyMarkers(prefix).filter((name) => !except || !name.startsWith(except));
  const untracked = markers.length || !seedNames.length ? [] : store.accountsNamed(seedNames);
  if (!markers.length && !untracked.length) return null;
  if (!markers.length && !store.identity().isOurScratchOrg) {
    // a sandbox lives long and people make records in it: an account that shares a seed account's name may be theirs
    warnings.push(`found ${untracked.length} accounts named as in the seed and no Data ledger: left as they are (a sandbox's records may be people's); loading the tracked copy beside them`);
    return null;
  }
  const found = markers.length ? markers : [`${untracked.length} untracked accounts named as in the seed`];
  if (!markers.length) warnings.push(`found ${found[0]} and no Data ledger: removed them before loading (a snapshot without its ledger file?)`);
  const leadEmails = [...new Set(records.filter((r) => r.object === "Lead").map((r) => r.fields.Email).filter(Boolean))];
  try { store.removeLegacySeed({ accountNames: [...seedNames, ...markers], leadEmails }); } catch (e) {
    warnings.push(`could not remove the copy of the seed no ledger tracks (${found.join(", ")}): ${e.message}. Loading beside it; recreate the org for a clean copy`);
  }
  return found;
}

/**
 * Records into the org under a scope's ledger: the previous ledger's records removed by id first (children first; any
 * that fail are carried as leftovers), then batch by batch, each record's parent references turned into ids, then the
 * ledger marked complete. The ledger is saved when an object's records are all in, at least every SAVE_EVERY records,
 * and before a failure is thrown, so what is in the org is always tracked (one save per batch re-uploaded a ledger that
 * grows with every batch: 50 versions for 10,000 records). A batch the org refuses after anything changed is still the
 * request's problem, but says that the org now holds part of the set (a refusal otherwise means "nothing changed").
 * Returns the finished ledger.
 */
const SAVE_EVERY = 2000;

function replaceTracked(store, { scope, id, records, order, previous, today, request = null }) {
  const leftovers = previous ? removeTracked(store, previous) : {};
  let ledger = begin({ scope, requestId: id, loadedAt: today.toISOString(), order, leftovers, request });
  const ids = {}, batches = batchesOf(records, store);
  let unsaved = { object: null, ids: [] }, loadedSoFar = 0;
  const save = () => { saveOrExplain(store, scope, ledger, unsaved); unsaved = { object: null, ids: [] }; };
  for (const [i, batch] of batches.entries()) {
    let loaded;
    try { loaded = store.insert(batch.object, withParentIds(batch.records, ids), { refsNeeded: batch.refsNeeded }); } catch (e) {
      if (unsaved.ids.length) save();
      throw previous || loadedSoFar ? partialLoad(e, { previous, loadedSoFar }) : e;
    }
    for (const { ref, id: recordId } of loaded) if (ref) ids[ref] = recordId;
    ledger = record(ledger, batch.object, loaded.map((l) => l.id));
    loadedSoFar += loaded.length;
    unsaved = { object: batch.object, ids: [...(unsaved.object === batch.object ? unsaved.ids : []), ...loaded.map((l) => l.id)] };
    if (batches[i + 1]?.object !== batch.object || unsaved.ids.length >= SAVE_EVERY) save();
  }
  ledger = finish(ledger);
  save();
  return ledger;
}

/** A refusal after the org changed (earlier records removed, or some of these loaded): the same problems, plus what the org holds now. */
function partialLoad(error, { previous, loadedSoFar }) {
  if (!(error instanceof DataRequestError)) return error;
  const changed = [...(previous ? ["the earlier test data was removed"] : []), ...(loadedSoFar ? [`${loadedSoFar} new records were loaded`] : [])].join(" and ");
  const partial = new DataRequestError([...error.problems, `${changed} before the org refused these, so it holds part of the set (its Data ledger tracks it, and the next load replaces it)`]);
  partial.partial = true;
  return partial;
}

/** A typed request ("Account 20; Contact 2 per Account"), read against the org's own objects (any case, did-you-mean). Throws DataRequestError. */
export function readTypedRequest(store, typed) {
  const { request, problems } = parseDataCommand(typed, store.objectNames());
  if (!request) throw new DataRequestError(problems.length ? problems : ['say what to load, e.g. "Account 20; Contact 2 per Account"']);
  return request;
}

/** `/data refresh`: reload the story's own request, shaped like production today, instead of typing a new one. */
export const REFRESH_COMMAND = /^\s*refresh\s*$/i;

/**
 * /data on a story: the typed line read against the story's org, loaded (loadTestData, or `load` when the caller wires
 * its own defaults and logging), and only then written to `storyFile` (the story's Data request, in its file format), so
 * a request that did not load is never committed. `/data refresh` loads the story's committed request again (refresh)
 * and writes nothing. storyFile: { path, read(): text | null, write(text) }.
 * Returns { outcome: "refused", partial, problems } (the request's to change; nothing written; partial: the org changed
 * before it refused, and holds part of the set) or
 * { outcome: "loaded", summary, records, fresh, refreshed, profiled, warnings, changed, file }. Anything else throws: the run failed.
 */
export function applyDataRequest(store, { typed, scope, storyFile, load = (args) => loadTestData(store, args), ...options }) {
  const refresh = REFRESH_COMMAND.test(String(typed ?? ""));
  let request, result;
  try {
    request = refresh ? storyRequest(storyFile) : readTypedRequest(store, typed);
    result = load({ ...options, request, scope, refresh });
  } catch (e) {
    if (e instanceof DataRequestError) return { outcome: "refused", partial: Boolean(e.partial), problems: e.problems.filter((p) => p !== DATA_COMMAND_EXAMPLE) };
    throw e;
  }
  const text = JSON.stringify(requestFile(request), null, 2) + "\n";
  const changed = !refresh && storyFile.read() !== text;   // a refresh loads the committed file as it is: nothing to write
  if (changed) storyFile.write(text);
  return {
    outcome: "loaded", summary: request.objects.map(describeEntry).join("; "), records: result.summary, fresh: result.loaded, refreshed: refresh,
    profiled: result.profiled || null, warnings: result.warnings, changed, file: storyFile.path,
  };
}

/** The story's committed request, for /data refresh. Throws DataRequestError when it has none, or it does not parse. */
function storyRequest(storyFile) {
  const text = storyFile.read();
  if (!text) throw new DataRequestError([`the story has no test data to refresh yet (${storyFile.path}): say what to load, e.g. /data Account 20; Contact 2 per Account`]);
  return parseRequest(text);
}

/**
 * Refresh: load again what an org already holds, so it follows production's shape today. Every Data request set the org
 * holds (or only `scope`), each from the request its ledger keeps; tree seeds are fixed files and are not refreshed. One
 * set that no longer fits the org is reported and its records stay as they are; the others still refresh. Production is
 * read once per object across all of them (the Profile source keeps what it read for the run).
 * Returns [{ scope, outcome: "refreshed" | "skipped" | "refused", summary, problems?, warnings, profiled }].
 */
export function refreshTestData(store, { scope = null, load = (args) => loadTestData(store, args), ...options } = {}) {
  guardAgainstProduction(store.identity(), store.alias);
  const scopes = scope ? [scope] : store.ledgerScopes();
  return scopes.map((s) => {
    const found = store.readLedger(s);
    if (found.state === "unreadable") return { scope: s, outcome: "refused", summary: `${s} was not refreshed`, problems: [decide({ ...found, scope: s }, null).reason], warnings: [], profiled: null };
    if (found.state === "none") return { scope: s, outcome: "skipped", summary: `no test data for ${s}`, warnings: [], profiled: null };
    if (!found.ledger.request) return { scope: s, outcome: "skipped", summary: `${s} keeps no Data request to load again (a tree seed's records are fixed; a set loaded before refresh existed: load it once more with its request)`, warnings: [], profiled: null };
    try {
      const result = load({ ...options, request: parseRequest(found.ledger.request), scope: s, refresh: true });
      return { scope: s, outcome: "refreshed", summary: result.summary, warnings: result.warnings, profiled: result.profiled };
    } catch (e) {
      if (e instanceof DataRequestError) return { scope: s, outcome: "refused", summary: e.partial ? `${s} was refreshed only in part` : `${s} no longer fits the org: its records stay as they were`, problems: e.problems, warnings: [], profiled: null };
      throw e;
    }
  });
}

/**
 * Production's profile of the plan's objects, best effort: a source that cannot be read is one warning, and the load
 * goes on with values spread evenly (the generator names the objects). Never logs a value: only what was read.
 */
function productionProfile(source, objects, { rules, today }) {
  if (!source || !objects.length) return { profile: null, warnings: [], profiled: null };
  try {
    const { profile, queries } = profileFor(source, objects, { capturedAt: today.toISOString(), exclude: rules.profileExclude || [] });
    const partial = Object.entries(profile.objects).filter(([, o]) => o.partial).map(([name]) => name);
    return {
      profile,
      warnings: partial.length ? [`production's profile is partial for ${partial.join(", ")} (a query failed): those fields are spread evenly`] : [],
      profiled: `production profile of ${Object.keys(profile.objects).join(", ") || "nothing"} (${queries} aggregate queries)`,
    };
  } catch (e) {
    return { profile: null, warnings: [`could not read production's profile (${e.message})`], profiled: null };
  }
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
  const failures = deletions(ledger, store.removeBatchSize ?? store.batchSize).map(({ object, ids }) => ({ object, ids: store.remove(ids, { object }).failed.map((f) => f.id) }));
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

/**
 * Records cut into batches of one object each, in insert order: { object, records, refsNeeded }. refsNeeded: a later
 * record references one of them, so the store must say which reference got which id. The store sizes the batches
 * (batchSizeFor: a big run of records nothing references may go as one bulk job), else batchSize each.
 */
function batchesOf(records, store) {
  const parents = new Set(records.flatMap((r) => Object.values(r.parents)));
  const byObject = [];
  for (const r of records) {
    const last = byObject[byObject.length - 1];
    if (last?.object === r.object) last.records.push(r); else byObject.push({ object: r.object, records: [r] });
  }
  return byObject.flatMap(({ object, records: list }) => {
    const refsNeeded = list.some((r) => parents.has(r.ref));
    const size = store.batchSizeFor?.(list.length, { refsNeeded }) ?? store.batchSize;
    return chunk(list, size).map((part) => ({ object, records: part, refsNeeded }));
  });
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
