// The Org data store's in-memory adapter (the port is in pipeline/src/data/load.mjs): an org as a map of records, with
// failures on demand, so the use case's ordering and failure rules are tested without an org or the sf CLI.
import { decodeLedger, encodeLedger } from "../src/data/ledger.mjs";

/**
 * describes: { [object]: sobject describe }. Failures: failInsert (the Nth insert throws), failSaves (that many ledger
 * saves throw), refuseDeletes (ids that will not delete), unreadableLedger (a ledger file that is not a ledger),
 * failLegacy (removing a seed loaded the earlier way fails). bulk: { from, max }, see batchSizeFor.
 */
export function memoryDataStore({ describes = {}, identity = {}, batchSize = 200, failInsert = null, failSaves = 0, refuseDeletes = [], unreadableLedger = false, failLegacy = false, bulk = null } = {}) {
  const records = new Map(), ledgers = {};
  let inserts = 0, saves = 0, nextId = 0, savesToFail = failSaves;
  const calls = [], insertOptions = [];
  return {
    alias: "memory-org",
    batchSize,
    // bulk: { from, max } sizes a big run of unreferenced records as the sf adapter does (Bulk API above `from`)
    ...(bulk ? { batchSizeFor: (count, { refsNeeded }) => (!refsNeeded && count > bulk.from ? bulk.max : batchSize) } : {}),
    insertOptions,
    calls,
    identity: () => ({ orgId: "00DMEMORY", username: "test@memory", isSandbox: true, isDevHub: false, isOurScratchOrg: false, ...identity }),
    describe: (names) => { calls.push(`describe ${names.join(",")}`); return Object.fromEntries(names.map((n) => [n, describes[n] || null])); },
    objectNames: () => Object.keys(describes),
    insert(object, list, { refsNeeded = true } = {}) {
      inserts++;
      calls.push(`insert ${object} ${list.length}`);
      insertOptions.push({ object, count: list.length, refsNeeded });
      if (inserts === failInsert) throw new Error(`insert ${inserts} failed on purpose`);
      return list.map((r) => {
        const id = `${object.slice(0, 3).toUpperCase()}${String(++nextId).padStart(4, "0")}`;
        records.set(id, { object, ...r.fields });
        return { ref: bulk && !refsNeeded && list.length > batchSize ? null : r.ref, id };   // a bulk job cannot say which ref got which id
      });
    },
    remove(ids) {
      calls.push(`remove ${ids.length}`);
      const failed = ids.filter((id) => refuseDeletes.includes(id)).map((id) => ({ id, message: "DELETE_FAILED on purpose" }));
      for (const id of ids) if (!refuseDeletes.includes(id)) records.delete(id);
      return { failed };
    },
    legacyMarkers(prefix) {
      calls.push(`legacyMarkers ${prefix}`);
      return [...records.values()].filter((r) => r.object === "Account" && String(r.Name || "").startsWith(prefix)).map((r) => r.Name);
    },
    accountsNamed(names) {
      calls.push(`accountsNamed ${names.length}`);
      return [...records.values()].filter((r) => r.object === "Account" && names.includes(r.Name)).map((r) => r.Name);
    },
    removeLegacySeed({ accountNames, leadEmails = [] }) {
      calls.push(`removeLegacySeed ${accountNames.length} ${leadEmails.length}`);
      if (failLegacy) throw new Error("apex run failed on purpose");
      const accounts = new Set([...records].filter(([, r]) => r.object === "Account" && accountNames.includes(r.Name)).map(([id]) => id));
      for (const [id, r] of records) {
        if (accounts.has(id) || (["Case", "Opportunity", "Contact"].includes(r.object) && accounts.has(r.AccountId))) records.delete(id);
        else if (r.object === "Lead" && leadEmails.includes(r.Email) && !r.IsConverted) records.delete(id);
      }
    },
    readLedger(scope) {
      if (unreadableLedger) return { state: "unreadable", detail: "data-ledger.json is not a ledger" };
      if (!ledgers[scope]) return { state: "none" };
      return { state: "found", ledger: decodeLedger(ledgers[scope]) };
    },
    saveLedger(scope, ledger) {
      saves++;
      if (savesToFail > 0) { savesToFail--; throw new Error(`save ${saves} failed on purpose`); }
      ledgers[scope] = encodeLedger(ledger);
    },
    dropLedger(scope) { delete ledgers[scope]; },
    // for the tests: a record made by a person, what the org holds, and its ledger
    addByHand(object, fields) { const id = `HAND${++nextId}`; records.set(id, { object, ...fields }); return id; },
    holds: (id) => records.has(id),
    count: (object, where = () => true) => [...records.values()].filter((r) => r.object === object && where(r)).length,
    ledger: (scope) => (ledgers[scope] ? JSON.parse(ledgers[scope]) : null),
    refuseDeletesOf(ids) { refuseDeletes = ids; },
    stopFailing() { refuseDeletes = []; failInsert = null; },
  };
}

/**
 * The Profile source's in-memory adapter (the port is in pipeline/src/data/profile.mjs): production as describes and an
 * answer per aggregate query (answer(query) -> rows, or throws for that query). fail: the whole source cannot be read.
 * calls lists what was asked, so tests can prove when production was (and was not) read.
 */
export function memoryProfileSource({ describes, answer = () => [], fail = null }) {
  const calls = [];
  return {
    calls,
    describe(names) {
      calls.push(`describe ${names.join(",")}`);
      if (fail) throw new Error(fail);
      return Object.fromEntries(names.map((n) => [n, describes[n] || null]));
    },
    aggregate(queries) {
      calls.push(`aggregate ${queries.length}`);
      return queries.map((query) => { try { return { query, records: answer(query) }; } catch (e) { return { query, error: e.message }; } });
    },
  };
}
