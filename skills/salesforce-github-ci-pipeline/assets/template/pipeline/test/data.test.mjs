// Pipeline tests: test data on request. The pure modules (request, schema, load plan, generate, profile, ledger), the
// use case through the in-memory Org data store, and the sf adapter on recorded CLI output (fixtures/sf).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRequest, requestId, parseDataCommand, DataRequestError, MAX_COUNT } from "../src/data/request.mjs";
import { schemaOf, requiredParents, validForOf } from "../src/data/schema.mjs";
import { objectsNeeded, loadPlan } from "../src/data/load-plan.mjs";
import { generateRecords, resolveTokens } from "../src/data/generate.mjs";
import { profileQueries, profileFrom, SUPPRESSED } from "../src/data/profile.mjs";
import { begin, record, finish, deletions, decide } from "../src/data/ledger.mjs";
import { loadTestData, removeTestData, testDataStatus } from "../src/data/load.mjs";
import { sfDataStore } from "../src/org/data-store.mjs";
import { sfFrom } from "../src/io.mjs";
import { scopeOf } from "../bin/commands/data.mjs";
import { memoryDataStore } from "./data-store-memory.mjs";

const field = (name, type, extra = {}) => ({ name, type, label: name, createable: true, nillable: true, defaultedOnCreate: false, calculated: false, autoNumber: false, ...extra });
/** A validFor bitmap valid for the controller values at these indexes. */
const validFor = (...indexes) => { const bytes = Buffer.alloc(2); for (const i of indexes) bytes[i >> 3] |= 0x80 >> (i & 7); return bytes.toString("base64"); };
const DESCRIBES = {
  Account: {
    name: "Account", label: "Account", createable: true,
    recordTypeInfos: [{ recordTypeId: "012M", developerName: "Master", master: true, available: true }, { recordTypeId: "012B", developerName: "Business", available: true }, { recordTypeId: "012P", developerName: "Partner", available: true }],
    fields: [
      field("Id", "id", { createable: false }), field("Name", "string", { nillable: false, nameField: true, length: 80 }), field("OwnerId", "reference", { nillable: false, defaultedOnCreate: true, referenceTo: ["User"] }),
      field("Industry", "picklist", { picklistValues: [{ value: "Finance" }, { value: "Retail" }, { value: "Old", active: false }] }),
      field("NumberOfEmployees", "int"), field("Description", "textarea"), field("Score__c", "double", { calculated: true }),
      field("ParentId", "reference", { referenceTo: ["Account"] }),
    ],
  },
  Contact: {
    name: "Contact", label: "Contact", createable: true, recordTypeInfos: [],
    fields: [field("LastName", "string", { nillable: false, length: 80 }), field("Email", "email"), field("AccountId", "reference", { referenceTo: ["Account"] }), field("Name", "string", { createable: false, nameField: true })],
  },
  Visit__c: {
    name: "Visit__c", label: "Visit", createable: true, recordTypeInfos: [],
    fields: [field("Name", "string", { nillable: false, nameField: true, length: 80 }), field("Account__c", "reference", { nillable: false, referenceTo: ["Account"] }), field("Visited__c", "date"), field("Done__c", "boolean", { nillable: false })],
  },
  Case: {
    name: "Case", label: "Case", createable: true, recordTypeInfos: [],
    fields: [
      field("Subject", "string", { length: 255 }), field("Origin", "picklist", { nillable: false, picklistValues: [{ value: "Email" }, { value: "Phone" }, { value: "Web" }] }),
      field("Reason", "picklist", { nillable: false, picklistValues: [{ value: "Billing" }, { value: "Retired", active: false }, { value: "Shipping" }] }),
      field("Sub_Reason__c", "picklist", { nillable: false, dependentPicklist: true, controllerName: "Reason", picklistValues: [{ value: "Overcharged", validFor: validFor(0) }, { value: "Damaged", validFor: validFor(2) }, { value: "Late", validFor: validFor(2) }] }),
    ],
  },
  Mandatory__c: {
    name: "Mandatory__c", label: "Mandatory", createable: true, recordTypeInfos: [],
    fields: [field("Name", "string", { nillable: false, nameField: true }), field("Manager__c", "reference", { nillable: false, referenceTo: ["User"] }), field("Previous__c", "reference", { nillable: false, referenceTo: ["Mandatory__c"] })],
  },
};
const SCHEMA = schemaOf(Object.values(DESCRIBES));
const TODAY = new Date("2026-11-08T00:00:00Z");
const requestOf = (objects) => parseRequest({ version: 1, objects });
function generate(objects, extra = {}) {
  const plan = loadPlan(SCHEMA, requestOf(objects));
  if (plan.problems.length) throw new DataRequestError(plan.problems);
  return { plan, ...generateRecords({ schema: SCHEMA, plan, seed: "s", today: TODAY, ...extra }) };
}

// ---- the request and the /data command

test("data request: validated with every problem at once; its id ignores key order; a newer version is refused", () => {
  const request = requestOf([{ object: "Account", count: 3 }, { object: "Contact", perParent: { Account: 2 }, set: { Email: "a@example.com" } }]);
  assert.deepEqual(request.objects[1].perParent, { parent: "Account", count: 2 });
  assert.equal(requestId(request), requestId(parseRequest(JSON.stringify({ objects: [{ count: 3, object: "Account" }, { set: { Email: "a@example.com" }, perParent: { Account: 2 }, object: "Contact" }], version: 1 }))));
  assert.notEqual(requestId(request), requestId(requestOf([{ object: "Account", count: 4 }])));
  assert.throws(() => parseRequest({ objects: [{ object: "Account" }, { object: "1bad", count: MAX_COUNT + 1 }] }), (e) => e instanceof DataRequestError && e.problems.length === 3);
  assert.throws(() => parseRequest({ version: 2, objects: [{ object: "Account", count: 1 }] }), /newer pipeline/);
});

test("/data command: clauses, per parent, field values; any case; unknown names get a did-you-mean and change nothing", () => {
  const known = ["Account", "Contact", "Case", "Site_Visit__c"];
  const { request, understood, problems } = parseDataCommand('/data account 20; Contact 2 per Account; Case 5 Status=Escalated Subject="Printer on fire" IsEscalated=true', known);
  assert.deepEqual(problems, []);
  assert.deepEqual(understood, ["20 Account", "2 Contact per Account", "5 Case (Status=Escalated Subject=Printer on fire IsEscalated=true)"]);
  assert.deepEqual(request.objects[2].set, { Status: "Escalated", Subject: "Printer on fire", IsEscalated: true });
  assert.deepEqual(parseDataCommand("/data", known), { request: null, understood: [], problems: [] }, "bare /data: reload the current request");
  const wrong = parseDataCommand("/data Site_Visits__c 5; Contact many", known);
  assert.equal(wrong.request, null);
  assert.match(wrong.problems[0], /did you mean Site_Visit__c/);
  assert.match(wrong.problems[1], /say how many/);
  assert.match(wrong.problems.at(-1), /For example: \/data/);
});

// ---- the org schema and the load plan

test("org schema: only what the API can create; system, formula and inactive values left out; record types without master", () => {
  assert.deepEqual(Object.keys(SCHEMA.Account.fields), ["Name", "Industry", "NumberOfEmployees", "Description", "ParentId"]);
  assert.deepEqual(SCHEMA.Account.fields.Industry.values, ["Finance", "Retail"]);
  assert.equal(SCHEMA.Account.fields.Name.required, true);
  assert.equal(SCHEMA.Visit__c.fields.Done__c.required, false, "a checkbox always has a value");
  assert.deepEqual(SCHEMA.Account.recordTypes.map((r) => r.developerName), ["Business", "Partner"]);
  assert.deepEqual(requiredParents(SCHEMA.Visit__c), [{ field: "Account__c", object: "Account" }]);
});

test("dependent picklists: validFor decoded against the controller's describe order (inactive values count); a checkbox controller is false/true", () => {
  assert.deepEqual(SCHEMA.Case.fields.Sub_Reason__c.validFor, { Overcharged: ["Billing"], Damaged: ["Shipping"], Late: ["Shipping"] });
  assert.equal(SCHEMA.Case.fields.Sub_Reason__c.controller, "Reason");
  assert.deepEqual(validForOf({ picklistValues: [{ value: "Only when on", validFor: validFor(1) }] }, { type: "boolean" }), { "Only when on": ["true"] });
});

test("load plan: describes what is needed, adds missing parents and says so, orders parents first, never changes the request", () => {
  const request = requestOf([{ object: "Visit__c", count: 4 }, { object: "Contact", perParent: { Account: 2 } }]);
  const frozen = JSON.stringify(request);
  assert.deepEqual(objectsNeeded({}, request).sort(), ["Contact", "Visit__c"], "first round: the request's own objects");
  assert.deepEqual(objectsNeeded(SCHEMA, request).sort(), ["Account", "Contact", "Visit__c"], "then the parents their lookups need");
  const plan = loadPlan(SCHEMA, request);
  assert.deepEqual(plan.order, ["Account", "Visit__c", "Contact"]);
  assert.deepEqual(plan.entries.find((e) => e.object === "Contact").perParent, { field: "AccountId", object: "Account", count: 2 });
  assert.ok(plan.warnings.some((w) => /added 5 Account: Visit__c needs a parent/.test(w)));
  assert.equal(JSON.stringify(request), frozen);
});

test("load plan: a request that does not fit says every problem with a did-you-mean, including lookups test data cannot fill", () => {
  const plan = loadPlan(SCHEMA, requestOf([{ object: "Acount", count: 1 }, { object: "Contact", count: 1, set: { Emial: "x" } }, { object: "Account", count: 1, set: { RecordType: "Partnr" } }, { object: "Mandatory__c", count: 1 }, { object: "Case", perParent: { Account: 2 } }]));
  assert.match(plan.problems[0], /Acount.*did you mean Account/);
  assert.match(plan.problems[1], /Contact.Emial.*did you mean Email/);
  assert.match(plan.problems[2], /record type "Partnr".*did you mean Partner/);
  assert.match(plan.problems[3], /Mandatory__c.Manager__c .*points at User, which test data never creates: set it/);
  assert.match(plan.problems[4], /Mandatory__c.Previous__c .*points at its own object: set it/);
  assert.match(plan.problems[5], /Case has no lookup to Account/);
});

// ---- the generator

test("generate: every required field filled and every reference resolves to an earlier object; nothing optional without a profile", () => {
  const { records, warnings } = generate([{ object: "Visit__c", count: 4 }, { object: "Contact", perParent: { Account: 2 } }]);
  const position = Object.fromEntries(records.map((r, i) => [r.ref, i]));
  for (const r of records) {
    for (const f of Object.values(SCHEMA[r.object].fields).filter((f) => f.required)) assert.ok(f.name in r.fields || f.name in r.parents, `${r.ref}.${f.name}`);
    for (const parent of Object.values(r.parents)) assert.ok(position[parent] < position[r.ref], `${r.ref}'s parent ${parent} comes first`);
  }
  assert.equal(records.filter((r) => r.object === "Contact").length, 10, "2 per each of the 5 Accounts");
  assert.equal(records.find((r) => r.object === "Contact").fields.Email, undefined);
  assert.deepEqual(warnings.filter((w) => /no production profile/.test(w)), ["no production profile for Account, Visit__c, Contact: values are spread evenly and only required fields are filled"], "one warning, not one per object");
});

test("generate: an optional lookup to its own object is never filled (that parent has no id in the same batch)", () => {
  const profile = { objects: { Account: { count: 900, fill: { ParentId: 1 }, values: {}, numbers: {}, dates: {}, recordTypes: {} } } };
  assert.ok(generate([{ object: "Account", count: 30 }], { profile }).records.every((r) => !("ParentId" in r.parents)));
});

test("generate: deterministic; scenarios set values (date tokens, record type by name) that generation never replaces", () => {
  const objects = [{ object: "Account", count: 3, scenario: "Review overdue", set: { NumberOfEmployees: 7, RecordType: "Partner" } }, { object: "Visit__c", count: 2, set: { Visited__c: "${TODAY-400}" } }];
  assert.equal(JSON.stringify(generate(objects).records), JSON.stringify(generate(objects).records));
  const { records } = generate(objects);
  assert.equal(records[0].fields.Name, "Account 001 - Review overdue");
  assert.equal(records[0].fields.NumberOfEmployees, 7);
  assert.equal(records[0].fields.RecordTypeId, "012P");
  assert.equal(records.find((r) => r.object === "Visit__c").fields.Visited__c, "2025-10-04");
  assert.equal(resolveTokens("${LAST_YEAR}-03-15", TODAY), "2025-03-15");
});

test("generate: a required dependent picklist takes a value valid for its controller; a scenario's controller value is honoured", () => {
  for (const r of generate([{ object: "Case", count: 50 }]).records) {
    assert.ok(SCHEMA.Case.fields.Sub_Reason__c.validFor[r.fields.Sub_Reason__c].includes(r.fields.Reason), `${r.fields.Reason} / ${r.fields.Sub_Reason__c}`);
  }
  assert.ok(generate([{ object: "Case", count: 10, set: { Reason: "Shipping" } }]).records.every((r) => ["Damaged", "Late"].includes(r.fields.Sub_Reason__c)));
  assert.throws(() => generate([{ object: "Case", count: 1, set: { Reason: "Retired" } }]), /Case.Sub_Reason__c is required, and none of its values is valid for Reason = Retired: set both/);
});

test("generate: production's weights shape the values; values the org's describe does not list never appear", () => {
  const profile = { objects: { Account: { count: 900, fill: { Industry: 1, NumberOfEmployees: 1 }, values: { Industry: { Finance: 90, Retail: 10, Mining: 500, Other: SUPPRESSED } }, numbers: { NumberOfEmployees: { avg: 50, filled: 900 } }, recordTypes: { Business: 9, Partner: 1 } } } };
  const { records, warnings } = generate([{ object: "Account", count: 400 }], { profile });
  const industries = records.map((r) => r.fields.Industry);
  assert.ok(!industries.includes("Mining") && !industries.includes("Other"), "describe wins over a stale profile; suppressed buckets are never weights");
  const finance = industries.filter((i) => i === "Finance").length;
  assert.ok(finance > 320 && finance < 390, `about 90% Finance (${finance}/400)`);
  assert.ok(records.every((r) => r.fields.NumberOfEmployees >= 25 && r.fields.NumberOfEmployees <= 75), "within 50% of production's average");
  assert.ok(records.filter((r) => r.fields.RecordTypeId === "012B").length > 300);
  assert.ok(!warnings.some((w) => /no production profile/.test(w)));
});

test("generate: values that start async automation are never picked, unless a scenario sets them; too many records is a problem", () => {
  const rules = { never: { "Case.Origin": ["Email"] } };
  assert.ok(generate([{ object: "Case", count: 100 }], { rules }).records.every((r) => r.fields.Origin !== "Email"));
  assert.ok(generate([{ object: "Case", count: 2, set: { Origin: "Email" } }], { rules }).records.every((r) => r.fields.Origin === "Email"));
  assert.throws(() => generate([{ object: "Case", count: 1 }], { rules: { never: { "Case.Origin": ["Email", "Phone", "Web"] } } }), /Case.Origin is required.*set it in the request/);
  assert.throws(() => generate([{ object: "Account", count: MAX_COUNT }, { object: "Contact", count: 1 }]), /up to 2000/);
});

// ---- the data profile

test("data profile: aggregates only, never a text value, MIN or MAX; small buckets suppressed; tiny objects keep only a count", () => {
  const queries = profileQueries(SCHEMA, ["Account", "Contact"]);
  for (const q of queries) {
    assert.doesNotMatch(q.soql.replace(/COUNT\(\w+\)|AVG\(\w+\)|CALENDAR_YEAR\(\w+\)/g, ""), /\b(Name|Description|LastName|Email)\b/, q.soql);
    assert.doesNotMatch(q.soql, /\bMIN\(|\bMAX\(/, "one record's own value");
  }
  assert.ok(queries.some((q) => q.kind === "perParent" && /GROUP BY AccountId/.test(q.soql)), "children per parent");
  const result = (kind, records, extra = {}) => ({ query: { object: "Account", kind, ...extra }, records });
  const profile = profileFrom([
    result("count", [{ n: 100 }]),
    result("fill", [{ f0: 100, f1: 80 }], { fields: ["Name", "Industry"] }),
    result("values", [{ v: "Finance", n: 96 }, { v: "Retail", n: 4 }], { field: "Industry" }),
    result("numbers", [{ a0: 41.234, n0: 60, a1: 4750000, n1: 1 }], { fields: ["NumberOfEmployees", "AnnualRevenue"] }),
    result("perParent", [{ p: "001A", n: 1 }, { p: "001B", n: 2 }, { p: "001C", n: 2 }, { p: "001D", n: 3 }, { p: "001E", n: 9 }], { field: "ParentId" }),
    { query: { object: "Account", kind: "dates", field: "CreatedDate" }, error: "QUERY_TIMEOUT" },
    { query: { object: "Lead", kind: "count" }, records: [{ n: 3 }] },
    { query: { object: "Lead", kind: "values", field: "Status" }, records: [{ v: "Open", n: 3 }] },
  ], { capturedAt: "2026-11-08" });
  assert.deepEqual(profile.objects.Account.values.Industry, { Finance: 96, Retail: SUPPRESSED });
  assert.deepEqual(profile.objects.Account.fill, { Name: 1, Industry: 0.8 });
  assert.deepEqual(profile.objects.Account.numbers, { NumberOfEmployees: { avg: 41.23, filled: 60 } }, "one record's revenue is never kept");
  assert.deepEqual(profile.objects.Account.perParent.ParentId, { p50: 2, p90: 9 });
  assert.equal(JSON.stringify(profile).includes("001A"), false, "parent ids are read and discarded");
  assert.equal(profile.objects.Account.partial, true, "a timed-out query marks the object partial, the profile still builds");
  assert.deepEqual(profile.objects.Lead.values, {}, "an object under the floor keeps only its count");
});

// ---- the ledger's rules

test("ledger: skip only a complete ledger of the same request; unreadable refuses with a fix; deletes go children first, leftovers included", () => {
  const done = finish(record(begin({ scope: "story 9", requestId: "abc", loadedAt: "t", order: ["Account", "Contact"] }), "Account", ["001A"]));
  assert.equal(decide({ state: "found", ledger: done }, "abc").action, "skip");
  assert.equal(decide({ state: "found", ledger: done }, "xyz").action, "load");
  assert.equal(decide({ state: "found", ledger: { ...done, complete: false } }, "abc").action, "load", "a load that died is finished by loading again");
  assert.equal(decide({ state: "none" }, "abc").previous, null);
  assert.match(decide({ state: "unreadable", scope: "story 9", detail: "bad json" }, "abc").reason, /cannot be read \(bad json\).*Nothing was loaded or deleted. Fix:/);
  const ledger = record(begin({ scope: "s", requestId: "r", loadedAt: "t", order: ["Account", "Contact"], leftovers: { Contact: ["003OLD"], Orphan__c: ["a00X"] } }), "Account", Array.from({ length: 201 }, (_, i) => `001${i}`));
  assert.deepEqual(deletions(record(ledger, "Contact", ["003A"])).map((b) => [b.object, b.ids.length]), [["Orphan__c", 1], ["Contact", 2], ["Account", 200], ["Account", 1]]);
});

// ---- the use case, through the in-memory Org data store

const REQUEST = requestOf([{ object: "Account", count: 3 }, { object: "Contact", perParent: { Account: 2 } }]);
const load = (store, request = REQUEST) => loadTestData(store, { request, scope: "story 9", today: TODAY });

test("load: once per request; the ledger lists every id, parents first; loading again does nothing", () => {
  const store = memoryDataStore({ describes: DESCRIBES });
  const first = load(store);
  assert.equal(first.loaded, true);
  assert.match(first.summary, /^9 records \(Account 3, Contact 6\) from 3 Account; 2 Contact per Account$/);
  assert.equal(store.ledger("story 9").complete, true);
  assert.deepEqual(store.ledger("story 9").order, ["Account", "Contact"]);
  assert.equal(load(store).loaded, false);
  assert.equal(store.count("Account"), 3, "not loaded twice");
});

test("load: a changed request replaces exactly the ledger's records; a record a person made survives", () => {
  const store = memoryDataStore({ describes: DESCRIBES });
  load(store);
  const mine = store.addByHand("Account", { Name: "Made by a tester" });
  load(store, requestOf([{ object: "Account", count: 1 }]));
  assert.ok(store.holds(mine));
  assert.equal(store.count("Account"), 2, "the tester's and the one new");
  assert.equal(store.count("Contact"), 0);
  assert.ok(store.calls.indexOf("remove 6") < store.calls.indexOf("remove 3"), "children first");
});

test("load: a run that dies after a batch leaves a ledger the next run cleans up before loading", () => {
  const store = memoryDataStore({ describes: DESCRIBES, failInsert: 2 });
  assert.throws(() => load(store), /insert 2 failed/);
  assert.deepEqual(Object.keys(store.ledger("story 9").records), ["Account"], "the Accounts that landed are tracked");
  assert.equal(store.ledger("story 9").complete, false);
  store.stopFailing();
  load(store);
  assert.equal(store.count("Account"), 3, "the first run's Accounts were removed, not doubled");
  assert.equal(store.ledger("story 9").complete, true);
});

test("load: a ledger save that fails once is retried; failing twice names the records it could not track", () => {
  assert.equal(load(memoryDataStore({ describes: DESCRIBES, failSaves: 1 })).loaded, true);
  assert.throws(() => load(memoryDataStore({ describes: DESCRIBES, failSaves: 2 })), /could not save \[data ledger story 9\] in memory-org: save 2 failed on purpose\. The 3 Account records just loaded \(ACC0001, ACC0002, ACC0003\) are not in it/);
});

test("load: ids that will not delete are carried into the new ledger and retried, never forgotten", () => {
  const store = memoryDataStore({ describes: DESCRIBES });
  load(store);
  const stuck = store.ledger("story 9").records.Account[0];
  store.refuseDeletesOf([stuck]);
  load(store, requestOf([{ object: "Account", count: 1 }]));
  assert.deepEqual(store.ledger("story 9").leftovers, { Account: [stuck] });
  assert.ok(store.holds(stuck));
  assert.match(testDataStatus(store, "story 9").summary, /1 earlier records could not be deleted yet/);
  store.stopFailing();
  assert.equal(load(store, requestOf([{ object: "Account", count: 1 }])).loaded, true, "a ledger with leftovers is never 'already loaded'");
  assert.deepEqual(store.ledger("story 9").leftovers, {});
  assert.ok(!store.holds(stuck), "retried and removed");
});

test("load: an unreadable ledger refuses and touches nothing; a request that does not fit deletes nothing", () => {
  const unreadable = memoryDataStore({ describes: DESCRIBES, unreadableLedger: true });
  assert.throws(() => load(unreadable), /cannot be read.*Nothing was loaded or deleted/);
  assert.deepEqual(unreadable.calls, []);
  const store = memoryDataStore({ describes: DESCRIBES });
  load(store);
  assert.throws(() => load(store, requestOf([{ object: "Acount", count: 1 }])), /"Acount" is not an object in memory-org \(did you mean Account\?\)/);
  assert.equal(store.count("Account"), 3);
});

test("load: production is refused: the Dev Hub, an unknown org, a non-sandbox; the Dev Hub's own scratch org is allowed", () => {
  const refuse = (identity) => assert.throws(() => load(memoryDataStore({ describes: DESCRIBES, identity })), /refusing to load test data into memory-org/);
  refuse({ isDevHub: true });
  refuse({ orgId: null });
  refuse({ isSandbox: false });
  assert.equal(load(memoryDataStore({ describes: DESCRIBES, identity: { isSandbox: false, isOurScratchOrg: true } })).loaded, true);
});

test("remove: the undo takes only the ledger's records; status says what the org holds", () => {
  const store = memoryDataStore({ describes: DESCRIBES });
  assert.equal(testDataStatus(store, "story 9").summary, "no test data for story 9");
  load(store);
  const mine = store.addByHand("Contact", { LastName: "Mine" });
  assert.match(testDataStatus(store, "story 9").summary, /^9 records/);
  assert.deepEqual(removeTestData(store, "story 9"), { removed: true, summary: "removed the test data for story 9" });
  assert.equal(store.count("Account"), 0);
  assert.ok(store.holds(mine));
  assert.equal(testDataStatus(store, "story 9").state, "none");
  assert.equal(scopeOf("data/seed/stories/512/request.json"), "story 512");
});

// ---- the sf adapter, on recorded sf CLI output (fixtures/sf)

const recorded = (name) => readFileSync(new URL(`./fixtures/sf/${name}.json`, import.meta.url), "utf8");
/** sf as the pipeline runs it (sfFrom: the real --json unwrapping), over a runner that replays recorded stdout. */
function recordedSf(replies) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args);
    const body = args.includes("-b") ? readFileSync(args[args.indexOf("-b") + 1].replace(/^@/, ""), "utf8") : null;
    // a REST call's url and method: from its request definition (-f), or from its arguments (-b)
    const rest = args[0] !== "api" ? null : args.includes("-f") ? JSON.parse(readFileSync(args[args.indexOf("-f") + 1], "utf8")) : { url: args.find((a) => a.startsWith("/services/")), method: args[args.indexOf("-X") + 1] };
    const reply = replies(args, body, rest);
    return typeof reply === "string" ? reply : JSON.stringify({ status: 0, result: reply });
  };
  return { calls, sf: sfFrom(run) };
}

test("sf adapter: REST bodies go as @file, replies are unwrapped from { statusCode, body }, and an error status throws", () => {
  let posted = null;
  const { sf, calls } = recordedSf((args, body) => {
    if (args[0] === "api" && args.includes("POST")) { posted = JSON.parse(body); return recorded("rest-post-contentversion"); }
    return { records: [] };
  });
  const store = sfDataStore({ sf, alias: "issue-9" });
  store.saveLedger("story 9", finish(begin({ scope: "story 9", requestId: "abc", loadedAt: "t" })));
  const post = calls.find((a) => a[0] === "api");
  assert.match(post[post.indexOf("-b") + 1], /^@\/.*body\.json$/, "the CLI reads a file only with @");
  assert.equal(posted.Title, "[data ledger story 9]");
  assert.equal(JSON.parse(Buffer.from(posted.VersionData, "base64").toString()).requestId, "abc");
  const failing = recordedSf((args) => (args[0] === "api" ? recorded("rest-error") : { records: [{ Id: "068A", ContentDocumentId: "069A" }] }));
  assert.throws(() => sfDataStore({ sf: failing.sf, alias: "issue-9" }).dropLedger("story 9"), /DELETE .*ContentDocument\/069A in issue-9 answered 404: .*INVALID_CROSS_REFERENCE_KEY/, "sf exits 1; the reason is still said");
  const loggedOut = recordedSf((args) => (args[0] === "api" ? JSON.stringify({ status: 1, message: "No authorization information found" }) : { records: [{ Id: "068A", ContentDocumentId: "069A" }] }));
  assert.throws(() => sfDataStore({ sf: loggedOut.sf, alias: "issue-9" }).dropLedger("story 9"), /failed in issue-9 \(no HTTP reply: is the org logged in\?\)/);
});

test("sf adapter: reads the ledger back (parsed or text body), maps composite deletes, and imports a tree file all or nothing", () => {
  const replies = (args, body, rest) => {
    if (args[0] === "data" && args[1] === "query") return { records: [{ Id: "068A", ContentDocumentId: "069A" }] };
    if (rest?.url.endsWith("/VersionData")) return recorded("rest-get-versiondata");
    if (rest?.method === "DELETE") {
      assert.deepEqual(rest.body, { mode: "raw", raw: "" }, "a bodyless call goes as a definition: -X DELETE alone fails in sf");
      return recorded("rest-delete-composite");
    }
    if (args[0] === "data" && args[1] === "import") return recorded("import-tree");
    return {};
  };
  const store = sfDataStore({ sf: recordedSf(replies).sf, alias: "issue-9" });
  assert.equal(store.readLedger("story 9").ledger.requestId, "abc123");
  const asText = recordedSf((args, body, rest) => (args[0] === "api" ? { statusCode: 200, body: JSON.stringify({ records: {}, requestId: "t" }) } : replies(args, body, rest)));
  assert.equal(sfDataStore({ sf: asText.sf, alias: "issue-9" }).readLedger("story 9").ledger.requestId, "t");
  const garbled = recordedSf((args, body, rest) => (args[0] === "api" ? { statusCode: 200, body: "%PDF" } : replies(args, body, rest)));
  assert.equal(sfDataStore({ sf: garbled.sf, alias: "issue-9" }).readLedger("story 9").state, "unreadable");
  assert.deepEqual(store.remove(["001000000000001AAA", "001000000000002AAA"]).failed, [], "recorded: one already deleted (ENTITY_IS_DELETED) counts as removed");
  const blocked = recordedSf((args, body, rest) => (rest?.method === "DELETE" ? { statusCode: 200, body: [{ id: "003A", success: false, errors: [{ statusCode: "DELETE_FAILED", message: "associated with a case" }] }] } : replies(args, body, rest)));
  assert.deepEqual(sfDataStore({ sf: blocked.sf, alias: "issue-9" }).remove(["003A"]).failed, [{ id: "003A", message: "associated with a case" }]);
  assert.deepEqual(store.insert("Account", [{ ref: "Account1", fields: {} }, { ref: "Account2", fields: {} }]).map((l) => l.id), ["001000000000001AAA", "001000000000002AAA"]);
  assert.throws(() => store.insert("Account", [{ ref: "Account1", fields: {} }, { ref: "Account2", fields: {} }, { ref: "Account3", fields: {} }]), /loaded 2 of 3 Account/);
});

test("sf adapter: who the org is, read once; the Dev Hub's scratch-org list is asked only for a non-sandbox", () => {
  let activeAsked = 0;
  const replies = (args) => {
    if (args[0] === "org") return { id: args.includes("devhub") ? "00DPROD000000001" : "00DSCRATCH000001", username: "scratch@x" };
    if (args[0] === "data") return { records: [{ IsSandbox: true }] };
    return {};
  };
  const { sf, calls } = recordedSf(replies);
  const store = sfDataStore({ sf, alias: "issue-9", active: () => { activeAsked++; return []; } });
  const identity = store.identity();
  assert.equal(identity.isSandbox || identity.isOurScratchOrg, true);
  assert.equal(activeAsked, 0);
  store.identity();
  assert.equal(calls.length, 3, "org display twice and one query, once per store");
});

// ---- org provisioning's seed(): story requests, wired to the use case

test("seed: a story's request loads with SEED on even without a core seed; in staging one bad request warns and the rest load", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { dataMethods } = await import("../src/org/data.mjs");
  const work = mkdtempSync(join(tmpdir(), "story-"));
  const put = (key, request) => { mkdirSync(join(work, "data/seed/stories", key), { recursive: true }); writeFileSync(join(work, "data/seed/stories", key, "request.json"), JSON.stringify(request)); };
  put("7", { version: 1, objects: [{ object: "Account", count: 2 }] });
  put("8", { version: 1, objects: [{ object: "Acount", count: 2 }] });
  const store = memoryDataStore({ describes: DESCRIBES });
  const logs = [];
  const methods = (env) => dataMethods({ sf: () => null, log: (l) => logs.push(l), env, seedDir: join(work, "none"), record: () => {}, seedId: () => null, dataRoot: work, makeStore: () => store });
  const cwd = process.cwd();
  process.chdir(work);
  try {
    assert.deepEqual(methods({ SEED: "off" }).seed("issue-7", { story: "7" }), [], "SEED=off: nothing");
    assert.match(methods({}).seed("issue-7", { story: "7" })[0], /^\[data story 7 [0-9a-f]{12}\]$/, "no core seed, still the story's request");
    assert.throws(() => methods({}).seed("issue-8", { story: "8" }), /"Acount" is not an object/, "the story's own org fails loudly");
    const loaded = methods({}).seed("staging", { stories: "all" });
    assert.deepEqual(loaded, [], "story 7 already loaded in this org; story 8 skipped");
    assert.ok(logs.some((l) => /::warning::staging: story 8's test data was not loaded:\n  - "Acount" is not an object/.test(l)));
  } finally { process.chdir(cwd); }
});
