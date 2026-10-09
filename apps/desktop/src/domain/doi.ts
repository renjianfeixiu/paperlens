const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/i;

function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function removeUnmatchedClosingBrackets(value: string): string {
  const bracketPairs = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const;

  let normalized = value;
  for (const [opening, closing] of bracketPairs) {
    const openingCount = [...normalized].filter((character) => character === opening).length;
    let closingCount = [...normalized].filter((character) => character === closing).length;

    while (normalized.endsWith(closing) && closingCount > openingCount) {
      normalized = normalized.slice(0, -1);
      closingCount -= 1;
    }
  }

  return normalized;
}

/**
 * Convert common DOI representations to the canonical value used by PaperLens.
 * Invalid input returns undefined so callers never accidentally deduplicate on
 * an arbitrary URL or citation fragment.
 */
export function normalizeDoi(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  let normalized = safelyDecode(value.trim())
    .replace(/^doi\s*:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^(?:dx\.)?doi\.org\//i, "")
    .trim();

  // URL query strings and fragments are not part of a DOI copied from doi.org.
  normalized = normalized.split(/[?#]/, 1)[0];
  normalized = normalized.replace(/[\s.,;:]+$/g, "");
  normalized = removeUnmatchedClosingBrackets(normalized).toLowerCase();

  return DOI_PATTERN.test(normalized) ? normalized : undefined;
}
