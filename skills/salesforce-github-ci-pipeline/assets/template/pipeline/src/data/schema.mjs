// The Org schema (see GLOSSARY.md): what the generator may write in an org, read from that org's own describe, so test
// data fits however the org is set up. Never stored: describe is the source of truth at load time. Pure.

/** Fields Salesforce sets or the pipeline handles itself: never generated. */
const SYSTEM_FIELDS = new Set(["Id", "OwnerId", "RecordTypeId", "CreatedById", "CreatedDate", "LastModifiedById", "LastModifiedDate", "SystemModstamp", "IsDeleted", "MasterRecordId"]);
/** Objects whose records a load must never create (people, groups, setup data): references to them are left to defaults. */
export const NEVER_CREATED = new Set(["User", "Group", "RecordType", "Profile", "UserRole", "Organization", "BusinessHours", "Pricebook2"]);

const KINDS = {
  string: "text", textarea: "longtext", encryptedstring: "text", email: "email", phone: "phone", url: "url",
  picklist: "picklist", multipicklist: "multipicklist", combobox: "picklist", boolean: "boolean",
  int: "number", double: "number", currency: "number", percent: "number", long: "number",
  date: "date", datetime: "datetime", reference: "reference",
};

/** The schema the generator reads, from `sf sobject describe` results: { [object]: { name, label, createable, nameField, fields, recordTypes } }. */
export function schemaOf(describes) {
  return Object.fromEntries(describes.filter(Boolean).map((d) => [d.name, objectSchema(d)]));
}

function objectSchema(describe) {
  const all = describe.fields || [];
  const fields = Object.fromEntries(all.filter(isGeneratable).filter((f) => !hasCodeTwin(f, all)).map((f) => [f.name, fieldSchema(f, all)]));
  return {
    name: describe.name,
    label: describe.label || describe.name,
    createable: describe.createable !== false,
    nameField: (describe.fields || []).find((f) => f.nameField)?.name || null,
    fields,
    recordTypes: (describe.recordTypeInfos || []).filter((r) => r.available !== false && !r.master && r.active !== false).map((r) => ({ id: r.recordTypeId, developerName: r.developerName, isDefault: Boolean(r.defaultRecordTypeMapping) })),
  };
}

/**
 * With state and country picklists on, an address's country and state are the picklists BillingCountryCode and
 * BillingStateCode; the text twins (BillingCountry) are written by the platform from them, and a value set in both
 * fails ("Mismatched integration value and ISO code"). So only the Code picklist is generated.
 */
const hasCodeTwin = (f, all) => f.type === "string" && all.some((c) => c.name === `${f.name}Code` && c.type === "picklist");

const isGeneratable = (f) => f.createable && !f.calculated && !f.autoNumber && !SYSTEM_FIELDS.has(f.name) && Boolean(KINDS[f.type]);

function fieldSchema(f, allFields) {
  const kind = KINDS[f.type];
  const controller = f.dependentPicklist && f.controllerName ? allFields.find((c) => c.name === f.controllerName) : null;
  return {
    name: f.name,
    label: f.label || f.name,
    kind,
    required: !f.nillable && !f.defaultedOnCreate && kind !== "boolean",
    length: f.length || null,
    scale: f.scale ?? null,
    values: kind === "picklist" || kind === "multipicklist" ? (f.picklistValues || []).filter((v) => v.active !== false).map((v) => v.value) : null,
    controller: controller ? controller.name : null,
    validFor: controller ? validForOf(f, controller) : null,
    referenceTo: kind === "reference" ? f.referenceTo || [] : null,
    groupable: f.groupable !== false,
    aggregatable: f.aggregatable !== false,
  };
}

/**
 * A dependent picklist's active values and the controlling values each is valid for: { value: [controller value] }.
 * describe's validFor is a base64 bitmap: bit i (most significant first) set means valid for the controller's value at
 * index i in its describe (inactive values included); a checkbox controller has index 0 = false, 1 = true.
 */
export function validForOf(dependent, controller) {
  const controllerValues = controller.type === "boolean" ? ["false", "true"] : (controller.picklistValues || []).map((v) => v.value);
  return Object.fromEntries((dependent.picklistValues || []).filter((v) => v.active !== false).map((v) => {
    const bits = Buffer.from(v.validFor || "", "base64");
    return [v.value, controllerValues.filter((_, i) => (bits[i >> 3] ?? 0) & (0x80 >> (i & 7)))];
  }));
}

/** The objects a schema object's required references need records of (polymorphic and never-created ones excluded). */
export function requiredParents(objectSchema) {
  return Object.values(objectSchema.fields)
    .filter((f) => f.kind === "reference" && f.required && f.referenceTo.length === 1 && !NEVER_CREATED.has(f.referenceTo[0]))
    .map((f) => ({ field: f.name, object: f.referenceTo[0] }));
}

/** The reference field on `objectSchema` that points at `parent`: the required one first, else the first by name. */
export function referenceTo(objectSchema, parent) {
  const direct = objectSchema.fields[parent];
  if (direct?.kind === "reference") return direct;
  const candidates = Object.values(objectSchema.fields).filter((f) => f.kind === "reference" && f.referenceTo.length === 1 && f.referenceTo[0].toLowerCase() === parent.toLowerCase());
  return candidates.sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name))[0] || null;
}
