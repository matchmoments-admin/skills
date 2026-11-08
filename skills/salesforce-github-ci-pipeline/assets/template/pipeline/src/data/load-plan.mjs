// The load plan: which objects a Data request needs, its entries resolved against the org schema, and the order to
// insert them (parents first). Decided once here: the describe loop asks it which objects to describe, the generator
// takes its entries and only makes values. Pure; it never changes the request it is given.
import { didYouMean } from "./request.mjs";
import { requiredParents, referenceTo, NEVER_CREATED } from "./schema.mjs";

export const DEFAULT_PARENTS = 5;

/** The objects to describe for this request, given what is described so far: its own, required parents, "per" parents. */
export function objectsNeeded(schema, request) {
  const needed = new Set(request.objects.map((e) => e.object));
  for (const entry of request.objects) {
    const objectSchema = schema[entry.object];
    if (!objectSchema) continue;
    for (const { object } of requiredParents(objectSchema)) needed.add(object);
    const perParent = entry.perParent && referenceTo(objectSchema, entry.perParent.parent);
    if (perParent) needed.add(perParent.referenceTo[0]);
  }
  for (const name of [...needed]) if (schema[name]) for (const { object } of requiredParents(schema[name])) needed.add(object);
  return [...needed];
}

/**
 * The request against the schema: { entries, order, problems, warnings }. Each entry is
 * { object, count, perParent: { field, object, count } | null, scenario, set }; added parents are entries too, and said
 * in warnings. Problems say what to change in the request, with a "did you mean" where one is close.
 */
export function loadPlan(schema, request) {
  const problems = [], warnings = [];
  const entries = request.objects.map((entry) => resolveEntry(schema, entry, problems)).filter(Boolean);
  if (problems.length) return { entries, order: [], problems, warnings };
  addMissingParents(schema, entries, problems, warnings);
  return { entries, order: insertOrder(schema, entries, problems), problems, warnings };
}

function resolveEntry(schema, entry, problems) {
  const objectSchema = schema[entry.object];
  if (!objectSchema) { problems.push(`"${entry.object}" is not an object in this org${didYouMean(entry.object, Object.keys(schema))}`); return null; }
  if (!objectSchema.createable) { problems.push(`${entry.object} records cannot be created by the API in this org`); return null; }
  checkSetValues(objectSchema, entry, problems);
  checkUnfillableLookups(objectSchema, entry, problems);
  return { object: entry.object, count: entry.count, perParent: resolvePerParent(objectSchema, entry, problems), scenario: entry.scenario, set: entry.set };
}

function checkSetValues(objectSchema, entry, problems) {
  const recordTypes = objectSchema.recordTypes.map((r) => r.developerName);
  for (const field of Object.keys(entry.set)) {
    if (field === "RecordType") {
      if (!recordTypes.includes(entry.set.RecordType)) problems.push(`${entry.object} has no available record type "${entry.set.RecordType}"${didYouMean(entry.set.RecordType, recordTypes)}`);
    } else if (!objectSchema.fields[field]) {
      problems.push(`${entry.object}.${field} is not a field the API can set${didYouMean(field, Object.keys(objectSchema.fields))}`);
    }
  }
}

/** A required lookup test data cannot fill: to people or setup (never created), polymorphic, or to its own object. */
function checkUnfillableLookups(objectSchema, entry, problems) {
  for (const field of Object.values(objectSchema.fields)) {
    if (field.kind !== "reference" || !field.required || field.name in entry.set) continue;
    const [target] = field.referenceTo;
    const why = field.referenceTo.length !== 1 ? "can point at several objects" : NEVER_CREATED.has(target) ? `points at ${target}, which test data never creates` : target === objectSchema.name ? "points at its own object" : null;
    if (why) problems.push(`${entry.object}.${field.name} is a required lookup that ${why}: set it in the request`);
  }
}

function resolvePerParent(objectSchema, entry, problems) {
  if (!entry.perParent) return null;
  const field = referenceTo(objectSchema, entry.perParent.parent);
  if (!field) { problems.push(`${entry.object} has no lookup to ${entry.perParent.parent}, so it cannot be made "per ${entry.perParent.parent}"`); return null; }
  return { field: field.name, object: field.referenceTo[0], count: entry.perParent.count };
}

function addMissingParents(schema, entries, problems, warnings) {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const needed = [...requiredParents(schema[entry.object]).map((p) => p.object), ...(entry.perParent ? [entry.perParent.object] : [])];
    for (const parent of needed.filter((p) => p !== entry.object && !entries.some((e) => e.object === p))) {
      if (!schema[parent]) { problems.push(`${entry.object} needs ${parent} records, but ${parent} was not described (ask objectsNeeded first)`); continue; }
      if (!schema[parent].createable) { problems.push(`${entry.object} needs a ${parent}, and ${parent} records cannot be created by the API in this org`); continue; }
      entries.push({ object: parent, count: DEFAULT_PARENTS, perParent: null, scenario: null, set: {} });
      warnings.push(`added ${DEFAULT_PARENTS} ${parent}: ${entry.object} needs a parent`);
    }
  }
}

/** Objects in an order where every parent comes before its children; a cycle of required references is a problem. */
function insertOrder(schema, entries, problems) {
  const names = [...new Set(entries.map((e) => e.object))];
  const parentsOf = (name) => [...new Set([
    ...requiredParents(schema[name]).map((p) => p.object),
    ...entries.filter((e) => e.object === name && e.perParent).map((e) => e.perParent.object),
  ])].filter((p) => p !== name && names.includes(p));
  const order = [], visiting = new Set();
  const visit = (name, path) => {
    if (order.includes(name)) return;
    if (visiting.has(name)) { problems.push(`${[...path, name].join(" → ")}: these objects require each other, so none can be created first`); return; }
    visiting.add(name);
    for (const parent of parentsOf(name)) visit(parent, [...path, name]);
    visiting.delete(name);
    order.push(name);
  };
  for (const name of names) visit(name, []);
  return order;
}
