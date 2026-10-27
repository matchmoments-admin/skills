// The reviewer eval command of `pipe` (see the header of pipeline/bin/pipe.mjs): score the reviews review-eval.yml
// collected, record the score as an `eval` event (the weekly metrics compare models on it), and print the summary.
// The scoring lives in pipeline/src/review-eval.mjs.
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadCases, scoreCase, summarize, toMarkdown } from "../../src/review-eval.mjs";

export function evalCommands({ flag, say, record }) {
  return {
    "eval review": () => {   // --cases config/review-evals --dir <one folder per case, each with review.md> --model --provider
      const results = loadCases(flag("cases", "config/review-evals")).map(({ name, expect }) => {
        const f = join(flag("dir"), name, "review.md");
        return scoreCase(name, expect, existsSync(f) ? readFileSync(f, "utf8") : "");
      });
      const s = summarize(results, { model: flag("model", ""), provider: flag("provider", "") });
      record("eval", { role: "review", model: s.model, provider: s.provider, cases: s.cases, defects: s.defects, caught: s.caught, clean: s.clean, falseAlarms: s.falseAlarms, wrong: s.wrong.join(",") });
      const md = toMarkdown(s, results);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
      return say(md);
    },
  };
}
