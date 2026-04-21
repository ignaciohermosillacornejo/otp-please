// Trivial smoke test to validate the CI pipeline on an empty scaffold.
// This file will be removed in the Parser PR once real tests exist.
import { test, expect } from 'vitest';

test('scaffold compiles', () => {
  expect(true).toBe(true);
});
