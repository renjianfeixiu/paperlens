import { describe, expect, it } from "vitest";

import { normalizeDoi } from "./doi";

describe("normalizeDoi", () => {
  it.each([
    ["10.1000/ABC.Def", "10.1000/abc.def"],
    [" DOI: 10.1038/S41586-020-2649-2. ", "10.1038/s41586-020-2649-2"],
    ["https://doi.org/10.1145%2F3290605.3300233", "10.1145/3290605.3300233"],
    ["http://dx.doi.org/10.1002/(SICI)1234", "10.1002/(sici)1234"],
    ["doi.org/10.5555/example?source=reader", "10.5555/example"],
    ["10.1000/example).", "10.1000/example"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeDoi(input)).toBe(expected);
  });

  it.each([undefined, null, "", "https://example.com/paper", "not-a-doi", "10/foo"])(
    "rejects invalid DOI input %s",
    (input) => {
      expect(normalizeDoi(input)).toBeUndefined();
    },
  );
});
