// The Org data store's in-memory adapter (the port is in pipeline/src/data/load.mjs): an org as a map of records, with
// failures on demand, so the use case's ordering and failure rules are tested without an org or the sf CLI.
import { decodeLedger, encodeLedger } from "../src/data/ledger.mjs";

/**
 * describes: { [object]: sobject describe }. Failures: failInsert (the Nth insert throws), failSaves (that many ledger
 * saves throw), refuseDeletes (ids that will not delete), unreadableLedger (a ledger file that is not a ledger).
 */
export function memoryDataStore({ describes, identity = {}, batchSize = 200, failInsert = null, failSaves = 0, refuseDeletes = [], unreadableLedger = false }) {
  const records = new Map(), ledgers = {};
  let inserts = 0, saves = 0, nextId = 0, savesToFail = failSaves;
  const calls = [];
  return {
    alias: "memory-org",
    batchSize,
    calls,
    identity: () => ({ orgId: "00DMEMORY", username: "test@memory", isSandbox: true, isDevHub: false, isOurScratchOrg: false, ...identity }),
    describe: (names) => { calls.push(`describe ${names.join(",")}`); return Object.fromEntries(names.map((n) => [n, describes[n] || null])); },
    objectNames: () => Object.keys(describes),
    insert(object, list) {
      inserts++;
      calls.push(`insert ${object} ${list.length}`);
      if (inserts === failInsert) throw new Error(`insert ${inserts} failed on purpose`);
      return list.map((r) => {
        const id = `${object.slice(0, 3).toUpperCase()}${String(++nextId).padStart(4, "0")}`;
        records.set(id, { object, ...r.fields });
        return { ref: r.ref, id };
      });
    },
    remove(ids) {
      calls.push(`remove ${ids.length}`);
      const failed = ids.filter((id) => refuseDeletes.includes(id)).map((id) => ({ id, message: "DELETE_FAILED on purpose" }));
      for (const id of ids) if (!refuseDeletes.includes(id)) records.delete(id);
      return { failed };
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
    count: (object) => [...records.values()].filter((r) => r.object === object).length,
    ledger: (scope) => (ledgers[scope] ? JSON.parse(ledgers[scope]) : null),
    refuseDeletesOf(ids) { refuseDeletes = ids; },
    stopFailing() { refuseDeletes = []; failInsert = null; },
  };
}
