// The reviewer eval set (see GLOSSARY.md: Review eval): changes with a known defect, or none, under
// config/review-evals/<case>/ (story.md, pr.diff, expect.json), reviewed by a model the way ai-review reviews a PR
// (review-eval.yml), then scored here. It judges a review model or an experiment arm on defects caught and false
// alarms, not only on cost and overrules (the weekly metrics). Pure, except loadCases (reads the folder).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { reviewVerdict } from "./verdict.mjs";

/** The cases: [{ name, expect: { verdict: "PASS" | "CHANGES", finds: [regex source], why } }], by name. */
export function loadCases(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "expect.json")))
    .map((d) => ({ name: d.name, expect: JSON.parse(readFileSync(join(dir, d.name, "expect.json"), "utf8")) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One case's result from the review's text (its summary and inline findings, as the agent wrote them): the verdict
 * line, and for a defect case whether every expected finding is named (each `finds` entry, case-insensitive). A review
 * with no verdict line is "none": neither caught nor a pass.
 */
export function scoreCase(name, expect, text) {
  const v = reviewVerdict([text]);
  const verdict = v === "pass" ? "PASS" : v === "changes" ? "CHANGES" : "none";
  const missing = (expect.finds || []).filter((f) => !new RegExp(f, "i").test(String(text || "")));
  if (expect.verdict === "PASS") return { name, expected: "PASS", verdict, ok: verdict === "PASS", falseAlarm: verdict === "CHANGES", missing: [] };
  return { name, expected: "CHANGES", verdict, ok: verdict === "CHANGES" && !missing.length, caught: verdict === "CHANGES" && !missing.length, missing };
}

/** The run's score: defects caught of defect cases, false alarms of clean cases, and the cases that went wrong. */
export function summarize(results, { model = "", provider = "" } = {}) {
  const defects = results.filter((r) => r.expected === "CHANGES"), clean = results.filter((r) => r.expected === "PASS");
  return {
    model, provider, cases: results.length,
    defects: defects.length, caught: defects.filter((r) => r.caught).length,
    clean: clean.length, falseAlarms: clean.filter((r) => r.falseAlarm).length,
    noVerdict: results.filter((r) => r.verdict === "none").length,
    wrong: results.filter((r) => !r.ok).map((r) => r.name),
  };
}

/** The job summary people read. */
export function toMarkdown(s, results) {
  return [
    `## Review eval: ${s.provider ? `${s.provider} ` : ""}${s.model || "(the review's default model)"}`, "",
    `**Defects caught: ${s.caught} of ${s.defects}.** False alarms on clean changes: ${s.falseAlarms} of ${s.clean}.${s.noVerdict ? ` No verdict: ${s.noVerdict}.` : ""}`, "",
    "| Case | expected | verdict | result |", "|---|---|---|---|",
    ...results.map((r) => `| ${r.name} | ${r.expected} | ${r.verdict} | ${r.ok ? "ok" : r.falseAlarm ? "false alarm" : r.missing?.length ? `missed: ${r.missing.join(", ")}` : "wrong verdict"} |`),
  ].join("\n");
}
