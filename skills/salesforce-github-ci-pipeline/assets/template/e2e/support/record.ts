// Record helpers for story specs: the steps every Lightning record test repeats, written once from specs that passed
// (story #200), so a UI test spends its turns on the acceptance criteria, not on plumbing.
//   createRecord("Contact", { LastName: "Ng", MobilePhone: "0400 000 000" })   -> id (sf CLI, the scratch org)
//   await openRecord(page, "Contact", id)          the record page, on its Details tab
//   await editField(page, "Preferred contact method")   the field's pencil: the whole record opens in edit mode
//   await choosePicklist(page, "Preferred contact method", "SMS") · await fillField(page, "Mobile", "0400 000 000")
//   await save(page)
//   await expect(field(page, "Preferred contact method")).toContainText("SMS")
//   await expect(formError(page, "Add a mobile number")).toBeVisible()
import { execFileSync } from "node:child_process";
import { Locator, Page } from "@playwright/test";
import { openPath } from "./login";

/** The sf CLI against the story's scratch org (SCRATCH_ALIAS), its JSON `result`. */
export function sfJson(args: string[]): any {
  const out = execFileSync("sf", [...args, "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      SF_AUTOUPDATE_DISABLE: "true",
      NODE_NO_WARNINGS: "1"
    }
  });
  return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1))
    .result;
}

/** Create a record in the scratch org; returns its id. Values are quoted for the CLI. */
export function createRecord(
  sobject: string,
  fields: Record<string, string | number | boolean>
): string {
  const values = Object.entries(fields)
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "\\'")}'`)
    .join(" ");
  return sfJson([
    "data",
    "create",
    "record",
    "-o",
    process.env.SCRATCH_ALIAS as string,
    "-s",
    sobject,
    "-v",
    values
  ]).id;
}

/** Open a record page and its tab (Details by default: record pages open on Activity or Related). */
export async function openRecord(
  page: Page,
  sobject: string,
  id: string,
  tab: string | null = "Details"
): Promise<void> {
  await openPath(page, `/lightning/r/${sobject}/${id}/view`);
  if (tab)
    await page.getByRole("tab", { name: tab }).click({ timeout: 45_000 });
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => {});
}

/** Click a field's pencil on the Details tab: the whole record opens in edit mode. */
export async function editField(page: Page, label: string): Promise<void> {
  await page
    .getByRole("button", { name: `Edit ${label}` })
    .click({ timeout: 15_000 });
}

/** In edit mode: open a picklist (a combobox) and choose a value. */
export async function choosePicklist(
  page: Page,
  label: string,
  value: string
): Promise<void> {
  await page.getByRole("combobox", { name: label }).click({ timeout: 10_000 });
  await page
    .getByRole("option", { name: value, exact: true })
    .first()
    .click({ timeout: 10_000 });
}

/** In edit mode: type into a text, number, phone or email field. */
export async function fillField(
  page: Page,
  label: string,
  value: string
): Promise<void> {
  await page.getByLabel(label, { exact: true }).fill(value);
}

/** Save the record form and let the page settle. */
export async function save(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Save", exact: true })
    .first()
    .click({ timeout: 10_000 });
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => {});
}

/** A field on the Details tab (its label and value): assert with toContainText / toHaveCount(0). */
export function field(page: Page, label: string): Locator {
  return page
    .locator("records-record-layout-item")
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
}

/** A save error in the record form (under the field, or in the "We hit a snag" summary). */
export function formError(page: Page, text: string): Locator {
  return page.getByText(text, { exact: false }).first();
}
