// The test data commands of `pipe` (see the header of pipeline/bin/pipe.mjs): check a Data request without an org, load
// it into any non-production org, say what an org holds, and remove it again. The decisions live in
// pipeline/src/data/load.mjs; the org adapter in pipeline/src/org/data-store.mjs.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRequest, parseDataCommand, describeEntry, requestFile, DataRequestError } from "../../src/data/request.mjs";

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
  /** The request: a file (--request), or typed (--data "Account 20; Contact 2 per Account"), read against the org's objects. */
  const readRequest = (org = null) => {
    const typed = flag("data");
    if (typed) {
      const { request, problems } = parseDataCommand(typed, org ? orgs().dataObjects(org) : []);
      if (!request) throw new DataRequestError(problems.length ? problems : ['--data is empty: say what to load, e.g. "Account 20; Contact 2 per Account"']);
      return { file: null, request };
    }
    const file = required("request", "data/seed/stories/512/request.json");
    return { file, request: parseRequest(readFileSync(file, "utf8")) };
  };
  // a typed request without --scope is the "by hand" set: the next one typed replaces it
  const scopeFor = (file) => flag("scope") || scopeOf(file) || (flag("data") ? "by hand" : required("scope", '"sandbox demo"'));
  /**
   * A request that does not fit says every problem as a list, and the step output carries them too. Contract: each
   * problem is a line starting "- " on stderr; story-data.yml replies with those lines, and fails the run on an error
   * without them (not the request's fault).
   */
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
      const { file, request } = readRequest(org);
      const scope = scopeFor(file);
      const result = orgs().loadTestData(org, { request, scope, ...(has("no-profile") ? { profileSource: null } : {}) });
      output({ loaded: result.loaded, scope, summary: result.summary, profiled: result.profiled || "", warnings: result.warnings.join(" | ") });
      const profiled = result.profiled ? `\n${result.profiled}` : "";
      const warnings = result.warnings.length ? `\nwarnings:\n${bullets(result.warnings)}` : "";
      return say(`${result.loaded ? `loaded ${scope} into ${org}` : `${org} already holds ${scope}`}: ${result.summary}${profiled}${warnings}`);
    }),
    "data request": explained(() => {   // /data on a story: the typed request, read against its org, written as the story's request.json
      const story = required("story", "512"), org = required("org", "issue-512");
      const { request } = readRequest(org);
      const file = join(STORIES, story, "request.json");
      const text = JSON.stringify(requestFile(request), null, 2) + "\n";
      const changed = !existsSync(file) || readFileSync(file, "utf8") !== text;
      mkdirSync(join(STORIES, story), { recursive: true });
      writeFileSync(file, text);
      const summary = request.objects.map(describeEntry).join("; ");
      output({ file, changed, summary });
      return say(`${changed ? "wrote" : "unchanged"} ${file}: ${summary}`);   // story-data.yml reads the summary after the first ": "
    }),
    "data status": () => {   // what an org holds for a scope
      const org = required("org", "issue-512"), scope = required("scope", '"story 512"');
      const status = orgs().dataStatus(org, scope);
      output({ scope, ...status });
      return say(status.state === "found" ? `${org} holds ${status.summary} for ${scope}, loaded ${status.loadedAt}` : `${org}: ${status.summary}`);
    },
    "data remove": () => {   // the undo: remove what a scope's ledger tracks (records made by people stay)
      const org = required("org", "issue-512"), scope = required("scope", '"story 512"');
      const result = orgs().removeTestData(org, scope);
      output({ scope, removed: result.removed, summary: result.summary });
      return say(`${org}: ${result.summary}`);
    },
  };
}
