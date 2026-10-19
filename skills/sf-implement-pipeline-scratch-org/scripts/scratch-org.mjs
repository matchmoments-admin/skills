#!/usr/bin/env node
// scratch-org: a production-like scratch org per feature branch, from any CI (Buildkite first). Commands:
//   auth                                   JWT login to the Dev Hub as alias DEVHUB_ALIAS (default devhub): SF_DEVHUB_CLIENT_ID,
//                                          SF_DEVHUB_USERNAME, SF_DEVHUB_JWT_KEY_FILE or SF_DEVHUB_JWT_KEY (the PEM), SF_LOGIN_URL
//   ready   --branch B [--commit SHA] [--annotation FILE]
//                                          find or create B's org and make it hold this checkout: packages, baseline/ + the
//                                          source in one deploy, users and permission sets, seed data, the ready marker
//   login   --branch B --email E [--name N] [--admin]
//                                          a user for a person; Salesforce emails them a set-password link (no password or
//                                          session URL is ever printed)
//   changes --branch B [--retrieve]        what people changed in Setup (source tracking); --retrieve pulls it into the source
//   delete  --branch B                     delete B's org (through the Dev Hub: no login to the org needed)
//   sweep   [--open-branches FILE | --from-git] [--dry-run]
//                                          delete orphans: feature orgs whose branch is gone, CI orgs older than 2 hours
//   limits                                 active and daily scratch-org allowances (exit 3 when none is free)
//   baseline capture [--out drift.md]      production's customisations into baseline/ (read-only on production)
//   snapshot refresh [--if-older-than H]   build a snapshot org from the default branch and snapshot it (optional)
// Settings are environment variables (references/settings.md). The engine (scripts/engine/) is derived from
// sf-lifecycle-labs' pipeline: ENGINE.md lists every difference.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orgRegistry, packageList, sameSourceGit, findOrphans, DEVHUB } from "./engine/org.mjs";
import { orgFor } from "./engine/conventions.mjs";
import * as baseline from "./engine/baseline.mjs";
import { CONFIG_ROOT, sf, git, sourceDirs, sfFailure } from "./engine/io.mjs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
// GitHub-style "::warning::" lines from the engine read as plain warnings in any CI log
const log = (m) => console.error(String(m).replace(/^::warning::/, "WARNING: ").replace(/^::error::/, "ERROR: "));
const say = (m) => { if (m) console.log(m); };
const branchOf = () => flag("branch") || process.env.BUILDKITE_BRANCH || process.env.BITBUCKET_BRANCH || process.env.CI_COMMIT_REF_NAME || git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });
const commitOf = () => flag("commit") || process.env.BUILDKITE_COMMIT || git(["rev-parse", "HEAD"], { allowFail: true });
const baselineConfig = () => { const f = join(CONFIG_ROOT, "config/baseline.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { types: [], exclude: [] }; };
const orgs = () => orgRegistry({ sf, log, sameSource: sameSourceGit(git) });
const need = (v, what) => { if (!v) { log(`ERROR: ${what}`); process.exit(2); } return v; };

const commands = {
  auth() {
    const clientId = need(process.env.SF_DEVHUB_CLIENT_ID, "SF_DEVHUB_CLIENT_ID (the connected app's consumer key) is not set");
    const username = need(process.env.SF_DEVHUB_USERNAME, "SF_DEVHUB_USERNAME (the CI user in the Dev Hub) is not set");
    let keyFile = process.env.SF_DEVHUB_JWT_KEY_FILE;
    if (!keyFile) {
      keyFile = join(process.env.TMPDIR || "/tmp", `ci-${process.pid}.key`);
      writeFileSync(keyFile, need(process.env.SF_DEVHUB_JWT_KEY, "SF_DEVHUB_JWT_KEY_FILE or SF_DEVHUB_JWT_KEY (the PEM) is not set"), { mode: 0o600 });
    }
    sf(["org", "login", "jwt", "--client-id", clientId, "--jwt-key-file", keyFile, "--username", username, "--instance-url", process.env.SF_LOGIN_URL || "https://login.salesforce.com", "--alias", DEVHUB]);
    // later commands re-attach to scratch orgs with the same key (JWT; scratch-org admins inherit the Dev Hub's trust)
    say(`logged in to the Dev Hub as ${username} (alias ${DEVHUB}); export SF_CI_KEY_FILE=${keyFile} for later commands in this job`);
  },

  ready() {
    const branch = need(branchOf(), "no branch: pass --branch"), commit = commitOf();
    const target = orgFor(branch);
    need(target, `no org target for branch ${branch}`);
    let o;
    try { o = orgs().ready(branch, { commit }); } catch (e) {
      if (["slots", "licence"].includes(e.kind || sfFailure(e.message))) { log(`ERROR: ${e.message}`); process.exit(3); }   // no room: a soft fail, not a broken branch
      throw e;
    }
    const lines = [`### Scratch org for \`${branch}\``, "",
      `**Org:** \`${o.alias}\` · ${o.created ? "created" : o.completed ? "finished (a previous run stopped half way)" : o.fresh ? "already up to date" : "updated"} · holds \`${String(commit || "").slice(0, 7)}\``,
      `**Production baseline:** ${orgs().baselineId() ? `\`${orgs().baselineId()}\` (BASELINE=${process.env.BASELINE || "soft"})` : "none (no baseline/ in the trusted checkout, or BASELINE=off)"}`,
      `**Source:** ${sourceDirs().join(", ")}`, "",
      "To get in: run the **login** step with your email (Salesforce emails you a link to set a password). No password or session link is ever shown here."];
    if (flag("annotation")) writeFileSync(flag("annotation"), lines.join("\n") + "\n");
    say(o.alias);
  },

  login() {
    const branch = need(branchOf(), "no branch: pass --branch"), email = need(flag("email"), "pass --email (the person's address)");
    if (!/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(email)) { log("ERROR: --email does not look like an address"); process.exit(2); }
    const o = orgs().attach(branch);
    const r = orgs().tester(o.alias, { login: flag("name") || email.split("@")[0], email, admin: has("admin") });
    say(`${r.username}: Salesforce has emailed ${email.replace(/^(.).*(@.*)$/, "$1***$2")} a link to set a password${r.admin ? " (System Administrator)" : ""}`);
  },

  changes() {
    const branch = need(branchOf(), "no branch: pass --branch");
    const o = orgs().attach(branch), reg = orgs();
    const found = reg.setupChanges(o.alias, { exclude: baselineConfig().exclude || [] });
    if (has("retrieve")) reg.retrieveChanges(o.alias, found);
    say(found.map((c) => `${c.type}:${c.name}`).join("\n") || "no Setup changes");
  },

  delete() {
    const branch = need(branchOf(), "no branch: pass --branch");
    say(orgs().remove(branch) ? `deleted ${orgFor(branch).description}` : `no live org for ${branch}`);
  },

  sweep() {
    let open = null;
    if (flag("open-branches")) open = readFileSync(flag("open-branches"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
    else if (has("from-git")) open = (git(["ls-remote", "--heads", "origin"], { allowFail: true }) || "").split("\n").map((l) => l.split("refs/heads/")[1]).filter(Boolean);
    if (open && !open.length) { log("ERROR: the open-branch list is empty: refusing to treat every feature org as an orphan"); process.exit(2); }
    if (has("dry-run")) return say(findOrphans(orgs().activeOrgs(), { openBranches: open }).map((o) => `would delete ${o.description}: ${o.why}`).join("\n") || "no orphans");
    const gone = orgs().sweep({ openBranches: open });
    say(gone.map((o) => `deleted ${o.description}: ${o.why}`).join("\n") || "no orphans");
  },

  limits() {
    const l = orgs().limits();
    say(`active ${l.active.remaining ?? "?"}/${l.active.max ?? "?"} free · daily ${l.daily.remaining ?? "?"}/${l.daily.max ?? "?"} left (resets 00:00 UTC)`);
    if (l.active.remaining === 0 || l.daily.remaining === 0) process.exit(3);
  },

  "baseline capture"() {
    const r = baseline.capture({ sf, config: baselineConfig(), root: process.cwd(), sourceDirs: sourceDirs(), log, packages: packageList() });
    const changes = (git(["status", "--porcelain", "--untracked-files=all", "--", baseline.DIR], { allowFail: true }) || "").split("\n").filter(Boolean);
    writeFileSync(flag("out", "drift.md"), [baseline.driftSummary(changes, r.listings), baseline.inventoryMarkdown(r.notCopied)].filter(Boolean).join("\n\n"));
    say(`${changes.length} baseline file(s) differ from git; the drift summary is in ${flag("out", "drift.md")}`);
  },

  "snapshot refresh"() {
    const reg = orgs(), age = reg.snapshotAgeHours();
    if (flag("if-older-than") && age !== null && age < Number(flag("if-older-than"))) return say(`snapshot is ${age.toFixed(1)} h old: not rebuilt`);
    const commit = commitOf();
    const o = reg.ready("snapshot", { commit });
    const name = `LCB${new Date().toISOString().replace(/\D/g, "").slice(2, 12)}`;
    const r = reg.snapshot(o.alias, { name, description: `${String(commit || "").slice(0, 7)}${reg.baselineId() ? ` b${reg.baselineId()}` : ""}`, waitMinutes: Number(flag("minutes", "60")) });
    if (r.active) reg.remove("snapshot");
    say(r.active ? `snapshot ${name} is active: new orgs start from it` : `snapshot ${name} is ${r.status || "not active yet"}: new orgs keep the previous one until it is`);
  },
};

const name = commands[`${argv[0]} ${argv[1]}`] ? `${argv[0]} ${argv[1]}` : argv[0];
if (!commands[name]) { console.error(readFileSync(new URL(import.meta.url), "utf8").split("\nimport ")[0].split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); process.exit(name ? 2 : 0); }
try { commands[name](); } catch (e) { log(`ERROR: ${e.message}`); process.exit(1); }
