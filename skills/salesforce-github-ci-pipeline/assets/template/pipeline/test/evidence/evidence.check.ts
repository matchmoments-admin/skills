import { test, expect } from "@playwright/test";
import { evidence } from "../../../e2e/support/evidence";

// a record-page-like screen: enough real text that the shot is not trivially small
const PAGE = `<body style="font:14px sans-serif;margin:0">${Array.from({ length: 40 }, (_, i) =>
  `<div style="display:flex;gap:24px;padding:8px 24px;border-bottom:1px solid #ddd"><b style="width:160px">Field ${i}</b><span class="v">value ${i} ${"lorem ipsum ".repeat(4)}</span></div>`).join("")}
  <div id="since" style="padding:8px 24px"><b>Customer Since</b> 10/7/2026</div></body>`;

test("a located result is shot, boxed and small", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(PAGE);
  await evidence(page, "AC1: Customer Since is set", page.locator("#since"));
  await expect(page.locator("#__pipeline_evidence_box")).toHaveCount(0); // the box is gone after the shot
});

test("a locator that matches nothing is skipped quickly, and the test still passes", async ({ page }) => {
  await page.setContent(PAGE);
  const t = Date.now();
  await evidence(page, "AC2: nothing here", page.locator("#missing"));
  expect(Date.now() - t).toBeLessThan(10_000);
});

test("a locator that matches several uses the first", async ({ page }) => {
  await page.setContent(PAGE);
  await evidence(page, "AC3: many values", page.locator(".v"));
});

test("two tests may share a caption: first", async ({ page }) => {
  await page.setContent(PAGE);
  await evidence(page, "AC4: same caption");
});
test("two tests may share a caption: second", async ({ page }) => {
  await page.setContent(PAGE);
  await evidence(page, "AC4: same caption");
});

test("a failed attempt's shots are dropped on the retry", async ({ page }, info) => {
  await page.setContent(PAGE);
  if (info.retry === 0) {
    await evidence(page, "AC5: only in the failed attempt");
    throw new Error("first attempt fails on purpose");
  }
  await evidence(page, "AC5: the passing retry");
});
