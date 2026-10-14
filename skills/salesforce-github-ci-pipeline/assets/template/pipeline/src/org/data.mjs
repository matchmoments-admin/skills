// Test data in an org: the synthetic seed (data/seed) and the staging volume records.
// Part of Org provisioning (pipeline/src/org.mjs): orgRegistry composes these methods with the provisioning core.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineId as idOf } from "../baseline.mjs";
import { DEVHUB } from "./fleet.mjs";
/** The seed's files with their date tokens filled in (data/seed/README.md). Pure: { name: text } -> { name: text }. */
export function expandSeed(files, { today = new Date(), marker }) {
  const y = today.getUTCFullYear();
  const tokens = { TODAY: today.toISOString().slice(0, 10), THIS_YEAR: String(y), LAST_YEAR: String(y - 1), NEXT_YEAR: String(y + 1), SEED_MARKER: marker };
  return Object.fromEntries(Object.entries(files).map(([n, t]) => [n, String(t).replace(/\$\{(TODAY|THIS_YEAR|LAST_YEAR|NEXT_YEAR|SEED_MARKER)\}/g, (_, k) => tokens[k])]));
}

/**
 * Anonymous Apex that removes an earlier version of the seed from a long-lived org (staging, UAT: 30 days) before the
 * new one loads, by the seed's own keys: its accounts by name (their contacts, opportunities and cases with them),
 * its leads by email, and the old markers. Without it a changed seed was inserted beside the old one, two of every
 * account. Records people or specs made on other accounts stay. Pure: seed files, stale marker names -> Apex.
 */
export function seedReplaceApex(files, staleMarkers) {
  const recs = (n) => { try { return JSON.parse(files[n] || "{}").records || []; } catch { return []; } };
  const q = (xs) => xs.map((x) => `'${String(x).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ");
  const names = [...new Set([...recs("Account.json").map((r) => r.Name).filter((n) => n && !n.includes("${")), ...staleMarkers])];
  const emails = [...new Set(recs("Lead.json").map((r) => r.Email).filter(Boolean))];
  return [
    `Set<String> names = new Set<String>{ ${q(names)} };`,
    "List<Account> a = [SELECT Id FROM Account WHERE Name IN :names];",
    "delete [SELECT Id FROM Case WHERE AccountId IN :a];",
    "delete [SELECT Id FROM Opportunity WHERE AccountId IN :a];",
    "delete [SELECT Id FROM Contact WHERE AccountId IN :a];",
    "delete a;",
    ...(emails.length ? [`Set<String> emails = new Set<String>{ ${q(emails)} };`, "delete [SELECT Id FROM Lead WHERE Email IN :emails AND IsConverted = false];"] : []),
  ].join("\n");
}

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
      ...(to === n ? [`insert new Account(Name = '${VOLUME_MARKER(n)}');`] : []),
    ].join("\n"));
  }
  return calls;
}

/** The registry's data methods. ctx: orgRegistry's shared context (sf, log, env, ...). */
export function dataMethods({ sf, sleep, log, keyFile, packages, env, baselineDir, seedDir, record, snapshotRefused, refuseSnapshot, baseline, seedId, active, deleteRecord }) {
  return {
    /**
     * Load the test data once per org: the core seed (data/seed, from main) unless its marker Account is already there
     * (a snapshot holds it), then the story's own (data/seed/stories/<key>/plan.json in the working directory) once.
     * sf data import tree only inserts, so the markers are what make it safe to repeat. Scratch orgs only.
     */
    seed(alias, { story = null } = {}) {
      const loads = [];
      const id = seedId();
      if (id) loads.push({ dir: seedDir, marker: `[seed ${id}]` });
      const own = story ? join(process.cwd(), "data/seed/stories", String(story)) : null;
      if (id && own && existsSync(join(own, "plan.json"))) loads.push({ dir: own, marker: `[seed story ${story} ${idOf(own)}]` });
      if (!loads.length) return [];
      // never production: the Dev Hub is production here (and a production org is never a target of org ready anyway)
      const [target, prod] = [sf(["org", "display", "-o", alias], { allowFail: true })?.id, sf(["org", "display", "-o", DEVHUB], { allowFail: true })?.id];
      if (!target || (prod && String(target).slice(0, 15) === String(prod).slice(0, 15))) throw new Error(`refusing to load test data into ${alias}: it is production (or unknown)`);
      const loaded = [];
      for (const { dir, marker } of loads) {
        const have = sf(["data", "query", "-o", alias, "-q", `SELECT Id FROM Account WHERE Name = '${marker}'`], { allowFail: true })?.records?.length;
        if (have) { log(`${alias} already has ${marker}`); continue; }
        const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
        // an earlier version of the shared seed in this org: replaced, never loaded beside it
        const prefix = dir === seedDir ? "[seed " : null;
        const stale = prefix ? (sf(["data", "query", "-o", alias, "-q", "SELECT Name FROM Account WHERE Name LIKE '[seed %' AND (NOT Name LIKE '[seed story%')"], { allowFail: true })?.records || []).map((r) => r.Name) : [];
        if (stale.length) {
          const apex = join(tmpdir(), `seed-replace-${process.pid}.apex`);
          writeFileSync(apex, seedReplaceApex(files, stale));
          if (sf(["apex", "run", "--file", apex, "-o", alias], { allowFail: true })) log(`${alias}: removed the earlier seed (${stale.join(", ")}) before loading ${marker}`);
          else log(`::warning::${alias}: could not remove the earlier seed (${stale.join(", ")}); loading ${marker} beside it`);
        }
        if (!files["plan.json"].includes("SEED_MARKER") && !Object.values(files).some((t) => t.includes("${SEED_MARKER}"))) {
          // a story's plan without its own marker: add one, so it too loads once
          files["SeedMarker.json"] = JSON.stringify({ records: [{ attributes: { type: "Account", referenceId: "SeedMarker" }, Name: "${SEED_MARKER}" }] });
          files["plan.json"] = JSON.stringify([...JSON.parse(files["plan.json"]), { sobject: "Account", files: ["SeedMarker.json"] }]);
        }
        const out = join(tmpdir(), `seed-${process.pid}-${loaded.length}`);
        mkdirSync(out, { recursive: true });
        for (const [n, t] of Object.entries(expandSeed(files, { marker }))) writeFileSync(join(out, n), t);
        sf(["data", "import", "tree", "--plan", join(out, "plan.json"), "-o", alias]);
        log(`loaded test data ${marker} into ${alias}`);
        loaded.push(marker);
      }
      return loaded;
    },
    /** Load the staging volume once (volumeApex; its marker account says it is there). Best effort: a failure warns. */
    volume(alias, n) {
      if (!n || n < 1) return false;
      if (sf(["data", "query", "-o", alias, "-q", `SELECT Id FROM Account WHERE Name = '${VOLUME_MARKER(n)}'`], { allowFail: true })?.records?.length) return false;
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
}
