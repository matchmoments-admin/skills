// Tree seeds (see GLOSSARY.md: Core seed, Test data (seed)): curated `sf data import tree` plans, the core seed in
// data/seed and a story's own in data/seed/stories/<key>/plan.json. They load through the Org data store and are tracked
// by a Data ledger like a Data request (load.mjs loadTreeSeed): once per org, replaced by id when their files change,
// removable with `pipe data remove`. This module only reads a plan into records. Pure.
import { resolveTokens } from "./generate.mjs";
import { DataRequestError } from "./request.mjs";

/**
 * How test data is tracked in an org, written into the snapshot's description (d<n>) so a snapshot made with an earlier
 * mechanism is rebuilt once: 1 was marker Accounts, 2 is the Data ledger for tree seeds too.
 */
export const TEST_DATA_VERSION = 2;

export const CORE_SEED_SCOPE = "core seed";
export const storySeedScope = (key) => `story ${key} seed`;

/** The marker Accounts the earlier mechanism named a seed by, for the one-time migration (load.mjs loadTreeSeed `legacy`). */
export const LEGACY_CORE_MARKERS = { prefix: "[seed ", except: "[seed story " };
export const legacyStoryMarkers = (key) => ({ prefix: `[seed story ${key} ` });

/**
 * The seed's files with their date tokens filled in (data/seed/README.md): the tokens a Data request's set values take
 * (generate.mjs resolveTokens: ${TODAY}, ${TODAY-30}, ${THIS_YEAR}...). ${SEED_MARKER} becomes `marker` when one is
 * given, else it stays (the record naming it is the retired marker Account: treeSeedRecords leaves it out).
 * Pure: { name: text } -> { name: text }.
 */
export function expandSeed(files, { today = new Date(), marker = null } = {}) {
  return Object.fromEntries(Object.entries(files).map(([n, t]) => {
    const text = resolveTokens(String(t), today);
    return [n, marker === null ? text : text.replace(/\$\{SEED_MARKER\}/g, marker)];
  }));
}

/**
 * A tree plan's records, in plan order, as the load use case takes them: [{ ref, object, fields, parents: { field: ref } }].
 * files: { "plan.json": text, "<file>.json": text } (tokens filled). A value "@Ref" is a reference to the record whose
 * referenceId is Ref, which must come earlier in the plan (the loader turns it into that record's id). The earlier
 * mechanism's marker Account (a record naming ${SEED_MARKER}) is left out. Throws DataRequestError listing every problem.
 */
export function treeSeedRecords(files) {
  const problems = [];
  const plan = parse(files["plan.json"], "plan.json", problems) || [];
  const records = [], defined = new Set();
  for (const entry of Array.isArray(plan) ? plan : []) {
    for (const file of entry.files || []) {
      const doc = files[file] === undefined ? (problems.push(`plan.json names ${file}, which is not there`), null) : parse(files[file], file, problems);
      for (const raw of doc?.records || []) {
        if (JSON.stringify(raw).includes("${SEED_MARKER}")) continue;
        const { attributes = {}, ...values } = raw;
        const ref = attributes.referenceId, object = attributes.type || entry.sobject;
        if (!ref || defined.has(ref)) { problems.push(`${file}: ${ref ? `referenceId ${ref} is used twice` : "a record has no referenceId"}`); continue; }
        const fields = {}, parents = {};
        for (const [field, value] of Object.entries(values)) {
          if (value && typeof value === "object") { problems.push(`${file} ${ref}.${field}: nested records are not supported; give them their own file in the plan`); continue; }
          const target = typeof value === "string" ? value.match(/^@(\S+)$/)?.[1] : null;
          if (!target) { fields[field] = value; continue; }
          if (!defined.has(target)) problems.push(`${file} ${ref}.${field}: @${target} is not a record earlier in the plan`);
          parents[field] = target;
        }
        defined.add(ref);
        records.push({ ref, object, fields, parents });
      }
    }
  }
  if (problems.length) throw new DataRequestError(problems);
  return records;
}

/** The stories folded into a seed (seed-fold names their files story-<key>-<file>): their own seed scopes are superseded by it. */
export function foldedStories(files) {
  return [...new Set(Object.keys(files).map((f) => f.match(/^story-([A-Za-z0-9-]+?)-[^-]+\.json$/)?.[1]).filter(Boolean))].sort();
}

function parse(text, name, problems) {
  try { return JSON.parse(text); } catch (e) { problems.push(`${name} is not valid JSON (${e.message})`); return null; }
}
