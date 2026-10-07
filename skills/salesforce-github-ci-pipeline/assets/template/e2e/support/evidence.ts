import { Locator, Page } from "@playwright/test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * UI evidence: one small screenshot of what an acceptance criterion looks like, for the story's "UI evidence"
 * comment (pipeline/src/evidence.mjs). Call it after the criterion's assertion, with the component that shows the
 * result: `await evidence(page, "AC1: Customer Since is filled", page.getByText("Customer Since"))`. The shot is the
 * screen around it, with the component outlined, so a reader sees which record it is.
 *
 * A no-op unless EVIDENCE_DIR is set: the ui-test workflow sets it only when the UI_EVIDENCE switch is on, so the
 * staging regression and local runs take nothing. It never fails the test.
 *
 * Kept small on purpose: the shot is shrunk in the browser itself (no image libraries) to at most 960 px wide and
 * 1200 px tall, as WebP; if it is still over 100 KB, smaller again. Only the page's Lightning path is kept, never
 * its URL: a front-door URL carries a session.
 */
const MAX_KB = 100;
const STEPS: [number, number, number][] = [
  [960, 1200, 0.5],
  [720, 900, 0.35],
  [560, 700, 0.25]
];

export async function evidence(
  page: Page,
  caption: string,
  target?: Locator
): Promise<void> {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const slug =
      caption
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60) || "screenshot";
    // a retried test reuses its number, so a retry replaces its shot instead of adding one
    const taken = readdirSync(dir).filter((f) => /^\d\d-.+\.webp$/.test(f));
    const mine = taken.find((f) => f.slice(3, -5) === slug);
    const n = mine
      ? mine.slice(0, 2)
      : String(taken.length + 1).padStart(2, "0");

    // the screen around the result, with the result outlined: one field alone says nothing about which record it is
    let shot: Buffer;
    if (target) {
      await target.scrollIntoViewIfNeeded();
      // a box drawn over it, not a style on it: the page's own styles (Lightning's included) cannot hide a box
      await target.evaluate((el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const box = document.createElement("div");
        box.id = "__pipeline_evidence_box";
        box.style.cssText = `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:3px solid #d93f0b;border-radius:4px;z-index:2147483647;pointer-events:none;box-sizing:border-box`;
        document.body.appendChild(box);
      });
      try {
        shot = await page.screenshot({ type: "jpeg", quality: 80 });
      } finally {
        await page.evaluate(() =>
          document.getElementById("__pipeline_evidence_box")?.remove()
        );
      }
    } else shot = await page.screenshot({ type: "jpeg", quality: 80 });
    const scratch = await page.context().newPage(); // about:blank: no page CSP in the way of the canvas
    let webp: Buffer | null = null;
    try {
      for (const [w, h, q] of STEPS) {
        const b64 = await scratch.evaluate(
          async ([src, w, h, q]) => {
            const img = new Image();
            img.src = `data:image/jpeg;base64,${src}`;
            await img.decode();
            const scale = Math.min(
              1,
              w / img.naturalWidth,
              h / img.naturalHeight
            );
            const c = document.createElement("canvas");
            c.width = Math.round(img.naturalWidth * scale);
            c.height = Math.round(img.naturalHeight * scale);
            c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
            const url = c.toDataURL("image/webp", q);
            return url.startsWith("data:image/webp") ? url.split(",")[1] : null;
          },
          [shot.toString("base64"), w, h, q] as const
        );
        if (!b64) break;
        webp = Buffer.from(b64, "base64");
        if (webp.length <= MAX_KB * 1024) break;
      }
    } finally {
      await scratch.close();
    }
    if (!webp || webp.length > MAX_KB * 1024) {
      console.warn(
        `evidence: "${caption}" skipped (could not make it small enough)`
      );
      return;
    }
    let path: string | null = null;
    try {
      const p = new URL(page.url()).pathname;
      path = p.startsWith("/lightning/") ? p : null;
    } catch {}
    writeFileSync(join(dir, `${n}-${slug}.webp`), webp);
    writeFileSync(
      join(dir, `${n}-${slug}.json`),
      JSON.stringify({ caption: caption.slice(0, 140), path })
    );
  } catch (e) {
    console.warn(`evidence: "${caption}" skipped: ${(e as Error).message}`);
  }
}
