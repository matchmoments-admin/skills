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
/** Facts about production the baseline refresh records beside baseline/ (never deployed, not part of its id): the
 *  context pack reads them, so agents' jobs need no production login. */
export const FACTS = "baseline-facts";
export const SHARING_FACTS = `${FACTS}/sharing.json`;
/** Production's org-wide defaults, internal and external, of every customisable object (EntityDefinition), read-only. */
export const SHARING_QUERY = "SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE IsCustomizable = true";
/** EntityDefinition rows -> { Object: { internal, external } }, sorted, objects without a sharing model left out. Pure. */
export const sharingFacts = (records = []) => Object.fromEntries(records.filter((r) => r.InternalSharingModel)
  .map((r) => [r.QualifiedApiName, { internal: r.InternalSharingModel, external: r.ExternalSharingModel ?? "unknown" }])
  .sort(([a], [b]) => a.localeCompare(b)));
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
      // a custom field (or custom child) on a standard object is never the platform's: someone, or the org's template, made
      // it, and production's rules can name it (its Case assignment and escalation rules name Account.SLA__c, 13 Oct)
      const onStandard = CHILD_TYPES.includes(type) && !CUSTOM_OBJECT.test(String(m.fullName).split(".")[0]) && !/__c$/.test(String(m.fullName));
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
 * - approval processes, assignment / auto-response / escalation rules: a production user they name becomes __SCRATCH_ADMIN__
 * - a file holding a secret stops the capture: secrets never enter git
 */
const USER_REFS = /\.(approvalProcess|assignmentRules|autoResponseRules|escalationRules)-meta\.xml$/;
export function sanitize(path, xml) {
  let s = String(xml);
  if (/<(password|consumerSecret|privateKey|clientSecret)>[^<]+</i.test(s)) throw new Error(`${path} holds a secret: exclude it in config/baseline.json`);
  if (/\.dashboard-meta\.xml$/.test(path)) s = s.replace(/\s*<runningUser>[^<]*<\/runningUser>/g, "").replace(/<dashboardType>[^<]*<\/dashboardType>/, "<dashboardType>LoggedInUser</dashboardType>");
  if (/\.workflow-meta\.xml$/.test(path)) s = s.replace(/<integrationUser>[^<]*<\/integrationUser>/g, "<integrationUser>__SCRATCH_ADMIN__</integrationUser>");
  if (USER_REFS.test(path)) {
    s = s.replace(/<approver>\s*<name>[^<]*<\/name>\s*<type>user<\/type>\s*<\/approver>/g, "<approver>\n                <name>__SCRATCH_ADMIN__</name>\n                <type>user</type>\n            </approver>")
      // a user assignee, whatever sits between it and its type (an escalation action has an email template there)
      .replace(/<(ruleEntry|escalationAction)>[\s\S]*?<\/\1>/g, (block) => (/<assignedToType>User<\/assignedToType>/.test(block) ? block.replace(/<assignedTo>[^<]*<\/assignedTo>/g, "<assignedTo>__SCRATCH_ADMIN__</assignedTo>") : block))
      .replace(/<notifyTo>[^<]*<\/notifyTo>/g, "<notifyTo>__SCRATCH_ADMIN__</notifyTo>")
      .replace(/<allowedSubmitters>\s*<submitter>[^<]*<\/submitter>\s*<type>user<\/type>\s*<\/allowedSubmitters>/g, "<allowedSubmitters>\n        <submitter>__SCRATCH_ADMIN__</submitter>\n        <type>user</type>\n    </allowedSubmitters>");
  }
  if (/\.(queue|group)-meta\.xml$/.test(path)) s = s.replace(/\s*<queueMembers>[\s\S]*?<\/queueMembers>/g, (m) => m.replace(/\s*<users>[\s\S]*?<\/users>/g, "")).replace(/\s*<users>[^<]*<\/users>/g, "");
  return s;
}

const walk = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);

/** Remove files that hold nothing: sharing-rule files with no rules (production lists one per object, even empty; a
 *  scratch org may not have the object), and empty shells a retrieve leaves (a standard object's
 *  <CustomObject></CustomObject> once force-app owns its field, story #193; <MatchingRules/>), which showed as
 *  drift (I6, I20). Returns the removed paths. */
export const isEmptyMetadata = (path, xml) => (/\.sharingRules-meta\.xml$/.test(path) ? !/<sharing(Criteria|Owner|Guest|Territory)Rules[\s>/]/.test(xml)
  : /<(CustomObject|MatchingRules)\b[^>]*(\/>|>\s*<\/\1>)\s*$/.test(String(xml).replace(/<\?xml[^>]*\?>/, "").trim()));
export function dropEmpty(baselineDir) {
  const removed = [];
  for (const f of walk(baselineDir).filter((x) => /\.(sharingRules|object|matchingRule)-meta\.xml$/.test(x))) {
    if (isEmptyMetadata(f, readFileSync(f, "utf8"))) { rmSync(f); removed.push(relative(baselineDir, f)); }
  }
  return removed;
}

/**
 * Remove from a baseline tree every component force-app owns, wherever force-app keeps it: main/default or a vendored
 * library's own layout (force-app/vendor/fflib-apex-mocks/main/classes/X.cls owns classes/X.cls). Custom labels come
 * from production as one merged file, so they are subtracted label by label. Returns the removed paths.
 */
export function subtractOwned(baselineDir, forceAppDir) {
  const owned = new Set(), labels = new Set(), removed = [];
  for (const f of walk(forceAppDir)) {
    const parts = relative(forceAppDir, f).split(/[\\/]/);
    for (let i = 0; i < parts.length - 1; i++) owned.add(parts.slice(i).join("/"));   // every suffix: <type folder>/.../<file>
    if (f.endsWith(".labels-meta.xml")) for (const [, n] of readFileSync(f, "utf8").matchAll(/<fullName>([^<]+)<\/fullName>/g)) labels.add(n);
  }
  for (const f of walk(baselineDir)) {
    const rel = relative(baselineDir, f);
    // a labels file is never owned whole: force-app's CustomLabels.labels-meta.xml holds only the story's labels
    const isLabels = f.endsWith(".labels-meta.xml");
    if (!isLabels && owned.has(rel.split(/[\\/]/).join("/").replace(/^main\/default\//, ""))) { rmSync(f); removed.push(rel); continue; }
    if (!isLabels || !labels.size) continue;
    const xml = readFileSync(f, "utf8");
    const kept = xml.replace(/\s*<labels>[\s\S]*?<\/labels>/g, (l) => (labels.has(l.match(/<fullName>([^<]+)/)?.[1]) ? "" : l));
    if (!/<labels>/.test(kept)) { rmSync(f); removed.push(rel); } else if (kept !== xml) writeFileSync(f, kept);
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
    replacements: ["workflow", "approvalProcess", "assignmentRules", "autoResponseRules", "escalationRules"]
      .map((t) => ({ glob: `${DIR}/**/*.${t}-meta.xml`, stringToReplace: "__SCRATCH_ADMIN__", replaceWithEnv: "SCRATCH_ADMIN" })),
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
export function capture({ sf, config, root = process.cwd(), log = () => {}, packages = [] }) {
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
  // the inventory: types the baseline does not copy (config.watch), listed only, so a person sees what production
  // has that scratch orgs do not (report only; add a type to `types`, or to `exclude`)
  const watched = {};
  for (const type of config.watch || []) watched[type] = sf(["org", "list", "metadata", "-m", type, "-o", "devhub"], { allowFail: true }) || [];
  const notCopied = uncovered(watched, { config, orgCreated });
  const missing = missingPackages(sf(["package", "installed", "list", "-o", "devhub"], { allowFail: true }) || [], packages, config.packagesIgnore);
  if (missing.length) notCopied["Managed package (add to config/packages.json)"] = missing;
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
  // production's sharing defaults on standard objects, where a new scratch org's differ
  const org = sf(["data", "query", "-o", "devhub", "-q", `SELECT ${Object.keys(OWD).join(", ")} FROM Organization`])?.records?.[0] || {};
  for (const [p, xml] of Object.entries(sharingFiles(org))) {
    const f = join(out, "main/default", p);
    if (existsSync(join(root, "force-app/main/default", p))) continue;   // force-app owns that object file
    mkdirSync(join(f, ".."), { recursive: true });
    if (!existsSync(f)) writeFileSync(f, xml);
    else writeFileSync(f, readFileSync(f, "utf8").replace(/<sharingModel>[^<]*<\/sharingModel>/, "").replace(/<\/CustomObject>/, `    ${xml.match(/<sharingModel>[^<]*<\/sharingModel>/)[0]}\n</CustomObject>`));
    log(`baseline: production's sharing default for ${p.split("/")[1]} (${xml.match(/<sharingModel>([^<]*)/)[1]})`);
  }
  for (const f of walk(out).filter((x) => /\.xml$/.test(x))) writeFileSync(f, sanitize(relative(root, f), readFileSync(f, "utf8")));   // binaries untouched
  // every object's org-wide defaults (standard objects included, internal and external), for the context pack
  const sharing = sharingFacts(sf(["data", "query", "-o", "devhub", "-q", SHARING_QUERY], { allowFail: true })?.records);
  if (!Object.keys(sharing).length) log("::warning::production's sharing defaults could not be read: baseline-facts/sharing.json is left as it was");
  if (Object.keys(sharing).length) {
    mkdirSync(join(root, FACTS), { recursive: true });
    writeFileSync(join(root, SHARING_FACTS), JSON.stringify(sharing, null, 1) + "\n");
  }
  log(`baseline: ${walk(out).length} files from production, ${removed.length} left to force-app (it owns them)`);
  return { manifest, listings, removed, notCopied };
}

/**
 * What production has, of the watched types the baseline does not copy (config.watch): customised members only (the
 * same filter as the baseline: no managed packages, nothing the platform made, nothing unchanged since the org was
 * created). Pure. { Type: [names] }.
 */
export function uncovered(watched, { config, orgCreated }) {
  const types = Object.keys(watched).filter((t) => !(config.types || []).includes(t));
  return manifestFor(Object.fromEntries(types.map((t) => [t, watched[t]])), { config: { ...config, customisedOnly: [...(config.customisedOnly || []), ...types] }, orgCreated });
}

/**
 * Production's org-wide defaults for standard objects (the Organization record), where they differ from what a new
 * scratch org has (Salesforce's defaults), as object files carrying only the sharing model: the baseline then gives
 * scratch orgs production's sharing, so an access test cannot pass in a scratch org and fail in production. Custom
 * objects carry their own sharing model in their object file already. Pure: Organization fields -> { path: xml }.
 */
const OWD = {   // Organization field -> [object, scratch default, value map]
  DefaultAccountAccess: ["Account", "Edit", { None: "Private", Read: "Read", Edit: "ReadWrite" }],
  DefaultOpportunityAccess: ["Opportunity", "Edit", { None: "Private", Read: "Read", Edit: "ReadWrite" }],
  DefaultLeadAccess: ["Lead", "ReadEditTransfer", { None: "Private", Read: "Read", Edit: "ReadWrite", ReadEditTransfer: "ReadWriteTransfer" }],
  DefaultCaseAccess: ["Case", "ReadEditTransfer", { None: "Private", Read: "Read", Edit: "ReadWrite", ReadEditTransfer: "ReadWriteTransfer" }],
  DefaultContactAccess: ["Contact", "ControlledByParent", { None: "Private", Read: "Read", Edit: "ReadWrite", ControlledByParent: "ControlledByParent" }],
  DefaultCampaignAccess: ["Campaign", "All", { None: "Private", Read: "Read", Edit: "ReadWrite", All: "FullAccess" }],
};
export function sharingFiles(org = {}) {
  const out = {};
  for (const [field, [obj, scratchDefault, map]] of Object.entries(OWD)) {
    const v = org[field];
    if (!v || v === scratchDefault || !map[v]) continue;
    out[`objects/${obj}/${obj}.object-meta.xml`] = `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n    <sharingModel>${map[v]}</sharingModel>\n</CustomObject>\n`;
  }
  return out;
}

/** Production's managed packages that config/packages.json does not install in scratch orgs (ignore: namespaces that
 *  come with every org of production's edition). Pure: installed -> [name (namespace) version id]. */
export function missingPackages(installed = [], listed = [], ignore = ["devedapp"]) {
  const have = new Set(listed.map((p) => p.id));
  return installed.filter((p) => !ignore.includes(p.SubscriberPackageNamespace) && !have.has(p.SubscriberPackageVersionId))
    .map((p) => `${p.SubscriberPackageName} (${p.SubscriberPackageNamespace || "no namespace"}) ${p.SubscriberPackageVersionId}`);
}

/** The inventory section for the drift PR and the run summary. Pure. */
export function inventoryMarkdown(notCopied) {
  const rows = Object.entries(notCopied || {}).filter(([, ms]) => ms.length);
  if (!rows.length) return "**Production has, scratch orgs don't:** nothing of the watched types (`config/baseline.json` watch).";
  return ["### Production has, scratch orgs don't", "",
    "Customised in production, of types the baseline does not copy: a story that depends on one of these is tested without it. Add the type to `types` in `config/baseline.json` (scratch orgs then get it), or to `exclude` with a reason.", "",
    "| type | count | examples |", "|---|---|---|",
    ...rows.map(([t, ms]) => `| ${t} | ${ms.length} | ${ms.slice(0, 5).map((m) => `\`${m}\``).join(", ")}${ms.length > 5 ? ", ..." : ""} |`)].join("\n");
}
