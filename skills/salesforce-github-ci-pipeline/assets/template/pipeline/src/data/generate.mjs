// The generator: a load plan's entries turned into synthetic records that fit the target org's schema and, when there is
// a Data profile, production's shape. The org's describe decides what is valid; the profile only weights the choices, so
// a stale profile can never produce an invalid record. Deterministic: the same inputs and seed give the same records.
// Pure. Which objects and in what order is the load plan's job (load-plan.mjs); this module only makes values.
import { DataRequestError, MAX_COUNT } from "./request.mjs";
import { NEVER_CREATED } from "./schema.mjs";
import { weightsOf } from "./profile.mjs";

const MIN_FILL = 0.05;
const DAY = 86_400_000;

/**
 * Records for a load plan (loadPlan, with no problems) in an org with `schema`:
 * { records: [{ ref, object, fields, parents: { field: ref } }], warnings: [text] }.
 * profile: a Data profile or null; rules: config/data-rules.json ({ never: { "Case.Origin": ["Email"] } }).
 * Throws DataRequestError when a required value cannot be made, or the plan makes more than MAX_COUNT records.
 */
export function generateRecords({ schema, plan, profile = null, rules = {}, seed, today = new Date() }) {
  const problems = [];
  const context = { schema, profile, never: rules.never || {}, rng: rngFor(String(seed)), today, refs: {}, counters: {} };
  const records = plan.order.flatMap((name) => plan.entries.filter((e) => e.object === name).flatMap((entry) => recordsFor(entry, context, problems)));
  if (records.length > MAX_COUNT) problems.push(`the request makes ${records.length} records; one load takes up to ${MAX_COUNT}. Ask for fewer, or fewer per parent`);
  if (problems.length) throw new DataRequestError([...new Set(problems)]);
  return { records, warnings: [...plan.warnings, ...profileWarnings(plan.order, profile)] };
}

/** One warning for every object with no production profile (not one line each: a load should not shout). */
function profileWarnings(objects, profile) {
  const without = objects.filter((name) => !profile?.objects?.[name]);
  return without.length ? [`no production profile for ${without.join(", ")}: values are spread evenly and only required fields are filled`] : [];
}

function recordsFor(entry, context, problems) {
  if (!entry.perParent) return Array.from({ length: entry.count }, () => makeRecord(entry, context, {}, problems));
  const parents = context.refs[entry.perParent.object] || [];
  return parents.flatMap((parentRef) => Array.from({ length: entry.perParent.count }, () => makeRecord(entry, context, { [entry.perParent.field]: parentRef }, problems)));
}

function makeRecord(entry, context, fixedParents, problems) {
  const objectSchema = context.schema[entry.object];
  const objectProfile = context.profile?.objects?.[entry.object] || null;
  const n = (context.counters[entry.object] = (context.counters[entry.object] || 0) + 1);
  const record = { ref: `${entry.object.replace(/_/g, "")}${n}`, object: entry.object, fields: setValues(entry, context.today), parents: { ...fixedParents } };
  const valueContext = { ...context, objectSchema, objectProfile, n, scenario: entry.scenario, record };
  for (const field of fieldsInFillOrder(objectSchema)) {
    if (field.name in record.fields || field.name in record.parents) continue;
    if (field.kind === "reference") { pickParent(field, record, valueContext); continue; }
    if (!shouldFill(field, objectSchema, objectProfile, context.rng)) continue;
    const value = valueFor(field, valueContext);
    if (value !== undefined) record.fields[field.name] = value;
    else if (field.required) problems.push(unfillableProblem(entry.object, field, record));
  }
  const recordType = recordTypeFor(entry, objectSchema, objectProfile, context.rng);
  if (recordType) record.fields.RecordTypeId = recordType;
  (context.refs[entry.object] ||= []).push(record.ref);
  return record;
}

/** The scenario's own values first, with date tokens filled: generated values never replace them. */
const setValues = (entry, today) => Object.fromEntries(Object.entries(entry.set).filter(([f]) => f !== "RecordType").map(([f, v]) => [f, resolveTokens(v, today)]));

/** Controlling fields before the dependent picklists that read them. */
const fieldsInFillOrder = (objectSchema) => Object.values(objectSchema.fields).sort((a, b) => Number(Boolean(a.controller)) - Number(Boolean(b.controller)));

function unfillableProblem(object, field, record) {
  if (field.controller) return `${object}.${field.name} is required, and none of its values is valid for ${field.controller} = ${record.fields[field.controller] ?? "(empty)"}: set both in the request`;
  return `${object}.${field.name} is required, but every value it allows is excluded by config/data-rules.json: set it in the request`;
}

/** Required fields and the name field always; other fields only as often as production fills them. */
function shouldFill(field, objectSchema, objectProfile, rng) {
  if (field.required || field.name === objectSchema.nameField) return true;
  if (!objectProfile || field.kind === "longtext" || field.kind === "multipicklist") return false;
  const rate = objectProfile.fill?.[field.name] ?? 0;
  return rate >= MIN_FILL && rng() < rate;
}

/** A parent from the records made so far. Never the record's own object: those have no id until their batch loads. */
function pickParent(field, record, context) {
  const target = field.referenceTo.length === 1 ? field.referenceTo[0] : null;
  if (!target || target === record.object || NEVER_CREATED.has(target)) return;
  const candidates = context.refs[target] || [];
  if (!candidates.length) return;
  if (field.required) { record.parents[field.name] = candidates[(context.n - 1) % candidates.length]; return; }
  const rate = context.objectProfile?.fill?.[field.name] ?? 0;
  if (context.rng() < rate) record.parents[field.name] = candidates[Math.floor(context.rng() * candidates.length)];
}

function recordTypeFor(entry, objectSchema, objectProfile, rng) {
  if (entry.set.RecordType) return objectSchema.recordTypes.find((r) => r.developerName === entry.set.RecordType).id;
  const weights = weightsOf(objectProfile?.recordTypes, objectSchema.recordTypes.map((r) => r.developerName));
  if (!weights) return null;
  const name = weighted(weights, rng);
  return objectSchema.recordTypes.find((r) => r.developerName === name).id;
}

const VALUE_MAKERS = {
  text: (f, c) => (isNameLike(f, c) ? truncate(`${c.objectSchema.label} ${pad(c.n)}${c.scenario ? ` - ${c.scenario}` : ""}`, f.length) : truncate(`${f.label} ${pad(c.n)}`, f.length)),
  longtext: (f) => f.label,
  email: (f, c) => `${c.objectSchema.name.toLowerCase().replace(/_/g, "")}.${c.n}@example.com`,
  phone: (f, c) => `+1 555-01${String(c.n % 100).padStart(2, "0")}`,
  url: (f, c) => `https://example.com/${c.objectSchema.name.toLowerCase()}/${c.n}`,
  picklist: (f, c) => pickValue(f, c),
  multipicklist: (f, c) => allowedValues(f, c)[0],
  boolean: (f, c) => { const w = weightsOf(c.objectProfile?.values?.[f.name], ["true", "false"]); return w ? weighted(w, c.rng) === "true" : false; },
  number: (f, c) => numberFor(f, c),
  date: (f, c) => isoDate(dateFor(f, c)),
  datetime: (f, c) => dateFor(f, c).toISOString(),
};

const valueFor = (field, context) => VALUE_MAKERS[field.kind](field, context);
const isNameLike = (f, c) => f.name === c.objectSchema.nameField || ["LastName", "Subject", "Company"].includes(f.name);
const pad = (n) => String(n).padStart(3, "0");
const truncate = (text, length) => (length ? text.slice(0, length) : text);

/** The values the field may take here: active, not excluded by the rules, and valid for its controlling field's value. */
function allowedValues(field, context) {
  const excluded = context.never[`${context.objectSchema.name}.${field.name}`] || [];
  const allowed = field.values.filter((v) => !excluded.includes(v));
  if (!field.controller) return allowed;
  const controlling = context.record.fields[field.controller];
  if (controlling === undefined) return [];
  return allowed.filter((v) => (field.validFor[v] || []).includes(String(controlling)));
}

function pickValue(field, context) {
  const allowed = allowedValues(field, context);
  if (!allowed.length) return undefined;
  const weights = weightsOf(context.objectProfile?.values?.[field.name], allowed);
  return weights ? weighted(weights, context.rng) : allowed[Math.floor(context.rng() * allowed.length)];
}

/** Around production's average (±50%) when the profile has one, else 1 to 100; never negative. */
function numberFor(field, context) {
  const average = context.objectProfile?.numbers?.[field.name]?.avg;
  const raw = average !== undefined ? Math.max(0, average * (0.5 + context.rng())) : 1 + context.rng() * 99;
  return Number(raw.toFixed(Math.min(field.scale ?? 0, 2)));
}

function dateFor(field, context) {
  const weights = weightsOf(context.objectProfile?.dates?.[field.name]);
  const yearsAgo = weights ? Number(weighted(weights, context.rng)) : 0;
  const days = Math.floor(context.rng() * 365);
  const offset = yearsAgo >= 0 ? -(yearsAgo * 365 + days) : (-yearsAgo - 1) * 365 + days + 1;
  return new Date(context.today.getTime() + offset * DAY);
}

const isoDate = (d) => d.toISOString().slice(0, 10);

/** Date tokens in a value people set: ${TODAY}, ${TODAY-400}, ${TODAY+30}, ${THIS_YEAR}, ${LAST_YEAR}, ${NEXT_YEAR}. */
export function resolveTokens(value, today) {
  if (typeof value !== "string") return value;
  const year = today.getUTCFullYear();
  return value
    .replace(/\$\{TODAY([+-]\d+)?\}/g, (_, offset) => isoDate(new Date(today.getTime() + Number(offset || 0) * DAY)))
    .replace(/\$\{(THIS|LAST|NEXT)_YEAR\}/g, (_, which) => String(year + { THIS: 0, LAST: -1, NEXT: 1 }[which]));
}

function weighted(pairs, rng) {
  const total = pairs.reduce((sum, [, n]) => sum + Number(n), 0);
  let pick = rng() * total;
  for (const [value, n] of pairs) { pick -= Number(n); if (pick < 0) return value; }
  return pairs[pairs.length - 1][0];
}

/** A seeded random number generator (mulberry32 over an FNV-1a hash of the seed): the same seed, the same numbers. */
export function rngFor(seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
