// The access check: does a change keep Salesforce access least-privilege? (see CONTEXT.md: Access check)
// Deterministic and free, so it runs in CI with every AI switch off; the build plan, the builder and the review
// follow the same rules (CLAUDE.md "Access"). Pure: findings() takes the changed paths and a file reader.
//
// Blockers fail CI. Warnings are annotations the reviewer (person or AI) reads. A blocker that is really needed
// (an integration user's permission set, say) is allowed only by an entry in config/access-exceptions.json, which a
// story cannot change (pipeline paths), so every exception is a reviewed pipeline-maintenance change.

/** User permissions that make a user an administrator in all but name. */
export const ADMIN_PERMISSIONS = ["ModifyAllData", "ViewAllData", "ManageUsers", "AuthorApex", "CustomizeApplication",
  "ManageProfilesPermissionsets", "ManageSharing", "ManageRoles", "ManageInternalUsers", "ViewAllUsers"];

/** Words that justify running without sharing, on the comment above a class or in a Flow's description. */
const JUSTIFIED = /sharing:\s*\S/i;

const isClass = (p) => /\.cls$/.test(p);
const isTestSource = (src) => /@istest/i.test(src.split(/\bclass\b/i)[0] || "");
const blocks = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
const val = (xml, tag) => (String(xml).match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] ?? null;
const lineOf = (src, re) => { const i = String(src).split("\n").findIndex((l) => re.test(l)); return i < 0 ? 1 : i + 1; };
const objectOf = (p) => (p.match(/\/objects\/([^/]+)\//) || [])[1] || null;
const fieldOf = (p) => (p.match(/\/fields\/([^/]+)\.field-meta\.xml$/) || [])[1] || null;

/**
 * changed: added or modified source paths; added: the subset that is new; files: every source path; read(path) -> text;
 * exceptions: [{ file, rule, why }] from config/access-exceptions.json.
 * Returns [{ level: "blocker" | "warning", rule, file, line, message }].
 */
export function findings({ changed = [], added = [], files = [], read, exceptions = [] }) {
  const out = [];
  const say = (level, rule, file, line, message) => {
    const ex = exceptions.find((e) => e.file === file && e.rule === rule);
    out.push({ level: ex ? "warning" : level, rule, file, line, message: ex ? `${message} (allowed: ${ex.why})` : message });
  };
  const permsets = files.filter((p) => p.endsWith(".permissionset-meta.xml")).map((p) => read(p));
  const granted = (re) => permsets.some((x) => re.test(x));

  for (const p of changed) {
    const src = read(p);
    if (p.endsWith(".profile-meta.xml")) {
      say("blocker", "profile", p, 1, "Profiles grant access to everyone who has them and cannot be reviewed piece by piece. Grant it with a permission set instead.");
    }

    if (p.endsWith(".permissionset-meta.xml") || p.endsWith(".permissionsetgroup-meta.xml")) {
      for (const b of blocks(src, "userPermissions")) {
        const name = val(b, "name");
        if (val(b, "enabled") === "true" && ADMIN_PERMISSIONS.includes(name)) {
          say("blocker", "admin-permission", p, lineOf(src, new RegExp(`<name>${name}</name>`)), `Grants ${name}, an administrator permission. Grant the specific object and field access the story needs.`);
        }
      }
      for (const b of blocks(src, "objectPermissions")) {
        for (const wide of ["viewAllRecords", "modifyAllRecords", "viewAllFields"]) {
          if (val(b, wide) === "true") say("blocker", "view-all", p, lineOf(src, new RegExp(`<${wide}>true`)), `Grants ${wide} on ${val(b, "object")}, which ignores the sharing model. Share the records the user needs (sharing rules, teams) instead.`);
        }
      }
    }

    if (isClass(p) && !isTestSource(src) && !/\b(interface|enum)\s+\w+/i.test(src.split("{")[0])) {
      const decl = src.match(/^[^\n]*\bclass\s+\w+/m)?.[0] || "";
      const line = lineOf(src, /\bclass\s+\w+/);
      const sharing = (decl.match(/\b(with|without|inherited)\s+sharing\b/i) || [])[1]?.toLowerCase();
      if (!sharing) say("blocker", "sharing-keyword", p, line, "Declare the class `with sharing` (or `inherited sharing` for a utility called from both). Without a keyword it runs in system mode for some callers.");
      if (sharing === "without") {
        const above = src.split("\n").slice(Math.max(0, line - 4), line).join("\n");
        if (!JUSTIFIED.test(above)) say("blocker", "without-sharing", p, line, "`without sharing` ignores the sharing model. Add a `// sharing: <why>` comment above the class saying why the user may see records they cannot open.");
      }
      if (/@AuraEnabled/i.test(src) && /\[\s*SELECT\b/i.test(src) && !/WITH\s+(USER_MODE|SECURITY_ENFORCED)|stripInaccessible|AccessLevel\.USER_MODE/i.test(src)) {
        say("warning", "user-mode", p, lineOf(src, /\[\s*SELECT\b/i), "A query behind @AuraEnabled runs for a user: add `WITH USER_MODE` so object and field access are enforced.");
      }
      const name = p.split("/").pop().replace(/\.cls$/, "");
      const tests = files.filter(isClass).map((t) => read(t)).filter((t) => /@istest/i.test(t) && new RegExp(`\\b${name}\\b`).test(t));
      if (tests.length && !tests.some((t) => /System\.runAs\s*\(/.test(t))) {
        say("warning", "permission-test", p, line, `No test runs ${name} as a limited user (System.runAs). Add the permission case: a user without the access is refused.`);
      }
    }

    if (p.endsWith(".flow-meta.xml") && val(src, "runInMode") === "SystemModeWithoutSharing" && !JUSTIFIED.test(val(src, "description") || "")) {
      say("blocker", "flow-without-sharing", p, lineOf(src, /<runInMode>/), "The Flow runs without sharing. Use the default (or SystemModeWithSharing), or say why in its description: `sharing: <why>`.");
    }
  }

  for (const p of added) {
    const obj = objectOf(p);
    if (obj && /__c$/.test(obj) && p.endsWith(`/${obj}.object-meta.xml`)) {
      const src = read(p);
      const internal = val(src, "sharingModel"), external = val(src, "externalSharingModel");
      if (internal !== "Private" && internal !== "ControlledByParent") {
        say("warning", "object-owd", p, lineOf(src, /<sharingModel>/), `New object ${obj} has org-wide default ${internal || "unset"}. Start Private and open access with sharing rules; if it must be public, say why in the plan.`);
      }
      if (external && external !== "Private" && external !== "ControlledByParent") say("warning", "object-owd", p, lineOf(src, /<externalSharingModel>/), `New object ${obj} is ${external} to external users (portals, communities).`);
      if (!granted(new RegExp(`<object>${obj}</object>`))) say("blocker", "object-permission", p, 1, `No permission set grants ${obj}: nobody but an admin could use it. Add objectPermissions to the story's permission set.`);
    }
    const field = fieldOf(p);
    if (obj && field && /__c$/.test(field)) {
      const src = read(p);
      const exempt = val(src, "required") === "true" || val(src, "type") === "MasterDetail";
      if (!exempt && !granted(new RegExp(`<field>${obj}\\.${field}</field>`))) {
        say("blocker", "field-permission", p, 1, `No permission set grants ${obj}.${field}: a deploy grants no field access, so nobody would see it. Add fieldPermissions to the story's permission set.`);
      }
    }
  }
  return out;
}

/** Findings as a markdown table (the step summary, and the file the review agent reads). */
export function toMarkdown(list) {
  if (!list.length) return "### Access check\n\nNo access findings: least privilege kept.";
  const esc = (s) => String(s).replace(/\|/g, "\\|");
  return ["### Access check", "", "| | rule | where | what to do |", "|---|---|---|---|",
    ...list.map((f) => `| ${f.level === "blocker" ? "❌" : "⚠"} | ${f.rule} | \`${f.file}:${f.line}\` | ${esc(f.message)} |`)].join("\n");
}
