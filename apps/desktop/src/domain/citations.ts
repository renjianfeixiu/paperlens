export type CitationMention = {
  id: string;
  pageNumber: number;
  label: string;
  style: "numbered" | "author-year";
  context: string;
  referenceNumbers: number[];
  references: string[];
};

export function pdfItemsToText(items: readonly unknown[]): string {
  return items.map((item) => {
    if (typeof item !== "object" || item === null || !("str" in item)) return "";
    const text = typeof item.str === "string" ? item.str : "";
    return `${text}${"hasEOL" in item && item.hasEOL === true ? "\n" : " "}`;
  }).join("").replace(/[ \t]+\n/g, "\n");
}

function numberedReferences(value: string): number[] {
  const parts = value.split(/[,;\s]+/).filter(Boolean);
  const numbers: number[] = [];
  for (const part of parts) {
    const range = part.match(/^(\d{1,4})\s*[-–—]\s*(\d{1,4})$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end < start || end - start > 8) return [];
      for (let number = start; number <= end; number += 1) numbers.push(number);
    } else if (/^\d{1,4}$/.test(part)) {
      numbers.push(Number(part));
    } else {
      return [];
    }
    if (numbers.length > 12) return [];
  }
  return [...new Set(numbers)].filter((number) => number > 0);
}

function citationContext(text: string, start: number, end: number): string {
  const before = text.slice(Math.max(0, start - 260), start);
  const after = text.slice(end, Math.min(text.length, end + 260));
  const lastBoundary = Math.max(before.lastIndexOf(". "), before.lastIndexOf("? "), before.lastIndexOf("! "), before.lastIndexOf("\n"));
  const nextBoundaries = [after.indexOf(". "), after.indexOf("? "), after.indexOf("! "), after.indexOf("\n")]
    .filter((index) => index >= 0);
  const prefix = lastBoundary >= 0 ? before.slice(lastBoundary + 1) : before.slice(-150);
  const suffix = nextBoundaries.length > 0 ? after.slice(0, Math.min(...nextBoundaries) + 1) : after.slice(0, 150);
  return `${prefix}${text.slice(start, end)}${suffix}`.replace(/\s+/g, " ").trim();
}

/** Conservative detection of explicit citation markers in actual PDF page text. */
export function extractPageCitations(text: string, pageNumber: number): CitationMention[] {
  const bibliographyHeading = /(?:^|\n)\s*(?:references|bibliography)\s*(?:\n|$)/im.exec(text);
  const body = bibliographyHeading ? text.slice(0, bibliographyHeading.index) : text;
  const found: Array<{ start: number; end: number; label: string; style: CitationMention["style"]; numbers: number[] }> = [];
  const numericPattern = /\[\s*(\d{1,4}(?:\s*(?:[,;]|[-–—])\s*\d{1,4})*)\s*\]/g;
  for (const match of body.matchAll(numericPattern)) {
    const numbers = numberedReferences(match[1]);
    if (numbers.length > 0) found.push({
      start: match.index,
      end: match.index + match[0].length,
      label: match[0],
      style: "numbered",
      numbers,
    });
  }

  const authorYearPattern = /\((\p{Lu}[\p{L}'’-]+(?:\s+et\s+al\.)?(?:\s*(?:&|and)\s*\p{Lu}[\p{L}'’-]+)?),?\s+((?:19|20)\d{2}[a-z]?)\)/gu;
  for (const match of body.matchAll(authorYearPattern)) found.push({
    start: match.index,
    end: match.index + match[0].length,
    label: match[0],
    style: "author-year",
    numbers: [],
  });

  const narrativeAuthorYearPattern = /\b\p{Lu}[\p{L}'’-]+(?:\s+et\s+al\.)?(?:\s*(?:&|and)\s*\p{Lu}[\p{L}'’-]+)?\s*\((?:19|20)\d{2}[a-z]?\)/gu;
  for (const match of body.matchAll(narrativeAuthorYearPattern)) found.push({
    start: match.index,
    end: match.index + match[0].length,
    label: match[0],
    style: "author-year",
    numbers: [],
  });

  return found.sort((left, right) => left.start - right.start)
    .filter((item, index, items) => index === 0 || item.start >= items[index - 1].end)
    .slice(0, 24).map((item) => ({
    id: `${pageNumber}:${item.start}:${item.label}`,
    pageNumber,
    label: item.label,
    style: item.style,
    context: citationContext(body, item.start, item.end),
    referenceNumbers: item.numbers,
    references: [],
    }));
}

/** Only accepts numbered bibliography entries after an explicit References heading. */
export function extractNumberedBibliography(pageTexts: readonly string[]): Record<number, string> {
  const text = pageTexts.join("\n");
  const heading = /(?:^|\n)\s*(?:references|bibliography)\s*(?:\n|$)/im.exec(text);
  if (!heading) return {};
  const bibliography = text.slice(heading.index + heading[0].length);
  const marker = /(?:^|\n)\s*(?:\[(\d{1,4})\]|(\d{1,4})\.)\s+/g;
  const matches = [...bibliography.matchAll(marker)];
  if (matches.length < 2) return {};
  const result: Record<number, string> = {};
  for (let index = 0; index < Math.min(matches.length, 300); index += 1) {
    const current = matches[index];
    const number = Number(current[1] ?? current[2]);
    const end = matches[index + 1]?.index ?? bibliography.length;
    const entry = bibliography.slice(current.index + current[0].length, end)
      .replace(/\s+/g, " ").trim().slice(0, 650);
    if (number > 0 && entry.length >= 12) result[number] = entry;
  }
  return result;
}

export function attachBibliography(
  mentions: readonly CitationMention[],
  entries: Readonly<Record<number, string>>,
): CitationMention[] {
  return mentions.map((mention) => ({
    ...mention,
    references: mention.referenceNumbers.flatMap((number) =>
      entries[number] ? [`[${number}] ${entries[number]}`] : [],
    ),
  }));
}
