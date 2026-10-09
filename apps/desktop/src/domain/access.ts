export type AccessLocationSource =
  | "openalex"
  | "crossref"
  | "unpaywall"
  | "core"
  | "europe-pmc"
  | "publisher-metadata"
  | "institution"
  | "semantic-scholar"
  | "arxiv"
  | "local";

export type AccessLocationKind = "pdf" | "landing-page";

/**
 * A legal place where a paper can be opened. `isOpenAccess` describes the
 * individual location, rather than assuming that every publisher link is free.
 */
export type AccessLocation = {
  url: string;
  kind: AccessLocationKind;
  source: AccessLocationSource;
  isOpenAccess: boolean;
  license: string | null;
  version: string | null;
  hostType?: string;
  hostName?: string;
};

const ACCESS_SOURCES: ReadonlySet<AccessLocationSource> = new Set([
  "openalex",
  "crossref",
  "unpaywall",
  "core",
  "europe-pmc",
  "publisher-metadata",
  "institution",
  "semantic-scholar",
  "arxiv",
  "local",
]);

/** Accept only navigable web URLs and canonicalize fragments away for dedupe. */
export function normalizeAccessUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const candidate = value.trim();
  if (!candidate || /[\u0000-\u001f\u007f]/.test(candidate)) return undefined;

  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return undefined;
    }

    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function inferAccessKind(url: string): AccessLocationKind {
  try {
    return /\.pdf$/i.test(new URL(url).pathname) ? "pdf" : "landing-page";
  } catch {
    return "landing-page";
  }
}

function trustedOpenRepositoryPdf(location: AccessLocation): string | undefined {
  let url: URL;
  try {
    url = new URL(location.url);
  } catch {
    return undefined;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (host === "arxiv.org" || host === "www.arxiv.org") {
    const match = path.match(/^\/(?:abs|pdf)\/([^/]+?)(?:\.pdf)?$/i);
    return match ? `https://arxiv.org/pdf/${match[1].replace(/v\d+$/i, "")}` : undefined;
  }

  if (host === "aclanthology.org") {
    const id = path.match(/^\/([^/]+)\/?$/)?.[1];
    return id && !id.toLowerCase().endsWith(".pdf")
      ? `https://aclanthology.org/${id}.pdf`
      : undefined;
  }

  if (host === "proceedings.mlr.press" && /\.html$/i.test(path)) {
    return `${url.origin}${path.replace(/\.html$/i, ".pdf")}`;
  }

  if (host === "openaccess.thecvf.com" && path.includes("/html/")) {
    const pdfPath = path
      .replace("/html/", "/papers/")
      .replace(/\.html$/i, "")
      .replace(/_paper$/i, "_paper.pdf");
    return `${url.origin}${pdfPath}`;
  }

  const neurips = path.match(/^\/((?:paper_files\/)?paper)\/(\d{4})\/hash\/([a-f\d]+)-Abstract\.html$/i);
  if (["proceedings.neurips.cc", "papers.neurips.cc", "papers.nips.cc"].includes(host) && neurips) {
    return `${url.origin}/${neurips[1]}/${neurips[2]}/file/${neurips[3]}-Paper.pdf`;
  }

  return undefined;
}

function isTrustedOpenRepository(location: AccessLocation): boolean {
  try {
    const host = new URL(location.url).hostname.toLowerCase();
    return [
      "arxiv.org",
      "www.arxiv.org",
      "aclanthology.org",
      "proceedings.mlr.press",
      "openaccess.thecvf.com",
      "proceedings.neurips.cc",
      "papers.neurips.cc",
      "papers.nips.cc",
    ].includes(host);
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse an untrusted persisted/upstream location into the public model. */
export function normalizeAccessLocation(value: unknown): AccessLocation | undefined {
  if (!isRecord(value)) return undefined;

  const url = normalizeAccessUrl(value.url);
  const source = ACCESS_SOURCES.has(value.source as AccessLocationSource)
    ? (value.source as AccessLocationSource)
    : undefined;
  if (!url || !source) return undefined;

  const kind =
    value.kind === "pdf" || value.kind === "landing-page"
      ? value.kind
      : inferAccessKind(url);
  const hostType = nonEmptyString(value.hostType);
  const hostName = nonEmptyString(value.hostName);

  return {
    url,
    kind,
    source,
    isOpenAccess: value.isOpenAccess === true,
    license: nonEmptyString(value.license) ?? null,
    version: nonEmptyString(value.version) ?? null,
    ...(hostType ? { hostType } : {}),
    ...(hostName ? { hostName } : {}),
  };
}

function mergeLocation(current: AccessLocation, incoming: AccessLocation): AccessLocation {
  const hostType = current.hostType ?? incoming.hostType;
  const hostName = current.hostName ?? incoming.hostName;

  return {
    ...current,
    kind: current.kind === "pdf" || incoming.kind !== "pdf" ? current.kind : "pdf",
    isOpenAccess: current.isOpenAccess || incoming.isOpenAccess,
    license: current.license ?? incoming.license,
    version: current.version ?? incoming.version,
    ...(hostType ? { hostType } : {}),
    ...(hostName ? { hostName } : {}),
  };
}

/** Keep source ordering while combining repeated canonical URLs. */
export function deduplicateAccessLocations(values: readonly unknown[]): AccessLocation[] {
  const locations: AccessLocation[] = [];
  const indexes = new Map<string, number>();

  for (const value of values) {
    const location = normalizeAccessLocation(value);
    if (!location) continue;

    const existingIndex = indexes.get(location.url);
    if (existingIndex === undefined) {
      indexes.set(location.url, locations.push(location) - 1);
      continue;
    }

    locations[existingIndex] = mergeLocation(locations[existingIndex], location);
  }

  return locations;
}

/**
 * Turn known official open-repository landing pages into conservative PDF
 * candidates. This is deliberately an allow-list; arbitrary publisher pages
 * are never promoted to open access based on their hostname or file suffix.
 */
export function augmentTrustedOpenAccessLocations(
  values: readonly unknown[],
): AccessLocation[] {
  const normalized = deduplicateAccessLocations(values);
  const candidates: AccessLocation[] = [];

  for (const location of normalized) {
    const trusted = isTrustedOpenRepository(location);
    const enriched = trusted ? { ...location, isOpenAccess: true } : location;
    candidates.push(enriched);

    if (trusted && location.kind === "landing-page") {
      const pdfUrl = trustedOpenRepositoryPdf(location);
      if (pdfUrl) {
        candidates.push({
          ...enriched,
          url: pdfUrl,
          kind: "pdf",
        });
      }
    }
  }

  return deduplicateAccessLocations(candidates);
}

function versionPriority(version: string | null): number {
  switch (version?.toLowerCase()) {
    case "publishedversion":
    case "vor":
      return 30;
    case "acceptedversion":
    case "am":
      return 20;
    case "submittedversion":
    case "sm":
      return 10;
    default:
      return 0;
  }
}

function reliablePdfHost(url: string): boolean {
  try {
    return [
      "arxiv.org",
      "www.arxiv.org",
      "aclanthology.org",
      "proceedings.mlr.press",
      "openaccess.thecvf.com",
      "proceedings.neurips.cc",
      "papers.neurips.cc",
      "papers.nips.cc",
    ].includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Ordered OA PDF candidates for automatic fallback and explicit source choice. */
export function openAccessPdfLocations(
  locations: readonly AccessLocation[],
): AccessLocation[] {
  return augmentTrustedOpenAccessLocations(locations)
    .filter(
      (location) =>
        location.isOpenAccess &&
        location.kind === "pdf" &&
        location.url.startsWith("https://"),
    )
    .sort((left, right) => {
      const score = (location: AccessLocation) =>
        versionPriority(location.version) +
        (reliablePdfHost(location.url) ? 40 : 0) +
        (location.hostType === "repository" ? 8 : 0);
      return score(right) - score(left);
    });
}

export function preferredOpenAccessUrl(
  locations: readonly AccessLocation[],
): string | undefined {
  return (
    locations.find((location) => location.isOpenAccess && location.kind === "pdf")?.url ??
    locations.find((location) => location.isOpenAccess)?.url
  );
}
