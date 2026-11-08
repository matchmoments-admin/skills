// The Data request (see GLOSSARY.md): what a story's tests need in its org, as objects, counts, records per parent and
// named scenarios. Written by Claude from the build plan's "Test data" section, or by a person with /data; kept in git
// at data/seed/stories/<key>/request.json. Pure: parse, validate, hash, and read the /data command.
import { createHash } from "node:crypto";

export const REQUEST_VERSION = 1;
export const MAX_COUNT = 2000;   // records one entry's "count" asks for
export const MAX_RECORDS = 10000;   // records one load makes in all (per parent multiplies): above 2,000 of an object nothing references, the sf adapter uses Bulk API
export const MAX_PER_PARENT = 50;
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A request people or Claude wrote that cannot be loaded: every problem at once, each one saying how to fix it. */
export class DataRequestError extends Error {
  constructor(problems) {
    super(`The test data request cannot be loaded:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

/**
 * A request, validated and normalized: { version, objects: [{ object, count | perParent, scenario, set }] }.
 * Unknown keys are ignored (a newer pipeline may add some); a newer version is refused. Throws DataRequestError.
 */
export function parseRequest(input) {
  const raw = typeof input === "string" ? parseJson(input) : input;
  const problems = [];
  if (!raw || typeof raw !== "object") throw new DataRequestError(["the request is not a JSON object"]);
  const version = raw.version ?? REQUEST_VERSION;
  if (!Number.isInteger(version) || version > REQUEST_VERSION) problems.push(`version ${raw.version} was written by a newer pipeline (this one reads version ${REQUEST_VERSION})`);
  if (!Array.isArray(raw.objects) || raw.objects.length === 0) problems.push('"objects" must list at least one object, e.g. [{ "object": "Account", "count": 10 }]');
  const objects = (Array.isArray(raw.objects) ? raw.objects : []).map((entry, i) => normalizeEntry(entry, `objects[${i}]`, problems));
  if (problems.length) throw new DataRequestError(problems);
  return { version: REQUEST_VERSION, objects };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (e) { throw new DataRequestError([`the request is not valid JSON (${e.message})`]); }
}

function normalizeEntry(entry, where, problems) {
  const object = String(entry?.object || "");
  if (!API_NAME.test(object)) problems.push(`${where}: "object" must be an API name such as Account or Site_Visit__c`);
  const hasCount = entry?.count !== undefined, hasPerParent = entry?.perParent !== undefined;
  if (hasCount === hasPerParent) problems.push(`${where} (${object || "?"}): give either "count" or "perParent", not ${hasCount ? "both" : "neither"}`);
  if (hasCount && !isWhole(entry.count, 1, MAX_COUNT)) problems.push(`${where} (${object}): "count" must be a whole number from 1 to ${MAX_COUNT}`);
  const perParent = hasPerParent ? normalizePerParent(entry.perParent, `${where} (${object})`, problems) : null;
  const set = entry?.set ?? {};
  if (typeof set !== "object" || Array.isArray(set) || Object.entries(set).some(([k, v]) => !API_NAME.test(k) || !["string", "number", "boolean"].includes(typeof v))) {
    problems.push(`${where} (${object}): "set" maps field API names to plain values, e.g. { "Status": "Escalated" }`);
  }
  return { object, count: hasCount ? entry.count : null, perParent, scenario: entry?.scenario ? String(entry.scenario) : null, set };
}

function normalizePerParent(value, where, problems) {
  const pairs = typeof value === "object" && value ? Object.entries(value) : [];
  if (pairs.length !== 1 || !API_NAME.test(pairs[0][0]) || !isWhole(pairs[0][1], 1, MAX_PER_PARENT)) {
    problems.push(`${where}: "perParent" names one parent and how many under each, e.g. { "Account": 2 } (1 to ${MAX_PER_PARENT})`);
    return null;
  }
  return { parent: pairs[0][0], count: pairs[0][1] };
}

const isWhole = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

/** The request's identity: the same content gives the same id, whatever its key order (the idempotency key). */
export function requestId(request) {
  return createHash("sha256").update(canonicalJson(request)).digest("hex").slice(0, 12);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * The /data comment, read as a request. One clause per line or per ";":
 *   <Object> <count> [per <Parent>] [Field=Value ...]      e.g. /data Account 20; Contact 2 per Account; Case 5 Status=Escalated
 * A bare /data returns { request: null } (the /data command then says what to type). Object names are matched without
 * regard to case against `knownObjects` when given; an unknown one comes back as a problem with a "did you mean".
 * Returns { request, understood: [text], problems: [text] }. Nothing is applied when there are problems.
 */
export function parseDataCommand(text, knownObjects = []) {
  const body = String(text || "").replace(/^\s*\/data\b/i, "").trim();
  if (!body) return { request: null, understood: [], problems: [] };
  const problems = [], objects = [];
  for (const clause of body.split(/[;\n]+/).map((c) => c.trim()).filter(Boolean)) {
    const entry = readClause(clause, knownObjects, problems);
    if (entry) objects.push(entry);
  }
  if (problems.length) return { request: null, understood: [], problems: [...problems, DATA_COMMAND_EXAMPLE] };
  const request = parseRequest({ version: REQUEST_VERSION, objects });
  return { request, understood: request.objects.map(describeEntry), problems };
}

export const DATA_COMMAND_EXAMPLE = "For example: /data Account 20; Contact 2 per Account; Case 5 Status=Escalated";

function readClause(clause, knownObjects, problems) {
  const tokens = clause.match(/[A-Za-z0-9_]+="[^"]*"|[A-Za-z0-9_]+='[^']*'|\S+/g) || [];
  const [name, amount, ...rest] = tokens;
  const object = canonicalName(name, knownObjects);
  if (!object) { problems.push(`"${name}" is not an object in this org${suggestion(name, knownObjects)}`); return null; }
  if (!/^\d+$/.test(amount || "")) { problems.push(`"${clause}": say how many after the object, e.g. "${object} 10"`); return null; }
  let perParent = null;
  if (rest[0]?.toLowerCase() === "per") {
    const parent = canonicalName(rest[1], knownObjects);
    if (!parent) { problems.push(`"${clause}": "${rest[1] || ""}" after "per" is not an object in this org${suggestion(rest[1], knownObjects)}`); return null; }
    perParent = { [parent]: Number(amount) };
    rest.splice(0, 2);
  }
  const set = {};
  for (const pair of rest) {
    const m = pair.match(/^([A-Za-z][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(.*))$/);
    if (!m) { problems.push(`"${pair}" in "${clause}": write field values as Field=Value (quote values with spaces)`); return null; }
    set[m[1]] = typedValue(m[2] ?? m[3] ?? m[4]);
  }
  const scenario = Object.keys(set).length ? Object.entries(set).map(([k, v]) => `${k}=${v}`).join(" ") : null;
  return perParent ? { object, perParent, scenario, set } : { object, count: Number(amount), scenario, set };
}

const typedValue = (text) => (/^(true|false)$/i.test(text) ? text.toLowerCase() === "true" : /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text);

function canonicalName(name, knownObjects) {
  if (!name || !API_NAME.test(name)) return null;
  if (!knownObjects.length) return name;
  return knownObjects.find((k) => k.toLowerCase() === name.toLowerCase()) || null;
}

/** A normalized entry in people's words: "20 Account", "2 Contact per Account (Status=Escalated)". */
export function describeEntry(entry) {
  const amount = entry.perParent ? `${entry.perParent.count} ${entry.object} per ${entry.perParent.parent}` : `${entry.count} ${entry.object}`;
  return entry.scenario ? `${amount} (${entry.scenario})` : amount;
}

const suggestion = (name, knownObjects) => didYouMean(name, knownObjects);

/** " (did you mean X or Y?)" for the closest known names, or "" when nothing is close. */
export function didYouMean(name, known) {
  if (!name || !known.length) return "";
  const near = known.map((k) => [k, distance(name.toLowerCase(), k.toLowerCase())]).filter(([, d]) => d <= 3).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([k]) => k);
  return near.length ? ` (did you mean ${near.join(" or ")}?)` : "";
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]++;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/**
 * A request as its file holds it (the input format parseRequest reads): no empty keys, perParent as { Parent: n }.
 * parseRequest(requestFile(r)) gives r back, so a request written by /data loads and keeps its id.
 */
export function requestFile(request) {
  return {
    version: request.version,
    objects: request.objects.map((e) => ({
      object: e.object,
      ...(e.perParent ? { perParent: { [e.perParent.parent]: e.perParent.count } } : { count: e.count }),
      ...(e.scenario ? { scenario: e.scenario } : {}),
      ...(Object.keys(e.set || {}).length ? { set: e.set } : {}),
    })),
  };
}
