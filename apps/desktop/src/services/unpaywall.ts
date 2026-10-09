import {
  augmentTrustedOpenAccessLocations,
  deduplicateAccessLocations,
  type AccessLocation,
} from "../domain/access";
import { normalizeDoi } from "../domain/doi";

const UNPAYWALL_ENDPOINT = "https://api.unpaywall.org/v2";

type UnpaywallLocation = {
  url_for_pdf?: unknown;
  url_for_landing_page?: unknown;
  url?: unknown;
  license?: unknown;
  version?: unknown;
  host_type?: unknown;
  is_best?: unknown;
};

type UnpaywallResponse = {
  is_oa?: unknown;
  best_oa_location?: UnpaywallLocation | null;
  oa_locations?: unknown;
};

export class UnpaywallError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UnpaywallError";
    this.status = status;
  }
}

export function isValidContactEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function locations(value: unknown): UnpaywallLocation[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is UnpaywallLocation => typeof entry === "object" && entry !== null,
      )
    : [];
}

function mapLocation(location: UnpaywallLocation | null | undefined): unknown[] {
  if (!location) return [];

  const shared = {
    source: "unpaywall" as const,
    isOpenAccess: true,
    license: nonEmptyString(location.license) ?? null,
    version: nonEmptyString(location.version) ?? null,
    ...(nonEmptyString(location.host_type)
      ? { hostType: nonEmptyString(location.host_type) }
      : {}),
  };
  return [
    { ...shared, url: location.url_for_pdf, kind: "pdf" as const },
    {
      ...shared,
      url: location.url_for_landing_page ?? location.url,
      kind: "landing-page" as const,
    },
  ];
}

export function mapUnpaywallLocations(value: UnpaywallResponse): AccessLocation[] {
  const candidates = [
    ...mapLocation(value.best_oa_location),
    ...locations(value.oa_locations).flatMap(mapLocation),
  ];
  return augmentTrustedOpenAccessLocations(deduplicateAccessLocations(candidates));
}

export async function findUnpaywallLocations(
  doiValue: string,
  contactEmail: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessLocation[]> {
  const doi = normalizeDoi(doiValue);
  if (!doi) throw new UnpaywallError("这篇论文缺少可查询的 DOI。");
  if (!isValidContactEmail(contactEmail)) {
    throw new UnpaywallError("请先设置有效邮箱，用于 Unpaywall API 联系标识。");
  }

  const url = new URL(`${UNPAYWALL_ENDPOINT}/${encodeURIComponent(doi)}`);
  url.searchParams.set("email", contactEmail.trim());

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new UnpaywallError("无法连接 Unpaywall，请稍后重试。");
  }

  if (response.status === 404) return [];
  if (!response.ok) {
    throw new UnpaywallError(`Unpaywall 全文查询失败（HTTP ${response.status}）。`, response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new UnpaywallError("Unpaywall 返回了无法解析的数据。");
  }

  if (typeof payload !== "object" || payload === null) {
    throw new UnpaywallError("Unpaywall 返回的数据格式发生变化。");
  }
  return mapUnpaywallLocations(payload as UnpaywallResponse);
}
