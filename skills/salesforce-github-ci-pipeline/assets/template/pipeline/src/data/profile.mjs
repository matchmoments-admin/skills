// The Data profile (see GLOSSARY.md): production's shape as aggregates, never values people typed. It gives each object's
// record count, picklist and record-type mix, how often each field is filled, the average of numbers and date ages
// (years). Any bucket under the floor is suppressed, so a rare value cannot point at a record; MIN and MAX are never
// kept (each is one record's own value). Read on demand: when a request loads, only its objects are profiled, through
// the Profile source port below, and the profile lives in memory for that load only (never saved). The queries and the
// profile built from their rows are pure.
import { schemaOf } from "./schema.mjs";
import { chunk } from "./ledger.mjs";

/**
 * @typedef {object} ProfileSource  Production, read-only, as the profile needs it. Facts only.
 * @property {(names: string[]) => Record<string, object|null>} describe  sobject describes; null for an unknown object
 * @property {(queries: { soql: string }[]) => ({ query: object, records: object[] } | { query: object, error: string })[]} aggregate
 *   runs aggregate queries only; one that fails is an { error } for that query alone
 */

export const PROFILE_VERSION = 1;
export const FLOOR = 5;
export const SUPPRESSED = "suppressed";
const FIELDS_PER_QUERY = 20;

/** An aggregate query: the only kind the profile ever sends to production (every row is a count or an average). */
export const isAggregate = (soql) => /^\s*SELECT\b/i.test(soql) && /\b(COUNT|AVG)\(/i.test(soql);

/**
 * The aggregate SOQL to run in production for these objects: [{ object, kind, fields?, field?, soql }].
 * Free text is never selected: only counts, picklist and boolean groups, the average of numbers and years of dates.
 * Fields describe says cannot be grouped or aggregated are left out; so are `exclude`'s ("Opportunity.Amount").
 */
export function profileQueries(schema, objects, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  return objects.filter((o) => schema[o]).flatMap((name) => objectQueries(schema[name], excluded));
}

function objectQueries(o, excluded) {
  const fields = Object.values(o.fields).filter((f) => !excluded.has(`${o.name}.${f.name}`));
  const countable = fields.filter((f) => !["longtext", "multipicklist", "boolean"].includes(f.kind));   // COUNT(checkbox) is invalid SOQL, and a checkbox is never empty
  const grouped = fields.filter((f) => (f.kind === "picklist" || f.kind === "boolean") && f.groupable !== false && !f.anyValue);   // a combobox holds typed text
  const numbers = fields.filter((f) => f.kind === "number" && f.aggregatable !== false);
  const dates = fields.filter((f) => (f.kind === "date" || f.kind === "datetime") && f.groupable !== false);
  return [
    { object: o.name, kind: "count", soql: `SELECT COUNT(Id) n FROM ${o.name}` },
    ...chunk(countable, FIELDS_PER_QUERY).map((part) => ({ object: o.name, kind: "fill", fields: part.map((f) => f.name), soql: `SELECT ${part.map((f, i) => `COUNT(${f.name}) f${i}`).join(", ")} FROM ${o.name}` })),
    ...grouped.map((f) => ({ object: o.name, kind: "values", field: f.name, soql: `SELECT ${f.name} v, COUNT(Id) n FROM ${o.name} GROUP BY ${f.name}` })),
    ...(o.recordTypes.length ? [{ object: o.name, kind: "recordTypes", soql: `SELECT RecordType.DeveloperName v, COUNT(Id) n FROM ${o.name} GROUP BY RecordType.DeveloperName` }] : []),
    ...chunk(numbers, FIELDS_PER_QUERY).map((part) => ({ object: o.name, kind: "numbers", fields: part.map((f) => f.name), soql: `SELECT ${part.map((f, i) => `AVG(${f.name}) a${i}, COUNT(${f.name}) n${i}`).join(", ")} FROM ${o.name}` })),
    ...dates.map((f) => ({ object: o.name, kind: "dates", field: f.name, soql: `SELECT CALENDAR_YEAR(${f.name}) y, COUNT(Id) n FROM ${o.name} WHERE ${f.name} != null GROUP BY CALENDAR_YEAR(${f.name})` })),
  ];
}

/**
 * Production's profile of these objects, read through a Profile source: describe, the aggregate queries, the profile.
 * Production's describe decides what to query; the target org's describe still decides what a record may hold.
 * Returns { profile, queries } (how many aggregate queries it took). Throws when the source cannot be read at all.
 */
export function profileFor(source, objects, { capturedAt, exclude = [] }) {
  const describes = Object.values(source.describe(objects)).filter(Boolean);
  const queries = profileQueries(schemaOf(describes), objects, { exclude });
  const profile = profileFrom(queries.length ? source.aggregate(queries) : [], { capturedAt });
  return { profile, queries: queries.length };
}

/**
 * The profile from the queries' results ([{ query, records } | { query, error }]), with the floor applied:
 * { version, capturedAt, floor, objects: { [object]: { count, few, partial, fill, values, recordTypes, numbers, dates } } }.
 * A query that failed (a timeout on a very large object) marks its object partial instead of failing the profile.
 */
export function profileFrom(results, { capturedAt }) {
  const objects = {};
  const year = Number(String(capturedAt).slice(0, 4));
  for (const { query, records = [], error } of results) {
    const o = (objects[query.object] ||= { count: 0, few: false, partial: false, fill: {}, values: {}, recordTypes: {}, numbers: {}, dates: {} });
    if (error) { o.partial = true; continue; }
    PROFILE_READERS[query.kind](o, query, records, year);
  }
  for (const o of Object.values(objects)) applyFloor(o);
  return { version: PROFILE_VERSION, capturedAt, floor: FLOOR, objects };
}

const PROFILE_READERS = {
  count: (o, _q, rows) => { o.count = Number(rows[0]?.n ?? 0); },
  fill: (o, q, rows) => { q.fields.forEach((f, i) => { o.fill[f] = Number(rows[0]?.[`f${i}`] ?? 0); }); },
  values: (o, q, rows) => { o.values[q.field] = bucketsOf(rows.map((r) => [String(r.v), r.n])); },
  recordTypes: (o, _q, rows) => { o.recordTypes = bucketsOf(rows.map((r) => [r.v ?? r.RecordType?.DeveloperName ?? "(none)", r.n])); },
  numbers: (o, q, rows) => {
    q.fields.forEach((f, i) => {
      const r = rows[0] || {};
      const filled = Number(r[`n${i}`] ?? 0);
      if (filled >= FLOOR) o.numbers[f] = { avg: round(Number(r[`a${i}`])), filled };
    });
  },
  dates: (o, q, rows, year) => { o.dates[q.field] = bucketsOf(rows.filter((r) => r.y != null).map((r) => [String(year - Number(r.y)), r.n])); },   // years ago; negative: the future (close dates)
};

const bucketsOf = (pairs) => Object.fromEntries(pairs.map(([k, n]) => [k, Number(n)]));
const round = (n) => Math.round(n * 100) / 100;

/** The floor: buckets under FLOOR become "suppressed"; an object under FLOOR records keeps only its count. */
function applyFloor(o) {
  o.fill = Object.fromEntries(Object.entries(o.fill).map(([f, n]) => [f, o.count ? round(n / o.count) : 0]));
  for (const field of Object.keys(o.values)) o.values[field] = floorBuckets(o.values[field]);
  o.recordTypes = floorBuckets(o.recordTypes);
  for (const field of Object.keys(o.dates)) o.dates[field] = floorBuckets(o.dates[field]);
  if (o.count < FLOOR) Object.assign(o, { few: true, fill: {}, values: {}, recordTypes: {}, numbers: {}, dates: {} });
}

const floorBuckets = (buckets) => Object.fromEntries(Object.entries(buckets).map(([k, n]) => [k, n < FLOOR ? SUPPRESSED : n]));

/** The weights a profile gives a field's values (suppressed and unknown values left out), or null when it has none. */
export function weightsOf(buckets, allowed) {
  const pairs = Object.entries(buckets || {}).filter(([v, n]) => n !== SUPPRESSED && (!allowed || allowed.includes(v)));
  return pairs.length ? pairs : null;
}
