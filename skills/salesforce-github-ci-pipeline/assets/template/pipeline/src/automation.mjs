// The automation check: one entry point per object for record automation, Apex first (CLAUDE.md "Record automation").
// Salesforce's record-triggered automation guide: use one entry point per object and avoid mixing Flow and Apex
// triggers on it (their order is not yours to control, and the logic lives in two places). Deterministic and free, so
// it runs in CI with every AI switch off. Pure: findings() takes the changed paths and a file reader.
//
// A mix that already exists (objects being migrated) is allowed only by config/automation-exceptions.json, which a
// story cannot change (pipeline paths): the migration story's maintenance PR removes its entry.
import { isVendored } from "./conventions.mjs";

/** Words that justify a record-triggered Flow instead of the object's Apex domain, in the Flow's description. */
const REASON = /flow:\s*\S/i;

const isFlow = (p) => /\/flows\/[^/]+\.flow-meta\.xml$/.test(p);
const isTrigger = (p) => /\/triggers\/[^/]+\.trigger$/.test(p);

/** The object an active record-triggered Flow starts on, or null (screen, scheduled, autolaunched, or deactivated:
 *  `Obsolete` or `Draft`, the first step of removing one). Pure. */
export function flowObject(xml) {
  const start = (String(xml).match(/<start>([\s\S]*?)<\/start>/) || [])[1] || "";
  const status = (String(xml).match(/<status>([^<]+)<\/status>/) || [])[1];
  if (!/<triggerType>Record/.test(start) || (status && status !== "Active")) return null;
  return (start.match(/<object>([^<]+)<\/object>/) || [])[1] || null;
}

/** The object an Apex trigger is on, or null. Pure. */
export const triggerObject = (src) => (String(src).match(/\btrigger\s+\w+\s+on\s+(\w+)/i) || [])[1] || null;

/** Each object's entry points in `files`: { [object]: { flows: [name], triggers: [name] } }. */
export function entryPoints(files = [], read) {
  const out = {};
  const at = (o) => (out[o] ||= { flows: [], triggers: [] });
  for (const p of files.filter((x) => !isVendored(x))) {
    const name = p.split("/").pop().replace(/\.(flow-meta\.xml|trigger)$/, "");
    if (isFlow(p)) { const o = flowObject(read(p)); if (o) at(o).flows.push(name); }
    else if (isTrigger(p)) { const o = triggerObject(read(p)); if (o) at(o).triggers.push(name); }
  }
  return out;
}

/** One line per object for the context pack: "Apex (CaseTrigger)", "Flow (A, B)" or "mixed: ... (migrating in #N)". */
export function entryPointLine(ep, exception = null) {
  if (!ep || (!ep.flows.length && !ep.triggers.length)) return "none yet: an Apex trigger and domain (CLAUDE.md, Record automation)";
  if (ep.triggers.length && ep.flows.length) return `mixed: Apex (${ep.triggers.join(", ")}) and record-triggered Flow (${ep.flows.join(", ")})${exception?.story ? `, migrating in #${exception.story}` : ""}: add to the Apex domain, never a new Flow`;
  return ep.triggers.length ? `Apex (${ep.triggers.join(", ")}): add to its domain` : `Flow (${ep.flows.join(", ")}): a new rule moves them into an Apex domain, or says flow: <why>`;
}

/**
 * changed: added or modified source paths; added: the subset that is new; files: every source path at the head;
 * read(path) -> text; exceptions: [{ object, story, why }] from config/automation-exceptions.json.
 * Returns [{ level: "blocker" | "warning", rule, file, line, message }], the access check's shape.
 */
export function findings({ changed: all = [], added = [], files = [], read, exceptions = [] }) {
  const out = [];
  const changed = all.filter((p) => !isVendored(p) && (isFlow(p) || isTrigger(p)));
  const eps = entryPoints(files, read);
  const seen = new Set();
  for (const p of changed) {
    const src = read(p);
    const o = isFlow(p) ? flowObject(src) : triggerObject(src);
    if (!o) continue;
    if (isFlow(p) && added.includes(p) && !REASON.test((src.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "")) {
      out.push({ level: "blocker", rule: "flow-without-reason", file: p, line: 1, message: `A new record-triggered Flow on ${o}. Record automation is Apex first: put the rule in ${o}'s domain class (docs/fflib.md), or say why it must be a Flow in its description: \`flow: <why>\`.` });
    }
    const ep = eps[o];
    if (seen.has(o) || !ep?.flows.length || !ep?.triggers.length) continue;
    seen.add(o);
    const ex = exceptions.find((e) => e.object === o);
    const message = `${o} has an Apex trigger (${ep.triggers.join(", ")}) and record-triggered Flow(s) (${ep.flows.join(", ")}): one entry point per object. Move the Flow's rule into the object's domain class and delete the Flow.`;
    out.push(ex ? { level: "warning", rule: "mixed-entry-point", file: p, line: 1, message: `${message} (allowed while #${ex.story} migrates it: ${ex.why})` }
      : { level: "blocker", rule: "mixed-entry-point", file: p, line: 1, message });
  }
  return out;
}
