// Text that goes into SOQL or anonymous Apex: one quoting rule for both (they escape a string literal the same way).
// Pure.

/** A string literal for SOQL or Apex: 'O\'Brien'. Backslashes first, then quotes. */
export const soqlString = (text) => `'${String(text).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
