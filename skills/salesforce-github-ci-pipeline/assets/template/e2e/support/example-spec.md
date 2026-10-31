# The shape of a UI spec that passes first time

Claude's UI-test writer reads this before writing `e2e/story-<key>.spec.ts`. It is a story's real spec (Case Days
Open), which passed on its first run with 10 agent turns. Copy its shape; change the object, fields, persona and values.

- Make the records with `createRecord` and read what the platform **stored** with `sfJson([... "data", "get",
  "record" ...])` before the browser opens: the expected value comes from the record, not from what was typed.
- Log in as the story's persona: `loginAs(page, { permsets: [...] })`. Open the record with `openRecord`.
- Assert the value the page shows (`toContainText`, `toHaveText`, `toHaveCount`), then call `evidence` with the
  locator of exactly that element.
- One negative test from the criteria: here, a user without the permission sets does not see the field.
- No waits, no retries, no Setup pages. Run it once. If it fails, read the error and the screenshot before changing
  anything.

```ts
import { test, expect } from "@playwright/test";
import { loginAs } from "./support/login";
import { createRecord, openRecord, field, sfJson } from "./support/record";
import { evidence } from "./support/evidence";

test.describe("story 446: Days Open on Case", () => {
  test("a support agent sees Days Open as 0 for a case created today (AC1, AC2)", async ({ page }) => {
    const id = createRecord("Case", { Subject: "Story 446 Days Open case", Status: "New", Origin: "Phone" });
    const stored = sfJson(["data", "get", "record", "-o", process.env.SCRATCH_ALIAS as string, "-s", "Case", "-i", id]);
    expect(stored.Days_Open__c).toEqual(0);

    await loginAs(page, { permsets: ["Support_Agent"] });
    await openRecord(page, "Case", id);

    const daysOpen = field(page, "Days Open");
    await expect(daysOpen).toContainText(/Days Open\s*0\b/);
    await evidence(page, "AC1+AC2: Days Open is 0 on the Case page", daysOpen);
  });

  test("a user without the permission sets does not see Days Open (negative)", async ({ page }) => {
    const id = createRecord("Case", { Subject: "Story 446 No Access case", Status: "New", Origin: "Phone" });
    await loginAs(page, { permsets: [] });
    await openRecord(page, "Case", id, null);
    await expect(page.getByText("Days Open", { exact: true })).toHaveCount(0);
  });
});
```
