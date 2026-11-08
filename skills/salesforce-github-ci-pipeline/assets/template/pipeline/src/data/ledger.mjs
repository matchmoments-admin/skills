// The Data ledger (see GLOSSARY.md): which records a Data request loaded into an org, by id. It lives in the org itself
// (a ContentVersion titled "[data ledger <scope>]"), so any org knows what it holds without a marker or a name. Its rules,
// all here:
//   - the same request, fully loaded: nothing to do; a changed one: remove the earlier records by id, then load;
//   - a ledger that exists but cannot be read is a refusal, never "none" (that would load a second, untracked set);
//   - ids whose delete failed are carried into the next ledger, so they are retried and never lost;
//   - deletes go children before parents, in the load plan's order.
// Pure; the use case (load.mjs) saves it after every batch through the Org data store.

export const LEDGER_VERSION = 1;

export const ledgerTitle = (scope) => `[data ledger ${scope}]`;

/**
 * What to do, from what the store found ({ state: "none" | "unreadable" | "found", ledger, detail }) and the request id:
 * { action: "skip", ledger } | { action: "refuse", reason } | { action: "load", previous: ledger | null }.
 */
export function decide(found, requestId) {
  if (found.state === "unreadable") return { action: "refuse", reason: unreadableReason(found) };
  if (found.state === "none") return { action: "load", previous: null };
  if (found.ledger.complete && found.ledger.requestId === requestId && !Object.keys(found.ledger.leftovers || {}).length) return { action: "skip", ledger: found.ledger };
  return { action: "load", previous: found.ledger };
}

function unreadableReason({ scope, detail }) {
  return `the org has a ${ledgerTitle(scope)} file that cannot be read (${detail || "no detail"}), so the records it lists cannot be removed. ` +
    "Nothing was loaded or deleted. Fix: delete that file in the org (Files) along with the test records it lists, or recreate the org, then load again.";
}

/** A ledger for a load that is starting: records ids per object, parents first (`order`); `leftovers` failed to delete before. */
export function begin({ scope, requestId, loadedAt, order = [], leftovers = {} }) {
  return { version: LEDGER_VERSION, scope, requestId, loadedAt, complete: false, order, records: {}, leftovers };
}

/** The ledger with these ids loaded under their object. */
export function record(ledger, object, ids) {
  return { ...ledger, records: { ...ledger.records, [object]: [...(ledger.records[object] || []), ...ids] } };
}

export const finish = (ledger) => ({ ...ledger, complete: true });

/**
 * The deletes that remove everything a ledger tracks (its records and leftovers), children before parents, at most
 * `size` ids each: [{ object, ids }]. Objects the order does not know go first: they cannot be anyone's parent here.
 */
export function deletions(ledger, size = 200) {
  const ids = merge(ledger.records, ledger.leftovers || {});
  const rank = (object) => { const i = (ledger.order || []).indexOf(object); return i < 0 ? Infinity : i; };
  return Object.keys(ids).sort((a, b) => rank(b) - rank(a)).flatMap((object) => chunk(ids[object], size).map((part) => ({ object, ids: part })));
}

/** The ids that failed to delete, grouped by object, from [{ object, ids: failed }]: the next ledger's leftovers. */
export function leftoversOf(failures) {
  return failures.filter((f) => f.ids.length).reduce((acc, f) => merge(acc, { [f.object]: f.ids }), {});
}

export const encodeLedger = (ledger) => JSON.stringify(ledger);

/** A ledger read back from an org (text or already-parsed JSON), or null when it is not one. */
export function decodeLedger(content) {
  try {
    const ledger = typeof content === "string" ? JSON.parse(content) : content;
    return ledger && typeof ledger.records === "object" && ledger.records !== null ? { complete: false, leftovers: {}, order: [], ...ledger } : null;
  } catch { return null; }
}

/** What a ledger holds in people's words: "45 records (Account 20, Contact 25)", plus leftovers and an unfinished load. */
export function summary(ledger) {
  const counts = Object.entries(ledger?.records || {}).map(([object, ids]) => [object, ids.length]);
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  const leftover = Object.values(ledger?.leftovers || {}).reduce((sum, ids) => sum + ids.length, 0);
  return [
    `${total} records${counts.length ? ` (${counts.map(([o, n]) => `${o} ${n}`).join(", ")})` : ""}`,
    ...(leftover ? [`${leftover} earlier records could not be deleted yet`] : []),
    ...(ledger && !ledger.complete ? ["the load did not finish"] : []),
  ].join("; ");
}

function merge(a, b) {
  const out = { ...a };
  for (const [object, ids] of Object.entries(b)) out[object] = [...new Set([...(out[object] || []), ...ids])];
  return out;
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
