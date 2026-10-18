---
name: apex-testing
description: How Apex tests are written in this repo - DML-free unit tests with fflib-apex-mocks, a few System.runAs seam tests, per-object test data builders, and the 85% coverage CI enforces on every changed class. Use when writing, fixing or reviewing an Apex test class, raising a class's coverage, adding a <Object>Builder, or mocking a selector, domain, service or unit of work.
---

# Apex testing

The rules live in one file, so this skill and the pipeline's agents never disagree:
**read `docs/agents/apex-testing.md` and follow it.**

It covers: the 85% minimum per changed class (`COVERAGE_MIN`; vendored classes exempt) and what does not count as
coverage; the two layers (unit with fflib mocks, seam with `System.runAs`) and which one each kind of code needs; the
test matrix (positive, negative, boundary, bulk 200, permission); fflib mock gotchas; `TestDataFactory` for users and
`<Object>Builder` for records; the `testFor` / `critical=true` annotations.

Platform facts it builds on (the CI user, system-mode setup, Flow tests): `docs/agents/salesforce.md`. FFLib's own
shapes (domain, selector, unit of work): `docs/fflib.md`, where the repo vendors FFLib.
