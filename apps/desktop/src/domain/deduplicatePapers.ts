import { normalizeDoi } from "./doi";
import { deduplicateAccessLocations, preferredOpenAccessUrl } from "./access";
import type { Paper } from "./paper";

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function bibliographicKey(paper: Paper): string | undefined {
  const title = normalizeSearchText(paper.title);
  const firstAuthor = paper.authors[0] && normalizeSearchText(paper.authors[0]);

  if (!title || !firstAuthor || paper.year === null) {
    return undefined;
  }

  return `metadata:${title}|${paper.year}|${firstAuthor}`;
}

function workFamilyKey(paper: Paper): string | undefined {
  const title = normalizeSearchText(paper.title);
  const firstAuthor = paper.authors[0] && normalizeSearchText(paper.authors[0]);
  const titleWords = title.split(" ").filter(Boolean);

  if (!firstAuthor || title.length < 16 || titleWords.length < 3) {
    return undefined;
  }
  return `work-family:${title}|${firstAuthor}`;
}

export function getPaperDeduplicationKeys(paper: Paper): string[] {
  const keys: string[] = [];
  const doi = normalizeDoi(paper.doi);
  const metadata = bibliographicKey(paper);
  const family = workFamilyKey(paper);

  if (doi) {
    keys.push(`doi:${doi}`);
  }
  if (metadata) {
    keys.push(metadata);
  }
  if (family) {
    keys.push(family);
  }

  if (keys.length === 0) {
    keys.push(`source:${paper.source}:${paper.id}`);
  }

  return keys;
}

function preferLonger(current: string | undefined, incoming: string | undefined) {
  if (!current) {
    return incoming;
  }
  if (!incoming) {
    return current;
  }
  return incoming.length > current.length ? incoming : current;
}

function preferOpenAccessUrl(current: string | undefined, incoming: string | undefined) {
  if (!current) {
    return incoming;
  }
  if (!incoming) {
    return current;
  }

  const currentIsPdf = /\.pdf(?:$|[?#])/i.test(current);
  const incomingIsPdf = /\.pdf(?:$|[?#])/i.test(incoming);
  return incomingIsPdf && !currentIsPdf ? incoming : current;
}

function publicationClass(paper: Paper): number {
  const repositoryPattern = /\b(arxiv|biorxiv|medrxiv|ssrn|research square|preprint)\b/i;
  const isRepository =
    ["posted-content", "preprint"].includes(paper.publicationType ?? "") ||
    paper.doi?.startsWith("10.48550/arxiv.") || repositoryPattern.test(paper.venue);
  return isRepository ? 0 : 1;
}

function canonicalPaper(current: Paper, incoming: Paper): [Paper, Paper] {
  const currentClass = publicationClass(current);
  const incomingClass = publicationClass(incoming);
  if (currentClass !== incomingClass) {
    return incomingClass > currentClass ? [incoming, current] : [current, incoming];
  }

  if (current.year !== null && incoming.year !== null && current.year !== incoming.year) {
    return incoming.year < current.year ? [incoming, current] : [current, incoming];
  }

  if (current.source !== incoming.source) {
    return incoming.source === "openalex" ? [incoming, current] : [current, incoming];
  }

  return incoming.citedByCount > current.citedByCount
    ? [incoming, current]
    : [current, incoming];
}

export function mergePapers(current: Paper, incoming: Paper): Paper {
  const [canonical, supplementary] = canonicalPaper(current, incoming);
  const accessLocations = deduplicateAccessLocations([
    ...(current.accessLocations ?? []),
    ...(incoming.accessLocations ?? []),
  ]);
  const legacyOpenAccessUrl = preferOpenAccessUrl(
    current.openAccessUrl,
    incoming.openAccessUrl,
  );
  const openAccessUrl = preferOpenAccessUrl(
    legacyOpenAccessUrl,
    preferredOpenAccessUrl(accessLocations),
  );

  return {
    ...canonical,
    title: preferLonger(canonical.title, supplementary.title) ?? canonical.title,
    authors:
      incoming.authors.length > current.authors.length ? incoming.authors : current.authors,
    year: canonical.year ?? supplementary.year,
    venue: canonical.venue || supplementary.venue,
    abstract: preferLonger(current.abstract, incoming.abstract),
    doi: normalizeDoi(canonical.doi) ?? normalizeDoi(supplementary.doi),
    citedByCount: Math.max(current.citedByCount, incoming.citedByCount),
    publicationType: canonical.publicationType ?? supplementary.publicationType,
    isRetracted: canonical.isRetracted || supplementary.isRetracted,
    searchScore: Math.max(current.searchScore ?? 0, incoming.searchScore ?? 0),
    matchReasons: [...new Set([
      ...(current.matchReasons ?? []),
      ...(incoming.matchReasons ?? []),
    ])],
    isOpenAccess:
      current.isOpenAccess ||
      incoming.isOpenAccess ||
      accessLocations.some((location) => location.isOpenAccess),
    ...(openAccessUrl ? { openAccessUrl } : {}),
    ...(accessLocations.length > 0 ? { accessLocations } : {}),
  };
}

/**
 * Merge records using DOI first, then normalized title and first author. Exact
 * title matches across publication years are treated as versions of one work.
 */
export function deduplicatePapers(papers: readonly Paper[]): Paper[] {
  const deduplicated: Paper[] = [];
  const keyToIndex = new Map<string, number>();

  for (const paper of papers) {
    const keys = getPaperDeduplicationKeys(paper);
    const existingIndex = keys
      .map((key) => keyToIndex.get(key))
      .find((index): index is number => index !== undefined);

    if (existingIndex === undefined) {
      const nextIndex = deduplicated.push({
        ...paper,
        doi: normalizeDoi(paper.doi),
      }) - 1;
      for (const key of keys) {
        keyToIndex.set(key, nextIndex);
      }
      continue;
    }

    const merged = mergePapers(deduplicated[existingIndex], paper);
    deduplicated[existingIndex] = merged;
    for (const key of [...keys, ...getPaperDeduplicationKeys(merged)]) {
      keyToIndex.set(key, existingIndex);
    }
  }

  return deduplicated;
}
