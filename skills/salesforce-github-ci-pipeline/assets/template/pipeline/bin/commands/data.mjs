// The test data commands of `pipe` (see the header of pipeline/bin/pipe.mjs): check a Data request without an org, load
// it into any non-production org, apply /data to a story, say what an org holds, and remove it again. The decisions live
// in pipeline/src/data/load.mjs; the org adapter in pipeline/src/org/data-store.mjs.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseRequest, parseDataCommand, describeEntry, DataRequestError } from "../../src/data/request.mjs";
import { removeTestData, testDataStatus } from "../../src/data/load.mjs";

/** "story 512" for data/seed/stories/512/request.json; null for a request anywhere else (then --scope is required). */
export function scopeOf(path) {
  const key = String(path || "").match(/data\/seed\/stories\/([^/]+)\/request\.json$/)?.[1];
  return key ? `story ${key}` : null;
}

const bullets = (lines) => lines.map((l) => `- ${l}`).join("\n");
const STORIES = "data/seed/stories";

/** Every story's request in the checkout, checked offline: [{ file, problems }] (problems empty when it is valid). */
export function checkStoryRequests(root = STORIES) {
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().map((key) => join(root, key, "request.json")).filter((f) => existsSync(f)).map((file) => {
    try { parseRequest(readFileSync(file, "utf8")); return { file, problems: [] }; } catch (e) {
      if (e instanceof DataRequestError) return { file, problems: e.problems };
      throw e;
    }
  });
}

export function dataCommands({ flag, has = () => false, output, say, orgs }) {
  const required = (name, example) => flag(name) || (() => { throw new Error(`--${name} is required (for example --${name} ${example})`); })();
  /** The request: a file (--request), or typed (--data "Account 20; Contact 2 per Account"; read against the org's objects when it loads). */
  const readRequest = () => {
    const typed = flag("data");
    if (typed) {
      const { request, problems } = parseDataCommand(typed);
      if (!request) throw new DataRequestError(problems.length ? problems : ['--data is empty: say what to load, e.g. "Account 20; Contact 2 per Account"']);
      return { file: null, request, typed };
    }
    const file = required("request", "data/seed/stories/512/request.json");
    return { file, request: parseRequest(readFileSync(file, "utf8")), typed: null };
  };
  // a typed request without --scope is the "by hand" set: the next one typed replaces it
  const scopeFor = (file) => flag("scope") || scopeOf(file) || (flag("data") ? "by hand" : required("scope", '"sandbox demo"'));
  /** A request that does not fit says every problem as a list (one "- " line each), and the step output carries them too. */
  const explained = (command) => () => {
    try { return command(); } catch (e) {
      if (e instanceof DataRequestError) { output({ ok: false, problems: e.problems.join(" | ") }); throw new Error(`The test data request cannot be loaded:\n${bullets(e.problems)}`); }
      throw e;
    }
  };

  return {
    "data check": explained(() => {   // a request is valid (no org needed): agents run it before pushing; no --request: every story's (CI)
      if (!flag("request") && !flag("data")) {
        const checked = checkStoryRequests();
        const bad = checked.filter((c) => c.problems.length);
        output({ ok: !bad.length, checked: checked.length });
        if (bad.length) throw new Error(`Story test data that cannot be loaded:\n${bad.map((b) => `${b.file}:\n${bullets(b.problems)}`).join("\n")}`);
        return say(`${checked.length} story test data request(s), all valid`);
      }
      const { request } = readRequest();
      output({ ok: true, objects: request.objects.length });
      return say(`the request is valid: ${request.objects.map(describeEntry).join("; ")}`);
    }),
    "data seed": explained(() => {   // load a request into any non-production org (scratch org or sandbox), once; --no-profile: no production reads
      const org = required("org", "issue-512");
      const { file, request, typed } = readRequest();
      const scope = scopeFor(file);
      const result = orgs().loadTestData(org, { ...(typed ? { typed } : { request }), scope, ...(has("no-profile") ? { profileSource: null } : {}) });
      output({ loaded: result.loaded, scope, summary: result.summary, profiled: result.profiled || "", warnings: result.warnings.join(" | ") });
      const profiled = result.profiled ? `\n${result.profiled}` : "";
      const warnings = result.warnings.length ? `\nwarnings:\n${bullets(result.warnings)}` : "";
      return say(`${result.loaded ? `loaded ${scope} into ${org}` : `${org} already holds ${scope}`}: ${result.summary}${profiled}${warnings}`);
    }),
    // /data on a story (story-data.yml): the typed line read against the story's org, loaded, and written as the story's
    // request.json only if it loaded. Prints the outcome as one JSON object: { outcome: "refused", problems } or
    // { outcome: "loaded", summary, records, fresh, profiled, warnings, changed, file }. Any other error exits 1 (failed).
    "data apply": () => {
      const story = required("story", "512"), org = required("org", "issue-512"), typed = required("data", '"Account 20; Contact 2 per Account"');
      const outcome = orgs().applyTestData(org, { story, typed });
      output({ outcome: outcome.outcome, changed: Boolean(outcome.changed) });
      return say(JSON.stringify(outcome));
    },
    "data status": () => {   // what an org holds for a scope
      const org = required("org", "issue-512"), scope = required("scope", '"story 512"');
      const status = testDataStatus(orgs().dataStore(org), scope);
      output({ scope, ...status });
      return say(status.state === "found" ? `${org} holds ${status.summary} for ${scope}, loaded ${status.loadedAt}` : `${org}: ${status.summary}`);
    },
    "data remove": () => {   // the undo: remove what a scope's ledger tracks (records made by people stay)
      const org = required("org", "issue-512"), scope = required("scope", '"story 512"');
      const result = removeTestData(orgs().dataStore(org), scope);
      output({ scope, removed: result.removed, summary: result.summary });
      return say(`${org}: ${result.summary}`);
    },
  };
}
