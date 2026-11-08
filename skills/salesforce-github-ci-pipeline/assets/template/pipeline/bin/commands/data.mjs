// The test data commands of `pipe` (see the header of pipeline/bin/pipe.mjs): check a Data request without an org, load
// it into any non-production org, say what an org holds, and remove it again. The decisions live in
// pipeline/src/data/load.mjs; the org adapter in pipeline/src/org/data-store.mjs.
import { readFileSync } from "node:fs";
import { parseRequest, describeEntry, DataRequestError } from "../../src/data/request.mjs";

/** "story 512" for data/seed/stories/512/request.json; null for a request anywhere else (then --scope is required). */
export function scopeOf(path) {
  const key = String(path || "").match(/data\/seed\/stories\/([^/]+)\/request\.json$/)?.[1];
  return key ? `story ${key}` : null;
}

const bullets = (lines) => lines.map((l) => `- ${l}`).join("\n");

export function dataCommands({ flag, output, say, orgs }) {
  const required = (name, example) => flag(name) || (() => { throw new Error(`--${name} is required (for example --${name} ${example})`); })();
  const readRequest = () => {
    const file = required("request", "data/seed/stories/512/request.json");
    return { file, request: parseRequest(readFileSync(file, "utf8")) };
  };
  const scopeFor = (file) => flag("scope") || scopeOf(file) || required("scope", '"sandbox demo"');
  /** A request that does not fit says every problem as a list, and the step output carries them too. */
  const explained = (command) => () => {
    try { return command(); } catch (e) {
      if (e instanceof DataRequestError) { output({ ok: false, problems: e.problems.join(" | ") }); throw new Error(`The test data request cannot be loaded:\n${bullets(e.problems)}`); }
      throw e;
    }
  };

  return {
    "data check": explained(() => {   // a request is valid (no org needed): agents run it before pushing
      const { request } = readRequest();
      output({ ok: true, objects: request.objects.length });
      return say(`the request is valid: ${request.objects.map(describeEntry).join("; ")}`);
    }),
    "data seed": explained(() => {   // load a request into any non-production org (scratch org or sandbox), once
      const org = required("org", "issue-512");
      const { file, request } = readRequest();
      const scope = scopeFor(file);
      const result = orgs().loadTestData(org, { request, scope });
      output({ loaded: result.loaded, scope, summary: result.summary, warnings: result.warnings.join(" | ") });
      const warnings = result.warnings.length ? `\nwarnings:\n${bullets(result.warnings)}` : "";
      return say(`${result.loaded ? `loaded ${scope} into ${org}` : `${org} already holds ${scope}`}: ${result.summary}${warnings}`);
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
