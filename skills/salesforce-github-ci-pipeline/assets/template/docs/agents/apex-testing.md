# Apex tests: the structure every story follows

What a story's Apex tests look like here: two layers, one test matrix, one factory, and a hard number. It narrows
`docs/agents/salesforce.md` (seams, Flow tests, the CI user) for Apex; where the two seem to differ, salesforce.md's
platform facts win. FFLib itself (domain, selector, unit of work) is explained in `docs/fflib.md`.

**What a new repo starts with.** The fflib parts below apply once FFLib is vendored (`docs/vendor.md` lists
`fflib-apex-common` and `fflib-apex-mocks`; the pipeline skill's `bootstrap.sh` vendors both unless `--no-fflib`).
Without it, keep the two layers and mock with `Test.StubProvider`. `TestDataFactory` and the `<Object>Builder` classes
are the repo's own code, not part of the pipeline: the first story that needs a persona adds `TestDataFactory`, and
the first story that tests an object adds its builder (Test data, below). With FFLib vendored, production validation
runs `PROD_TEST_LEVEL=RunLocalTests`: some of upstream's classes stay below the 75% per class that `RunRelevantTests`
needs (check with `sf apex run test --test-level RunLocalTests --code-coverage`).

## The number

- **Every Apex class or trigger a change touches reaches 85% coverage** in CI (`COVERAGE_MIN`, pipeline/src/tests.mjs).
  Below it the **Salesforce tests** check fails and names the class: `Cases coverage 80% is below 85%`.
- The repo's code as a whole keeps the platform's 75% floor; vendored classes (`force-app/vendor/`) are upstream's and
  never count against a story.
- Coverage proves lines ran, not that they are right. These do not count, and the review calls them a blocker:
  a test with no `Assert` or `mocks.verify`; asserting a value the test (or a mock) just set; calling a method only to
  cover it; an empty `catch` in a test; `System.debug` in place of an assert.
- Short of 85%? Find the branch no test reaches (the check run lists each class's percentage) and write the case that
  takes it: usually a negative or boundary case. Never pad.

## Two layers

| Layer | What it proves | How | Speed |
| --- | --- | --- | --- |
| **Unit** (no DML, no SOQL) | the rule: every branch of the logic | records built in memory, collaborators mocked with `fflib_ApexMocks`, `@IsTest(isParallel=true)` | milliseconds |
| **Seam** (the database) | it works in the org: trigger wiring, real SOQL, sharing and field access, 200 records | DML in system mode, `System.runAs` personas from `TestDataFactory` | seconds |

Most of the 85% should come from unit tests; seam tests are few and prove what a mock cannot. Which layer each kind of
code needs:

| Code | Unit test | Seam test |
| --- | --- | --- |
| Domain (`Cases`) | every branch on in-memory records (`new Cases(records).onBeforeInsert()`) | one per trigger event: insert or update, read back; plus bulk 200 |
| Service | mocked selector, domain and unit of work; `verify` what it registered and that it committed once | one happy path through the real objects |
| Selector | none (its job is SOQL) | per method: records that match come back, records that do not are filtered out |
| Trigger | none (no logic in it) | covered by the domain's seam tests |
| Invocable / `@AuraEnabled` | 200 requests in, one response each | as a persona with and without the permission set |
| Record-triggered Flow (only with `flow: <why>`) | Flow tests (salesforce.md, Tests) | Apex: the record after DML, 200 records, "the Flow does not run" |

## The matrix (each class)

One test method per acceptance criterion and case, named for the behaviour (`highPriorityPhoneIsEscalated`):

- **Positive**: the happy path, with exact stored values asserted.
- **Negative**: the input that must not change anything, or must throw (`try { ...; Assert.fail('...'); } catch (X e) { ... }`).
- **Boundary**: threshold −1, at, +1; `null` and empty lists.
- **Bulk**: 200 records in one DML (seam), or 200 in memory (unit).
- **Permission**: a persona **without** the story's permission set is refused, one **with** it succeeds
  (`TestDataFactory.personaWithAccess`). Where the persona has a permission set group, the "with" user holds the
  group, as production's users will, so the test also proves the set is in the group. Never grant the running user more
  access to make a test pass.

Every `Assert` carries a message saying the business expectation: `Assert.isTrue(c.Escalated__c, 'High + Phone is
escalated')`.

## Unit tests with fflib mocks

Our code reaches its collaborators through something a test can swap: a constructor argument, or a `@TestVisible
static` instance the class uses when set. (There is no `Application` factory yet; if one is added, `setMock` on it
replaces these.) Mock what the code under test **calls**, never the class under test itself.

```apex
@IsTest(isParallel=true testFor='ApexClass:CaseEscalationService')
private class CaseEscalationServiceTest {
  @IsTest
  static void escalatesAndCommitsOnce() {
    fflib_ApexMocks mocks = new fflib_ApexMocks();
    fflib_ISObjectUnitOfWork uow = (fflib_ISObjectUnitOfWork) mocks.mock(fflib_ISObjectUnitOfWork.class);
    Case c = new CaseBuilder().withPriority('High').withOrigin('Phone').mock();

    new CaseEscalationService(uow).escalate(new List<Case>{ c });

    fflib_ArgumentCaptor dirty = fflib_ArgumentCaptor.forClass(Case.class);
    ((fflib_ISObjectUnitOfWork) mocks.verify(uow, 1)).registerDirty((SObject) dirty.capture());
    Assert.isTrue(((Case) dirty.getValue()).Escalated__c, 'The case is registered escalated');
    ((fflib_ISObjectUnitOfWork) mocks.verify(uow, 1)).commitWork();
  }
}
```

The rules that bite:

- **A selector or domain mock stubs `sObjectType()`** (`mocks.when(sel.sObjectType()).thenReturn(Account.SObjectType)`);
  fflib finds mocks by SObject type, and without it the real class runs.
- **Matchers are all or nothing.** If one argument is `fflib_Match.anyObject()`, every argument is a matcher
  (`fflib_Match.eq(x)`). `anyString()` does not match `null`: use `fflib_Match.isNull()`.
- **Static and private methods cannot be mocked** (the Stub API): logic lives in instance methods.
- **Fake IDs, not inserts:** `fflib_IDGenerator.generate(Case.SObjectType)`. Read-only fields (formulas, `CreatedDate`):
  `fflib_ApexMocksUtils.setReadOnlyFields(...)`. Children of a parent: `fflib_ApexMocksUtils.makeRelationship(...)`.
- **Prefer an argument captor plus `Assert`** over `fflib_Match.sObjectWith(...)` when more than one field matters: the
  captor's failure names the field.
- Verify order (`fflib_InOrder`) only when the order is the requirement.
- Every test method asserts: an `Assert`, or a `mocks.verify` (Code Analyzer's `ApexUnitTestMethodShouldAssertOrVerify`
  counts both, and fails CI on a method with neither). "Nothing was registered" is `mocks.verify(uow, 0)`. Never
  `@SuppressWarnings` it.
- A mock cannot prove sharing or field access: permission tests are always seam tests.
- Logic that reads the running user's permissions (`FeatureManagement.checkPermission`, a describe) runs inside
  `System.runAs` a persona even in a mock unit test: production's CI user holds permission sets a scratch org's user
  does not, so the same test takes a different path there (story #381).

## Seam tests

- Set up data in **system mode** (`Database.insert(records, AccessLevel.SYSTEM_MODE)`, `[SELECT ... WITH SYSTEM_MODE]`):
  CI's user has none of the story's permission sets, but does have production's own (CLAUDE.md, Access).
- Act inside `System.runAs(persona)`, then read back and assert what was **stored**.
- `@TestSetup` only in seam test classes, and only for data several methods share; each method re-queries it.
- Async: enqueue between `Test.startTest()` and `Test.stopTest()`. Callouts: `Test.setMock(HttpCalloutMock.class, ...)`.
- Never `SeeAllData=true`, never a hard-coded Id; record types by `DeveloperName` through describe.

## Test data: `TestDataFactory` and builders

`TestDataFactory` stays the one entry point for **users** (`persona`, `personaWithAccess`) and `insertAll`. Records come
from one builder per object, an `@IsTest public class <Object>Builder` (`CaseBuilder`, `AccountBuilder`):

```apex
@IsTest
public class CaseBuilder {
  private static Integer counter = 0;
  private Case record = new Case(Subject = 'Case ' + (++counter), Origin = 'Web', Priority = 'Medium');

  public CaseBuilder withPriority(String value) { record.Priority = value; return this; }
  public CaseBuilder withOrigin(String value) { record.Origin = value; return this; }
  public CaseBuilder with(Schema.SObjectField field, Object value) { record.put(field, value); return this; }

  public Case build() { return record.clone(false, true, false, false); }        // in memory
  public Case mock() { Case c = build(); c.Id = fflib_IDGenerator.generate(Case.SObjectType); return c; }   // fake Id, no DML
  public List<Case> buildMany(Integer count) {                                    // 200 for bulk
    List<Case> out = new List<Case>();
    for (Integer i = 0; i < count; i++) { out.add(build()); out[i].Subject = 'Case ' + (++counter); }
    return out;
  }
  public Case persist() { Case c = build(); Database.insert(c, AccessLevel.SYSTEM_MODE); return c; }   // seam tests
}
```

- Defaults satisfy every required field and validation rule **in one place**; a schema change touches one file.
- Fields by token (`Case.Priority`) or typed setter, never by string: a rename fails to compile.
- Unique values from the counter (names, emails), so duplicate rules never fire.
- A story that tests an object with no builder adds one, with its own small test. Inline field lists in a test are a
  review minor.

## Annotations

Every test class says what it tests: `@IsTest(testFor='ApexClass:Cases,ApexTrigger:CaseTrigger')`. Production and CI
pick tests with `RunRelevantTests`, which cannot see FFLib's dynamic dependencies (`Type.forName`, the trigger
handler); `testFor` makes the link explicit. Permission and sharing tests add `critical=true` (REVIEW.md).

## Worked example

In this repo, `Cases` (domain), `CasesMockTest` (unit: in-memory records, every branch, 200), `CasesTest` (seam: insert as a persona,
the permission boundary, 200). Copy their shape.
