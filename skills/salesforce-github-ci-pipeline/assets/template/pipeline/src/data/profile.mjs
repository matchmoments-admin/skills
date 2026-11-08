// The Data profile (see GLOSSARY.md): production's shape as aggregates, never values people typed. It gives each object's
// record count, picklist and record-type mix, how often each field is filled, the average of numbers, date ages (years)
// and children per parent (percentiles). Any bucket under the floor is suppressed, so a rare value cannot point at a
// record; MIN and MAX are never kept (each is one record's own value). Pure: the queries to run, and the profile built
// from their rows. Captured from production by a later phase (prod-baseline.yml, as the read-only user, into
// baseline-facts/data-profile.json); until then there is no profile, and loads say so.

export const PROFILE_VERSION = 1;
export const FLOOR = 5;
export const SUPPRESSED = "suppressed";
const CHUNK = 20;

/**
 * The aggregate SOQL to run in production for these objects: [{ object, kind, fields?, field?, soql }].
 * Free text is never selected: only counts, picklist and boolean groups, the average of numbers, years of dates, and
 * grouped child counts (whose parent ids are read and discarded: only percentiles are kept).
 */
export function profileQueries(schema, objects) {
  const profiled = new Set(objects);
  return objects.filter((o) => schema[o]).flatMap((name) => objectQueries(schema[name], profiled));
}

function objectQueries(o, profiled) {
  const fields = Object.values(o.fields);
  const countable = fields.filter((f) => !["longtext", "multipicklist"].includes(f.kind));
  const grouped = fields.filter((f) => f.kind === "picklist" || f.kind === "boolean");
  const numbers = fields.filter((f) => f.kind === "number");
  const dates = fields.filter((f) => f.kind === "date" || f.kind === "datetime");
  const parents = fields.filter((f) => f.kind === "reference" && f.referenceTo.length === 1 && profiled.has(f.referenceTo[0]));
  return [
    { object: o.name, kind: "count", soql: `SELECT COUNT(Id) n FROM ${o.name}` },
    ...chunks(countable).map((part) => ({ object: o.name, kind: "fill", fields: part.map((f) => f.name), soql: `SELECT ${part.map((f, i) => `COUNT(${f.name}) f${i}`).join(", ")} FROM ${o.name}` })),
    ...grouped.map((f) => ({ object: o.name, kind: "values", field: f.name, soql: `SELECT ${f.name} v, COUNT(Id) n FROM ${o.name} GROUP BY ${f.name}` })),
    ...(o.recordTypes.length ? [{ object: o.name, kind: "recordTypes", soql: `SELECT RecordType.DeveloperName v, COUNT(Id) n FROM ${o.name} GROUP BY RecordType.DeveloperName` }] : []),
    ...chunks(numbers).map((part) => ({ object: o.name, kind: "numbers", fields: part.map((f) => f.name), soql: `SELECT ${part.map((f, i) => `AVG(${f.name}) a${i}, COUNT(${f.name}) n${i}`).join(", ")} FROM ${o.name}` })),
    ...dates.map((f) => ({ object: o.name, kind: "dates", field: f.name, soql: `SELECT CALENDAR_YEAR(${f.name}) y, COUNT(Id) n FROM ${o.name} WHERE ${f.name} != null GROUP BY CALENDAR_YEAR(${f.name})` })),
    ...parents.map((f) => ({ object: o.name, kind: "perParent", field: f.name, soql: `SELECT ${f.name} p, COUNT(Id) n FROM ${o.name} WHERE ${f.name} != null GROUP BY ${f.name} LIMIT 2000` })),
  ];
}

function chunks(list) {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

/**
 * The profile from the queries' results ([{ query, records } | { query, error }]), with the floor applied:
 * { version, capturedAt, floor, objects: { [object]: { count, few, partial, fill, values, recordTypes, numbers, dates, perParent } } }.
 * A query that failed (a timeout on a very large object) marks its object partial instead of failing the profile.
 */
export function profileFrom(results, { capturedAt }) {
  const objects = {};
  const year = Number(String(capturedAt).slice(0, 4));
  for (const { query, records = [], error } of results) {
    const o = (objects[query.object] ||= { count: 0, few: false, partial: false, fill: {}, values: {}, recordTypes: {}, numbers: {}, dates: {}, perParent: {} });
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
  perParent: (o, q, rows) => { o.perParent[q.field] = percentiles(rows.map((r) => Number(r.n))); },
};

const bucketsOf = (pairs) => Object.fromEntries(pairs.map(([k, n]) => [k, Number(n)]));
const round = (n) => Math.round(n * 100) / 100;

function percentiles(counts) {
  if (counts.length < FLOOR) return null;
  const sorted = [...counts].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { p50: at(0.5), p90: at(0.9) };
}

/** The floor: buckets under FLOOR become "suppressed"; an object under FLOOR records keeps only its count. */
function applyFloor(o) {
  o.fill = Object.fromEntries(Object.entries(o.fill).map(([f, n]) => [f, o.count ? round(n / o.count) : 0]));
  for (const field of Object.keys(o.values)) o.values[field] = floorBuckets(o.values[field]);
  o.recordTypes = floorBuckets(o.recordTypes);
  for (const field of Object.keys(o.dates)) o.dates[field] = floorBuckets(o.dates[field]);
  o.perParent = Object.fromEntries(Object.entries(o.perParent).filter(([, p]) => p));
  if (o.count < FLOOR) Object.assign(o, { few: true, fill: {}, values: {}, recordTypes: {}, numbers: {}, dates: {}, perParent: {} });
}

const floorBuckets = (buckets) => Object.fromEntries(Object.entries(buckets).map(([k, n]) => [k, n < FLOOR ? SUPPRESSED : n]));

/** The weights a profile gives a field's values (suppressed and unknown values left out), or null when it has none. */
export function weightsOf(buckets, allowed) {
  const pairs = Object.entries(buckets || {}).filter(([v, n]) => n !== SUPPRESSED && (!allowed || allowed.includes(v)));
  return pairs.length ? pairs : null;
}
