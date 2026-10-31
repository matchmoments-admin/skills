// The source checks of `pipe` (see the header of pipeline/bin/pipe.mjs): deterministic CI checks on what a change adds,
// with main's rules and exceptions (config/), run with every AI switch off. The rules live in pipeline/src/access.mjs
// (least privilege) and pipeline/src/automation.mjs (one record-automation entry point per object, Apex first).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as access from "../../src/access.mjs";
import * as automation from "../../src/automation.mjs";

export function checkCommands({ io, flag, has, say, log, summary, root }) {
  const exceptions = (f) => { const p = join(root, "config", f); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : []; };
  const report = (name, found, changed) => {
    for (const f of found) log(`::${f.level === "blocker" ? "error" : "warning"} file=${f.file},line=${f.line},title=${name}: ${f.rule}::${f.message}`);
    const blockers = found.filter((f) => f.level === "blocker").length;
    say(`${name} check: ${changed.length} changed file(s), ${blockers} blocker(s), ${found.length - blockers} warning(s)`);
    if (blockers && !has("report-only")) process.exit(1);
  };
  return {
    "access check": () => {
      const { files, read, changed, added } = io.sourceFiles({ base: flag("base"), head: flag("head", "HEAD") });
      const found = access.findings({ changed, added, files, read, exceptions: exceptions("access-exceptions.json") });
      const md = access.toMarkdown(found);
      if (flag("out")) writeFileSync(flag("out"), md + "\n");
      summary(md);
      report("access", found, changed);
    },
    "automation check": () => {   // CLAUDE.md "Record automation": Apex first, one entry point per object
      const { files, read, changed, added } = io.sourceFiles({ base: flag("base"), head: flag("head", "HEAD") });
      report("automation", automation.findings({ changed, added, files, read, exceptions: exceptions("automation-exceptions.json") }), changed);
    },
  };
}
