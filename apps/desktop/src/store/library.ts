import { getPaperDeduplicationKeys } from "../domain/deduplicatePapers";
import { normalizeDoi } from "../domain/doi";
import {
  deduplicateAccessLocations,
  normalizeAccessUrl,
  preferredOpenAccessUrl,
} from "../domain/access";
import type { Paper } from "../domain/paper";

export const LIBRARY_STORAGE_KEY = "paperlens.library.v1";
export const LIBRARY_VERSION = 1 as const;

export type ReadingStatus =
  | "inbox"
  | "later"
  | "reading"
  | "finished"
  | "archived";

export interface ReadingState {
  /** One-based page number. Zero means that the paper has not been opened. */
  currentPage: number;
  totalPages: number | null;
  /** A normalized value between zero and one. */
  progress: number;
  status: ReadingStatus;
  lastReadAt: string | null;
}

export interface LibraryItem {
  paper: Paper;
  addedAt: string;
  reading: ReadingState;
  /** Native filesystem path for a PDF imported by the user. */
  localFilePath?: string;
}

export interface LibraryState {
  version: typeof LIBRARY_VERSION;
  items: LibraryItem[];
}

export interface AddPaperOptions {
  addedAt?: string;
  localFilePath?: string;
}

export type ReadingStateUpdate = Partial<ReadingState>;

const READING_STATUSES: ReadonlySet<ReadingStatus> = new Set([
  "inbox",
  "later",
  "reading",
  "finished",
  "archived",
]);

const PAPER_SOURCES: ReadonlySet<Paper["source"]> = new Set([
  "openalex",
  "crossref",
  "semantic-scholar",
  "arxiv",
  "local",
]);

const EPOCH = new Date(0).toISOString();

export function createEmptyLibrary(): LibraryState {
  return { version: LIBRARY_VERSION, items: [] };
}

/**
 * Load a library without assuming a browser environment. Invalid JSON, blocked
 * storage, and malformed entries all degrade to a usable state.
 */
export function loadLibrary(storage?: Storage): LibraryState {
  const target = storage ?? getBrowserStorage();
  if (!target) return createEmptyLibrary();

  try {
    const serialized = target.getItem(LIBRARY_STORAGE_KEY);
    return serialized === null
      ? createEmptyLibrary()
      : normalizeLibrary(JSON.parse(serialized));
  } catch {
    return createEmptyLibrary();
  }
}

/** Returns false when storage is unavailable, full, or blocked. */
export function persistLibrary(
  state: LibraryState,
  storage?: Storage,
): boolean {
  const target = storage ?? getBrowserStorage();
  if (!target) return false;

  try {
    target.setItem(
      LIBRARY_STORAGE_KEY,
      JSON.stringify(normalizeLibrary(state)),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Save a paper and return a new state. Existing entries keep their reading
 * state, making repeated imports and repeated save actions idempotent.
 */
export function addPaper(
  state: LibraryState,
  paper: Paper,
  options: AddPaperOptions = {},
): LibraryState {
  if (state.items.some((item) => isSamePaper(item.paper, paper))) return state;

  const item: LibraryItem = {
    paper,
    addedAt: validDate(options.addedAt) ?? new Date().toISOString(),
    reading: createInitialReadingState(),
    ...(nonEmptyString(options.localFilePath)
      ? { localFilePath: options.localFilePath }
      : {}),
  };

  return {
    ...state,
    version: LIBRARY_VERSION,
    items: [...state.items, item],
  };
}

/** Add many search/import results while preserving input order and de-duping. */
export function importPapers(
  state: LibraryState,
  papers: readonly Paper[],
): LibraryState {
  return papers.reduce((next, paper) => addPaper(next, paper), state);
}

/**
 * Add a paper when needed and associate a durable AppLocalData PDF with the
 * matching library item. DOI/title de-duplication prevents a downloaded copy
 * from creating a second metadata row for an already-saved paper.
 */
export function attachLocalPdf(
  state: LibraryState,
  paper: Paper,
  localFilePath: string,
): LibraryState {
  const path = nonEmptyString(localFilePath) ? localFilePath.trim() : "";
  if (!path) return state;

  const withPaper = addPaper(state, paper, { localFilePath: path });
  const index = withPaper.items.findIndex((item) => isSamePaper(item.paper, paper));
  if (index < 0 || withPaper.items[index].localFilePath === path) {
    return withPaper;
  }

  const items = withPaper.items.slice();
  items[index] = { ...items[index], localFilePath: path };
  return { ...withPaper, items };
}

export function removePaper(
  state: LibraryState,
  paperId: string,
): LibraryState {
  const items = state.items.filter((item) => item.paper.id !== paperId);
  return items.length === state.items.length ? state : { ...state, items };
}

/**
 * Update a saved paper's reading state. Passing a number is shorthand for a
 * progress-only update. Pages and progress are clamped to valid bounds.
 */
export function updateReadingState(
  state: LibraryState,
  paperId: string,
  update: ReadingStateUpdate | number,
): LibraryState {
  const index = state.items.findIndex((item) => item.paper.id === paperId);
  if (index < 0) return state;

  const previous = state.items[index];
  const patch: ReadingStateUpdate =
    typeof update === "number" ? { progress: update } : update;
  const reading = applyReadingUpdate(previous.reading, patch);
  const items = state.items.slice();
  items[index] = { ...previous, reading };

  return { ...state, items };
}

export function isSamePaper(left: Paper, right: Paper): boolean {
  if (left.source === right.source && left.id === right.id) return true;

  const leftKeys = new Set(getPaperDeduplicationKeys(left));
  return getPaperDeduplicationKeys(right).some((key) => leftKeys.has(key));
}

/** Public for migrations and tests; always returns a fresh, valid state. */
export function normalizeLibrary(value: unknown): LibraryState {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return createEmptyLibrary();
  }

  const items: LibraryItem[] = [];
  for (const candidate of value.items) {
    const item = parseLibraryItem(candidate);
    if (!item || items.some((saved) => isSamePaper(saved.paper, item.paper))) {
      continue;
    }
    items.push(item);
  }

  return { version: LIBRARY_VERSION, items };
}

function createInitialReadingState(): ReadingState {
  return {
    currentPage: 0,
    totalPages: null,
    progress: 0,
    status: "inbox",
    lastReadAt: null,
  };
}

function applyReadingUpdate(
  previous: ReadingState,
  patch: ReadingStateUpdate,
): ReadingState {
  const totalPages =
    patch.totalPages === undefined
      ? previous.totalPages
      : normalizeTotalPages(patch.totalPages);
  const requestedPage =
    patch.currentPage === undefined
      ? previous.currentPage
      : nonNegativeInteger(patch.currentPage);
  const currentPage =
    totalPages === null ? requestedPage : Math.min(requestedPage, totalPages);

  const pageChanged =
    patch.currentPage !== undefined || patch.totalPages !== undefined;
  const progress =
    patch.progress !== undefined
      ? clampProgress(patch.progress)
      : pageChanged && totalPages !== null
        ? clampProgress(currentPage / totalPages)
        : previous.progress;

  let status = isReadingStatus(patch.status) ? patch.status : previous.status;
  if (patch.status === undefined && status !== "archived") {
    if (progress >= 1) status = "finished";
    else if (progress > 0 && (status === "inbox" || status === "later")) {
      status = "reading";
    }
  }

  const updateRepresentsReading =
    patch.currentPage !== undefined ||
    patch.totalPages !== undefined ||
    patch.progress !== undefined;
  const lastReadAt =
    patch.lastReadAt === null
      ? null
      : validDate(patch.lastReadAt) ??
        (updateRepresentsReading ? new Date().toISOString() : previous.lastReadAt);

  return { currentPage, totalPages, progress, status, lastReadAt };
}

function parseLibraryItem(value: unknown): LibraryItem | null {
  if (!isRecord(value)) return null;

  const paper = parsePaper(value.paper);
  if (!paper) return null;

  const item: LibraryItem = {
    paper,
    addedAt: validDate(value.addedAt) ?? EPOCH,
    reading: parseReadingState(value.reading),
  };

  if (nonEmptyString(value.localFilePath)) {
    item.localFilePath = value.localFilePath;
  }

  return item;
}

function parsePaper(value: unknown): Paper | null {
  if (!isRecord(value)) return null;

  const id = nonEmptyString(value.id) ? value.id : null;
  const title = nonEmptyString(value.title) ? value.title : null;
  if (!id || !title) return null;

  const authors = Array.isArray(value.authors)
    ? value.authors.filter(nonEmptyString)
    : [];
  const source = PAPER_SOURCES.has(value.source as Paper["source"])
    ? (value.source as Paper["source"])
    : "local";
  const paper: Paper = {
    id,
    title,
    authors,
    year: normalizeYear(value.year),
    venue: typeof value.venue === "string" ? value.venue : "",
    citedByCount: nonNegativeInteger(value.citedByCount),
    isOpenAccess:
      typeof value.isOpenAccess === "boolean" ? value.isOpenAccess : false,
    source,
  };

  if (nonEmptyString(value.abstract)) paper.abstract = value.abstract;
  const doi = normalizeDoi(typeof value.doi === "string" ? value.doi : undefined);
  if (doi) paper.doi = doi;

  const legacyOpenAccessUrl = normalizeAccessUrl(value.openAccessUrl);
  const locationCandidates: unknown[] = Array.isArray(value.accessLocations)
    ? [...value.accessLocations]
    : [];

  const accessLocations = deduplicateAccessLocations(locationCandidates);
  if (accessLocations.length > 0) {
    paper.accessLocations = accessLocations;
    paper.isOpenAccess =
      paper.isOpenAccess || accessLocations.some((location) => location.isOpenAccess);
  }

  const openAccessUrl =
    legacyOpenAccessUrl ?? preferredOpenAccessUrl(accessLocations);
  if (openAccessUrl) {
    paper.openAccessUrl = openAccessUrl;
  }

  return paper;
}

function parseReadingState(value: unknown): ReadingState {
  if (!isRecord(value)) return createInitialReadingState();

  const totalPages = normalizeTotalPages(value.totalPages);
  const requestedPage = nonNegativeInteger(value.currentPage);
  const currentPage =
    totalPages === null ? requestedPage : Math.min(requestedPage, totalPages);
  const derivedProgress =
    totalPages === null ? 0 : clampProgress(currentPage / totalPages);
  const progress =
    typeof value.progress === "number"
      ? clampProgress(value.progress)
      : derivedProgress;

  return {
    currentPage,
    totalPages,
    progress,
    status: isReadingStatus(value.status)
      ? value.status
      : progress >= 1
        ? "finished"
        : progress > 0
          ? "reading"
          : "inbox",
    lastReadAt: value.lastReadAt === null ? null : validDate(value.lastReadAt),
  };
}

function normalizeYear(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : null;
}

function normalizeTotalPages(value: unknown): number | null {
  if (value === null) return null;
  const total = nonNegativeInteger(value);
  return total > 0 ? total : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function clampProgress(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function isReadingStatus(value: unknown): value is ReadingStatus {
  return READING_STATUSES.has(value as ReadingStatus);
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getBrowserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
