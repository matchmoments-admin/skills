// Test data in an org: the core seed (data/seed) and stories' tree seeds (plan.json), a story's Data request (generated
// from the org's own schema and production's Data profile, read on demand), each tracked by its own Data ledger, and the
// staging volume records. Part of Org provisioning (pipeline/src/org.mjs): orgRegistry composes these methods with the
// provisioning core. Wiring only: loading is the use case in pipeline/src/data/load.mjs, over the Org data store's sf
// adapter (./data-store.mjs).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { baselineId as idOf } from "../baseline.mjs";
import { PIPELINE_ROOT } from "../io.mjs";
import { parseRequest, requestId, DataRequestError } from "../data/request.mjs";
import { loadTestData, loadTreeSeed, applyDataRequest, refreshTestData, readTypedRequest, guardAgainstProduction } from "../data/load.mjs";
import { CORE_SEED_SCOPE, storySeedScope, LEGACY_CORE_MARKERS, legacyStoryMarkers, foldedStories } from "../data/tree-seed.mjs";
import { sfDataStore, sfProfileSource } from "./data-store.mjs";
import { soqlString } from "../data/soql.mjs";

export { expandSeed } from "../data/tree-seed.mjs";
export { legacySeedApex } from "./data-store.mjs";

/**
 * Volume for the staging regression (setting VOLUME_RECORDS, default 5000; 0 turns it off): that many accounts, each
 * with an opportunity, in chunks one anonymous Apex call can hold (DML rows and CPU), so list views, reports, Flows
 * and SOQL meet production-like numbers before production does. Pure: n, chunk -> [Apex], plus the marker.
 */
export const VOLUME_MARKER = (n) => `[volume ${n}]`;

export function volumeApex(n, chunk = 1000) {
  const calls = [];
  for (let from = 0; from < n; from += chunk) {
    const to = Math.min(n, from + chunk);
    calls.push([
      "List<Account> a = new List<Account>();",
      `for (Integer i = ${from}; i < ${to}; i++) a.add(new Account(Name = 'Volume Account ' + String.valueOf(i).leftPad(6, '0'), Industry = 'Technology', BillingCountryCode = 'AU', NumberOfEmployees = Math.mod(i, 500) + 1));`,
      "insert a;",
      "List<Opportunity> o = new List<Opportunity>();",
      `for (Account x : a) o.add(new Opportunity(Name = x.Name + ' deal', AccountId = x.Id, StageName = 'Prospecting', CloseDate = Date.today().addDays(30), Amount = 10000));`,
      "insert o;",
      ...(to === n ? [`insert new Account(Name = ${soqlString(VOLUME_MARKER(n))});`] : []),
    ].join("\n"));
  }
  return calls;
}

/**
 * Fold shipped stories' seeds into the core seed (seed-fold.yml opens it as a PR). core: { plan, files: { name: text } };
 * stories: [{ key, plan, files }]. Each story file is renamed story-<key>-<file>, its plan entries appended to the core
 * plan, and the reference ids it defines prefixed S<key> once (references to the core's own records stay as they are), so
 * two stories can never collide. A SeedMarker.json the earlier mechanism added to a story is dropped. Pure.
 */
export function foldSeeds(core, stories) {
  const plan = [...core.plan], files = { ...core.files };
  for (const { key, plan: sp, files: sf } of stories) {
    const own = new Set(Object.values(sf).flatMap((t) => [...String(t).matchAll(/"referenceId"\s*:\s*"([^"]+)"/g)].map((m) => m[1])));
    // an id the story already prefixed S<key> keeps it: #475 folded story 444's S444Acc01 as S444S444Acc01
    const rename = (t) => String(t).replace(/("referenceId"\s*:\s*"|"@)([^"]+)"/g, (m, pre, id) => (own.has(id) && !id.startsWith(`S${key}`) ? `${pre}S${key}${id}"` : m));
    for (const entry of sp) {
      const kept = (entry.files || []).filter((f) => f !== "SeedMarker.json" && sf[f] !== undefined);
      if (!kept.length) continue;
      for (const f of kept) files[`story-${key}-${f}`] = rename(sf[f]);
      plan.push({ ...entry, files: kept.map((f) => `story-${key}-${f}`) });
    }
  }
  return { plan, files };
}


const STORIES_DIR = "data/seed/stories";

/**
 * The registry's data methods. ctx: orgRegistry's shared context (sf, log, env, ...); dataRoot: main's trusted checkout.
 * makeStore (alias -> Org data store) and makeProfileSource (() -> Profile source) replace the sf adapters in tests.
 */
export function dataMethods({ sf, log, env = {}, seedDir, record, seedId, active = () => [], dataRoot = PIPELINE_ROOT, makeStore = null, makeProfileSource = null }) {
  const apiVersion = () => { try { return JSON.parse(readFileSync(join(dataRoot, "sfdx-project.json"), "utf8")).sourceApiVersion || "67.0"; } catch { return "67.0"; } };
  const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
  const stores = {};
  // the Org data store for an org: the sf adapter, or the one a test passes (makeStore: alias -> store)
  const storeFor = (alias) => (stores[alias] ||= makeStore ? makeStore(alias) : sfDataStore({ sf, alias, apiVersion: apiVersion(), active }));
  const testDataOn = () => String(env.SEED || "on").toLowerCase() !== "off";
  // production (the Dev Hub) read on demand for the profile, one source per run so each object is read once; DATA_PROFILE=off: never
  let profileSource;
  const productionProfile = () => (String(env.DATA_PROFILE || "on").toLowerCase() === "off" ? null : (profileSource ||= makeProfileSource ? makeProfileSource() : sfProfileSource({ sf, apiVersion: apiVersion() })));
  const loadDefaults = () => ({ profileSource: productionProfile(), rules: readJson(join(dataRoot, "config/data-rules.json")) || {} });

  /** The tree seeds (the core seed, then stories' plan.json) and the stories' Data requests, for this org kind. */
  function seedSources({ story, stories }) {
    if (!testDataOn()) return { seeds: [], requests: [] };
    const id = seedId();
    const root = join(process.cwd(), STORIES_DIR);
    const has = (key, file) => existsSync(join(root, key, file));
    const keys = stories === "all" ? (existsSync(root) ? readdirSync(root).filter((k) => has(k, "plan.json") || has(k, "request.json")).sort() : []) : story ? [String(story)] : [];
    const seeds = id ? [{ key: null, scope: CORE_SEED_SCOPE, id, dir: seedDir, legacy: LEGACY_CORE_MARKERS }] : [];
    for (const k of keys.filter((key) => has(key, "plan.json"))) seeds.push({ key: k, scope: storySeedScope(k), id: idOf(join(root, k)), dir: join(root, k), legacy: legacyStoryMarkers(k) });
    const requests = keys.filter((key) => has(key, "request.json")).map((k) => ({ key: k, scope: `story ${k}`, file: join(root, k, "request.json") }));
    return { seeds, requests };
  }

  /**
   * One tree seed (data/load.mjs loadTreeSeed): loaded once, by its Data ledger; a changed one replaces the earlier
   * records by id; one loaded the earlier way (marker Accounts) is removed once first. The core seed supersedes the
   * seeds of the stories folded into it. Returns "[data <scope> <seed id>]" when it loaded, else null.
   */
  function loadSeed(alias, { key, scope, id, dir, legacy }) {
    const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    const supersedes = key ? [] : foldedStories(files).map(storySeedScope);
    const result = loadTreeSeed(storeFor(alias), { scope, id, files, legacy, supersedes });
    if (result.migrated) log(`${alias}: removed the copy of ${scope} no Data ledger tracked (${result.migrated.join(", ")}); the ledger tracks it from now on`);
    for (const w of result.warnings) log(`::warning::${alias} test data (${scope}): ${w}`);
    log(result.loaded ? `loaded ${scope} into ${alias}: ${result.summary}` : `${alias} already holds ${scope} (${result.summary})`);
    if (result.loaded) record("seed", { action: "seed", org: alias, scope });
    return result.loaded ? `[data ${scope} ${id}]` : null;
  }

  /** One story's request: "[data story <key> <request id>]" when it loaded, else null. */
  function loadStoryRequest(alias, { scope, file }) {
    const request = parseRequest(readFileSync(file, "utf8"));
    return self.loadTestData(alias, { request, scope }).loaded ? `[data ${scope} ${requestId(request)}]` : null;
  }

  /**
   * A story's own test data. In the story's own org data that does not fit fails the build, loudly, where its author
   * looks; in staging and UAT (every story's) it is a warning naming the story, and the other stories still load.
   */
  function storyData(alias, key, load, { isolate }) {
    try { return load(); } catch (e) {
      if (!isolate || !(e instanceof DataRequestError)) throw e;
      log(`::warning::${alias}: story ${key}'s test data was not loaded:\n${e.problems.map((p) => `  - ${p}`).join("\n")}`);
      return null;
    }
  }

  const self = {
    /**
     * Load the test data once per org, each set tracked by its own Data ledger: the core seed (data/seed, from main;
     * scope "core seed"; a snapshot already holds it), then stories' own data (data/seed/stories/<key>/ in the working
     * directory): a story org gets its story's (story), staging and UAT every story's in the release (stories: "all").
     * A story's data is a tree plan (plan.json, scope "story <key> seed") or a Data request (request.json, scope
     * "story <key>"), or both. SEED=off: none. Returns what was loaded: "[data <scope> <id>]" each.
     */
    seed(alias, { story = null, stories = null } = {}) {
      const { seeds, requests } = seedSources({ story, stories });
      if (!seeds.length && !requests.length) return [];
      guardAgainstProduction(storeFor(alias).identity(), alias);
      const isolate = stories === "all";
      const loaded = seeds.map((s) => (s.key ? storyData(alias, s.key, () => loadSeed(alias, s), { isolate }) : loadSeed(alias, s)));
      for (const r of requests) loaded.push(storyData(alias, r.key, () => loadStoryRequest(alias, r), { isolate }));
      return loaded.filter(Boolean);
    },

    /**
     * Load a Data request into any non-production org (data/load.mjs loadTestData), shaped by production's profile, with
     * main's rules: a parsed `request`, or `typed` ("Account 20; Contact 2 per Account", read against the org's objects).
     * Logs its warnings and records the event.
     */
    loadTestData(alias, { request = null, typed = null, scope, ...overrides }) {
      const store = storeFor(alias);
      const result = loadTestData(store, { ...loadDefaults(), ...overrides, request: request || readTypedRequest(store, typed), scope });
      if (result.profiled) log(`${alias} test data (${scope}): ${result.profiled}`);
      for (const w of result.warnings) log(`::warning::${alias} test data (${scope}): ${w}`);
      log(result.loaded ? `loaded test data for ${scope} into ${alias}: ${result.summary}` : `${alias} already holds the test data for ${scope} (${result.summary})`);
      if (result.loaded) record("seed", { action: "data", org: alias, scope });
      return result;
    },

    /**
     * /data on a story (data/load.mjs applyDataRequest): the typed line loaded into the story's org, and only then written
     * as the story's Data request (data/seed/stories/<key>/request.json in the working directory). Returns the outcome.
     */
    applyTestData(alias, { story, typed }) {
      if (!/^[A-Za-z0-9-]+$/.test(String(story))) throw new Error(`not a story key: ${story}`);
      const path = join(STORIES_DIR, String(story), "request.json");
      const storyFile = { path, read: () => (existsSync(path) ? readFileSync(path, "utf8") : null), write: (text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); } };
      return applyDataRequest(storeFor(alias), { typed, scope: `story ${story}`, storyFile, load: (args) => self.loadTestData(alias, args) });
    },

    /**
     * Refresh (data/load.mjs refreshTestData): every Data request set the org holds (or `scope`), loaded again from the
     * request its ledger keeps, shaped like production today. Returns one result per set.
     */
    refreshTestData(alias, { scope = null, ...overrides } = {}) {
      return refreshTestData(storeFor(alias), { scope, load: (args) => self.loadTestData(alias, { ...args, ...overrides }) });
    },

    /** The org's Org data store, for the use cases that need nothing else (data/load.mjs: removeTestData, testDataStatus). */
    dataStore: (alias) => storeFor(alias),

    /** Load the staging volume once (volumeApex; its marker account says it is there). Best effort: a failure warns. */
    volume(alias, n) {
      if (!n || n < 1) return false;
      if (sf(["data", "query", "-o", alias, "-q", `SELECT Id FROM Account WHERE Name = ${soqlString(VOLUME_MARKER(n))}`], { allowFail: true })?.records?.length) return false;
      const t0 = Date.now();
      for (const [i, apex] of volumeApex(n).entries()) {
        const f = join(tmpdir(), `volume-${process.pid}-${i}.apex`);
        writeFileSync(f, apex);
        if (!sf(["apex", "run", "--file", f, "-o", alias], { allowFail: true })) { log(`::warning::volume data stopped at chunk ${i + 1} in ${alias}`); return false; }
      }
      log(`${alias}: ${n} volume accounts and opportunities in ${Math.round((Date.now() - t0) / 1000)} s`);
      record("seed", { action: "volume", org: alias, records: n * 2 });
      return true;
    },
  };
  return self;
}
