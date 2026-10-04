const { jestConfig } = require('@salesforce/sfdx-lwc-jest/config');
// e2e/ holds Playwright specs (*.spec.ts); they must never run as LWC unit tests.
module.exports = {
  ...jestConfig,
  modulePathIgnorePatterns: ['<rootDir>/.localdevserver'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/e2e/']
};
