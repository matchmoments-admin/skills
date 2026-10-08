// The production baseline (see GLOSSARY.md): a copy of production's customisations in baseline/, refreshed after each
// release (and weekly, and nightly behind BASELINE_NIGHTLY), so every scratch org holds what production holds, not
// only what is in force-app. baseline/ is NOT a package directory: it can never ship to production, and the delta
// deploy, the access check and the production validation never see it. Each component has one owner: anything
// force-app holds is removed from baseline/, so the two never diverge silently.
//
// capture() reads production (list, retrieve, convert); everything else is pure.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export const DIR = "baseline";
const CUSTOM_OBJECT = /__(c|e|mdt|x|b)$/;
// children of an object: on a STANDARD object they count only when a person made them after the org was created
const CHILD_TYPES = ["CustomField", "ValidationRule", "RecordType", "ListView", "WebLink", "CompactLayout", "FieldSet", "BusinessProcess"];

const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
/** Is Type:fullName excluded by config.exclude ("Type", or "Type:Name" with * wildcards)? Pure. */
export const excluded = (type, name, exclude = []) => exclude.some((e) => {
  const [t, n] = e.split(":");
  return t === type && (n === undefined || glob(n).test(name));
});

/**
 * The members to retrieve, per type, from production's listings (`sf org list metadata` per type: fullName,
 * namespacePrefix, manageableState, lastModifiedDate, lastModifiedByName). Managed (namespaced or installed) members
 * are dropped; customisedOnly types keep only what a person changed after the org was created; standard objects come
 * only through their children (custom fields, rules, layouts); exclusions apply. Pure. Returns { Type: [names] }.
 */
export function manifestFor(listings, { config, orgCreated }) {
  const out = {};
  const created = new Date(orgCreated || 0).getTime() + 3600e3;   // the org's own first hour is Salesforce's setup
  for (const [type, items] of Object.entries(listings)) {
    const keep = (items || []).filter((m) => {
      if (m.namespacePrefix || ["installed", "released", "beta", "deleted", "deprecated"].includes(m.manageableState)) return false;
      if (type === "CustomObject" && !CUSTOM_OBJECT.test(m.fullName)) return false;
      if (/^(salesforce|automated process|platform integration)/i.test(m.lastModifiedByName || "")) return false;   // the platform's own (features, Dev Hub objects)
      const onStandard = CHILD_TYPES.includes(type) && !CUSTOM_OBJECT.test(String(m.fullName).split(".")[0]);
      if ((config.customisedOnly || []).includes(type) || onStandard) {
        if (/salesforce/i.test(m.lastModifiedByName || "") || new Date(m.lastModifiedDate || 0).getTime() <= created) return false;
      }
      return !excluded(type, m.fullName, config.exclude);
    }).map((m) => m.fullName);
    if (keep.length) out[type] = [...new Set(keep)].sort();
  }
  return out;
}

/** package.xml for a manifest. Pure. */
export function packageXml(manifest, version = "67.0") {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)).map(([t, ms]) => `  <types>\n${ms.map((m) => `    <members>${esc(m)}</members>`).join("\n")}\n    <name>${t}</name>\n  </types>`),
    `  <version>${version}</version>`, "</Package>", ""].join("\n");
}

/**
 * Make a retrieved file safe and deployable into any scratch org. Pure: (path, xml) -> xml.
 * - dashboards run as the viewing user (production's running user does not exist in a scratch org)
 * - an outbound message's integration user becomes __SCRATCH_ADMIN__ (replaced at deploy with the org's admin)
 * - queues and groups lose their user members (users do not exist; roles and groups stay)
 * - a file holding a secret stops the capture: secrets never enter git
 */
export function sanitize(path, xml) {
  let s = String(xml);
  if (/<(password|consumerSecret|privateKey|clientSecret)>[^<]+</i.test(s)) throw new Error(`${path} holds a secret: exclude it in config/baseline.json`);
  if (/\.dashboard-meta\.xml$/.test(path)) s = s.replace(/\s*<runningUser>[^<]*<\/runningUser>/g, "").replace(/<dashboardType>[^<]*<\/dashboardType>/, "<dashboardType>LoggedInUser</dashboardType>");
  if (/\.workflow-meta\.xml$/.test(path)) s = s.replace(/<integrationUser>[^<]*<\/integrationUser>/g, "<integrationUser>__SCRATCH_ADMIN__</integrationUser>");
  if (/\.(queue|group)-meta\.xml$/.test(path)) s = s.replace(/\s*<queueMembers>[\s\S]*?<\/queueMembers>/g, (m) => m.replace(/\s*<users>[\s\S]*?<\/users>/g, "")).replace(/\s*<users>[^<]*<\/users>/g, "");
  return s;
}

const walk = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);

/** Remove sharing-rule files that hold no rules (production lists one per object, even empty; a scratch org may not
 *  have the object). Returns the removed paths. */
export function dropEmpty(baselineDir) {
  const removed = [];
  for (const f of walk(baselineDir).filter((x) => /\.sharingRules-meta\.xml$/.test(x))) {
    if (!/<sharing(Criteria|Owner|Guest|Territory)Rules[\s>/]/.test(readFileSync(f, "utf8"))) { rmSync(f); removed.push(relative(baselineDir, f)); }
  }
  return removed;
}

/** Remove from a baseline tree every file force-app owns (same path under main/default), then empty folders. */
export function subtractOwned(baselineDir, forceAppDir) {
  const removed = [];
  for (const f of walk(baselineDir)) {
    const rel = relative(baselineDir, f);
    if (existsSync(join(forceAppDir, rel))) { rmSync(f); removed.push(rel); }
  }
  return removed;
}

/** A short id of what baseline/ holds (its files' paths and contents): the readiness marker includes it. */
export function baselineId(dir) {
  const files = walk(dir).sort();
  if (!files.length) return null;
  const h = createHash("sha256");
  for (const f of files) h.update(relative(dir, f)).update("\0").update(readFileSync(f)).update("\0");
  return h.digest("hex").slice(0, 10);
}

/**
 * One deploy of the baseline and the source together (they reference each other both ways, so two deploys fail).
 * A temporary project holds copies of both; __SCRATCH_ADMIN__ becomes the org's admin username. Returns its dir.
 */
export function composeProject({ baselineDir, sourceDir, forceignore = null, apiVersion = "67.0" }) {
  const dir = join(tmpdir(), `composed-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  cpSync(baselineDir, join(dir, DIR), { recursive: true });
  cpSync(sourceDir, join(dir, "force-app"), { recursive: true });
  if (forceignore && existsSync(forceignore)) cpSync(forceignore, join(dir, ".forceignore"));
  writeFileSync(join(dir, "sfdx-project.json"), JSON.stringify({
    packageDirectories: [{ path: DIR }, { path: "force-app", default: true }], sourceApiVersion: apiVersion,
    replacements: [{ glob: `${DIR}/**/*.workflow-meta.xml`, stringToReplace: "__SCRATCH_ADMIN__", replaceWithEnv: "SCRATCH_ADMIN" }],
  }, null, 2));
  return dir;
}

/** What changed in production since the last capture, for the drift PR. changes: `git status --porcelain` lines. Pure. */
export function driftSummary(changes, listings = {}) {
  const who = new Map(Object.values(listings).flat().map((m) => [m.fullName, m]));
  const rows = changes.filter(Boolean).map((l) => {
    const state = l.slice(0, 2).trim();
    const path = l.slice(3);
    const name = path.replace(/^baseline\/main\/default\//, "").replace(/\.[a-zA-Z]+-meta\.xml$/, "");
    const parts = name.split("/"), short = parts.at(-1), obj = parts[0] === "objects" ? parts[1] : null;   // objects/Account/fields/SLA__c -> Account.SLA__c
    const m = who.get(obj && parts.length > 2 ? `${obj}.${short}` : short) || who.get(parts.slice(1).join("/"));
    return `| ${state === "??" || state === "A" ? "added" : state === "D" ? "removed" : "changed"} | \`${name}\` | ${m ? `${m.lastModifiedByName}, ${String(m.lastModifiedDate).slice(0, 10)}` : ""} |`;
  });
  return rows.length ? ["| | component | last changed in production by |", "|---|---|---|", ...rows].join("\n") : "";
}

/**
 * Capture production into baseline/. io: { sf } (the CLI seam, -o devhub is production). config: config/baseline.json.
 * Returns { manifest, listings, removed }. Never deploys anything anywhere.
 */
export function capture({ sf, config, root = process.cwd(), log = () => {} }) {
  const orgCreated = sf(["data", "query", "-o", "devhub", "-q", "SELECT CreatedDate FROM Organization"])?.records?.[0]?.CreatedDate;
  const listings = {};
  for (const type of config.types) {
    const folderType = config.folders?.[type];
    if (folderType) {
      const folders = (sf(["org", "list", "metadata", "-m", folderType, "-o", "devhub"], { allowFail: true }) || []).filter((f) => !f.namespacePrefix);
      listings[type] = [...folders.map((f) => ({ ...f, type })), ...folders.flatMap((f) => sf(["org", "list", "metadata", "-m", type, "--folder", f.fullName, "-o", "devhub"], { allowFail: true }) || [])];
    } else listings[type] = sf(["org", "list", "metadata", "-m", type, "-o", "devhub"], { allowFail: true }) || [];
    log(`${type}: ${listings[type].length} in production`);
  }
  const manifest = manifestFor(listings, { config, orgCreated });
  const work = join(tmpdir(), `baseline-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "package.xml"), packageXml(manifest));
  sf(["project", "retrieve", "start", "--manifest", join(work, "package.xml"), "--target-org", "devhub", "--target-metadata-dir", join(work, "md"), "--unzip", "--wait", "30"]);
  const out = join(root, DIR);
  rmSync(out, { recursive: true, force: true });
  sf(["project", "convert", "mdapi", "--root-dir", join(work, "md", "unpackaged"), "--output-dir", out]);
  const removed = subtractOwned(out, join(root, "force-app"));
  dropEmpty(out);
  for (const f of walk(out).filter((x) => /\.xml$/.test(x))) writeFileSync(f, sanitize(relative(root, f), readFileSync(f, "utf8")));   // binaries untouched
  log(`baseline: ${walk(out).length} files from production, ${removed.length} left to force-app (it owns them)`);
  return { manifest, listings, removed };
}
