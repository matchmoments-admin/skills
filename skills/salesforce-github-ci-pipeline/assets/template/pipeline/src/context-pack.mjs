// The context pack: what already exists for the objects a story touches, and production's sharing model, appended to
// the story file every agent reads (see GLOSSARY.md: Context pack). Agents explore the repo anyway; the pack makes sure
// the facts that cause the worst mistakes are always in front of them (a second trigger on an object, a Flow that
// already does it, a permission set to extend, an org-wide default the change relies on), at a fixed small size
// however large the repo grows. Pure: pack() takes paths, a reader and the sharing model. Production's own customisations
// (the production baseline, baseline/) are listed too, marked: an agent that only saw force-app missed them.
import { DIR as BASELINE } from "./baseline.mjs";
import { isVendored } from "./conventions.mjs";

/** Standard objects worth recognising in a story's words (custom objects come from the repo). */
const STANDARD = ["Account", "Contact", "Lead", "Opportunity", "Case", "Task", "Event", "Campaign", "Contract", "Order",
  "Product2", "Quote", "Asset", "User", "Entitlement", "WorkOrder", "ServiceAppointment", "OpportunityLineItem"];
const UNAMBIGUOUS = ["Account", "Contact", "Opportunity", "Campaign", "Entitlement", "Product2", "OpportunityLineItem", "ServiceAppointment", "WorkOrder"];

const base = (p) => p.split("/").pop();
const objectOf = (p) => (p.match(/\/objects\/([^/]+)\//) || [])[1] || null;
const val = (xml, tag) => (String(xml).match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] ?? null;
const words = (name) => name.replace(/__c$/, "").replace(/_/g, " ").toLowerCase();

/** The objects a story is about: named in its text, or touched by the change. */
export function objectsFor({ text = "", changed = [], files = [] }) {
  const known = new Set([...STANDARD, ...files.map(objectOf).filter(Boolean)]);
  const t = ` ${String(text).toLowerCase().replace(/[^a-z0-9_ ]/g, " ")} `;
  const says = (name) => t.includes(` ${name.toLowerCase()} `) || t.includes(` ${words(name)} `) || t.includes(` ${words(name)}s `);
  // "case", "order", "task", "lead" are also plain English: those standard objects count only when capitalised
  const plainEnglish = (o) => STANDARD.includes(o) && !UNAMBIGUOUS.includes(o);
  const hit = [...known].filter((o) => (plainEnglish(o) ? new RegExp(`\\b${o}s?\\b`).test(text) : says(o)));
  // a field the story names ("Customer Since") brings its object (Account)
  // (not a lookup named after an object: "the Account" is the Account, not every object with an Account__c field)
  const objectWords = new Set([...known].map(words));
  const viaField = files.filter((p) => /\/fields\/[^/]+__c\.field-meta\.xml$/.test(p))
    .filter((p) => { const f = base(p).replace(".field-meta.xml", ""); return !objectWords.has(words(f)) && says(f); }).map(objectOf);
  const touched = changed.map(objectOf).filter(Boolean);
  return [...new Set([...hit, ...viaField, ...touched].filter(Boolean))].sort();
}

const names = (x, tag) => [...String(x).matchAll(new RegExp(`<${tag}>[\\s\\S]*?<fullName>([^<]+)</fullName>`, "g"))].map((m) => m[1]);

/** What a set of source paths holds for object `o`, by kind: names, each with its detail (sharing keyword, Flow trigger...). */
function inventory(paths, read, o) {
  const named = new RegExp(`\\b${o}\\b`);
  const inObj = (dir, ext) => paths.filter((p) => p.includes(`/objects/${o}/${dir}/`) && p.endsWith(ext)).map((p) => ({ p, name: base(p).replace(ext, "") }));
  const classes = paths.filter((p) => p.endsWith(".cls")).map((p) => ({ name: base(p).replace(/\.cls$/, ""), src: read(p) })).filter((c) => named.test(c.src));
  const flows = paths.filter((p) => /\/flows\/[^/]+\.flow-meta\.xml$/.test(p)).map((p) => {
    const x = read(p), start = (x.match(/<start>([\s\S]*?)<\/start>/) || [])[1] || "";
    return { name: base(p).replace(".flow-meta.xml", ""), x, obj: val(start, "object"), when: [val(start, "triggerType"), val(start, "recordTriggerType")].filter(Boolean).join(" "), mode: val(x, "runInMode"), status: val(x, "status") };
  });
  const off = (f) => (f.status && f.status !== "Active" ? `, ${f.status}` : "");
  const file = (re) => paths.filter((p) => re.test(p)).map(read).join("\n");
  return {
    fields: inObj("fields", ".field-meta.xml").map((f) => f.name),
    triggers: paths.filter((p) => p.endsWith(".trigger")).filter((p) => (read(p).match(/\btrigger\s+\w+\s+on\s+(\w+)/i) || [])[1] === o).map((p) => base(p).replace(/\.trigger$/, "")),
    recordFlows: flows.filter((f) => f.obj === o).map((f) => `${f.name} (${f.when}${f.mode ? `, ${f.mode}` : ", runs as system"}${off(f)})`),
    // screen, scheduled and autolaunched Flows (and record-triggered ones on other objects) that read or write it
    otherFlows: flows.filter((f) => f.obj !== o && new RegExp(`<object>${o}</object>`).test(f.x)).map((f) => `${f.name}${off(f)}`),
    validation: inObj("validationRules", ".validationRule-meta.xml").map((v) => `${v.name}${/<active>false<\/active>/.test(read(v.p)) ? " (inactive)" : ""}`),
    workflow: names(file(new RegExp(`/workflows/${o}\\.workflow-meta\\.xml$`)), "rules"),
    sharing: names(file(new RegExp(`/sharingRules/${o}\\.sharingRules-meta\\.xml$`)), "sharing(?:Criteria|Owner)Rules"),
    duplicate: paths.filter((p) => new RegExp(`/duplicateRules/${o}\\.[^/]+\\.duplicateRule-meta\\.xml$`).test(p)).map((p) => base(p).replace(/\.duplicateRule-meta\.xml$/, "").replace(`${o}.`, "")),
    layouts: paths.filter((p) => new RegExp(`/layouts/${o}-[^/]+\\.layout-meta\\.xml$`).test(p)).map((p) => decodeURIComponent(base(p).replace(".layout-meta.xml", "").replace(`${o}-`, ""))),
    apex: classes.filter((c) => !/@istest/i.test(c.src)).map((c) => `${c.name} (${(c.src.match(/\b(with|without|inherited)\s+sharing\b/i) || ["no sharing keyword"])[0]})`),
    tests: classes.filter((c) => /@istest/i.test(c.src)).map((c) => c.name),
    permsets: paths.filter((p) => p.endsWith(".permissionset-meta.xml")).filter((p) => new RegExp(`<object>${o}</object>|<field>${o}\\.`).test(read(p))).map((p) => base(p).replace(".permissionset-meta.xml", "")),
  };
}

const ROWS = [["fields", "Custom fields"], ["triggers", "Triggers"], ["recordFlows", "Record-triggered Flows"], ["otherFlows", "Other Flows that read or write it"],
  ["validation", "Validation rules"], ["workflow", "Workflow rules"], ["sharing", "Sharing rules"], ["duplicate", "Duplicate rules"], ["layouts", "Page layouts"],
  ["apex", "Apex that names it"], ["tests", "Tests that name it"], ["permsets", "Permission sets that grant it"]];
// always shown, even when empty ("none" is a fact the agent needs); the others only when something has them
const ALWAYS = new Set(["fields", "triggers", "recordFlows", "validation", "apex", "tests", "permsets"]);

/**
 * files: every source path (force-app); production: the production baseline's paths (baseline/: what production has that
 * force-app does not); read(path) -> text; objects: from objectsFor(); owd: { Obj: { internal, external } }.
 * Returns markdown, capped per section so a large repo still gives a short pack.
 */
export function pack({ files, production = [], read, objects, owd = {}, branch = "", cap = 8 }) {
  const list = (xs) => (xs.length > cap ? `${xs.slice(0, cap).join(", ")} and ${xs.length - cap} more` : xs.join(", ")) || "none";
  const lines = [`## The codebase today${branch ? ` (\`${branch}\`)` : ""}`, "",
    "Generated by the pipeline from the code you are building on. Reuse and extend these before adding new ones; CLAUDE.md's rules apply (one trigger per object, one record-triggered Flow per object and trigger type where possible).",
    ...(production.length ? ["Names marked **(production)** are production's own (baseline/, built outside this pipeline): every scratch org has them, so they run in your tests. Work with them, never duplicate them; changing one means moving it into force-app first."] : []), ""];
  if (!objects.length) lines.push("The story names no object the pipeline recognises: search force-app/ and baseline/ for what it touches.", "");
  for (const o of objects) {
    const ours = inventory(files, read, o), theirs = inventory(production, read, o);
    const s = owd[o];
    lines.push(`### ${o}`,
      `- Org-wide default in production: ${s ? `internal **${s.internal}**, external **${s.external}**${/ReadWrite|Read/.test(s.internal) ? " (users see records they do not own: a test of access must not rely on this)" : ""}` : "unknown (not logged in to production, or not an object)"}`);
    for (const [k, label] of ROWS) {
      const all = [...ours[k], ...theirs[k].map((n) => `${n} (production)`)];
      if (all.length || ALWAYS.has(k)) lines.push(`- ${label}: ${list(all)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** The SOQL for production's org-wide defaults of these objects (EntityDefinition, read-only). */
export const owdQuery = (objects) =>
  `SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE QualifiedApiName IN (${objects.map((o) => `'${o.replace(/[^A-Za-z0-9_]/g, "")}'`).join(",")})`;

export const owdFrom = (records = []) =>
  Object.fromEntries(records.map((r) => [r.QualifiedApiName, { internal: r.InternalSharingModel, external: r.ExternalSharingModel }]));

/** The pack for a story's text, from this checkout and (when logged in) production's org-wide defaults. */
export function packForCheckout(io, { text, base = null, log = () => {} }) {
  const { files: all, read, changed } = io.sourceFiles({ base });
  const files = all.filter((p) => !isVendored(p));   // a vendored library's classes are not "the codebase" to extend
  const production = io.sourceFiles({ dirs: [BASELINE] }).files;
  const objects = objectsFor({ text, changed, files: [...files, ...production] });
  const owd = objects.length ? owdFrom(io.sf(["data", "query", "-o", "devhub", "-q", owdQuery(objects)], { allowFail: true })?.records) : {};
  log(`context pack: ${objects.join(", ") || "no objects"}; sharing model for ${Object.keys(owd).length}; ${production.length} production files`);
  return pack({ files, production, read, objects, owd, branch: io.git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }) || "" });
}
