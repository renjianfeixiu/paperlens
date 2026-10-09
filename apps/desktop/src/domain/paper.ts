import type { AccessLocation, AccessLocationSource } from "./access";

export type PaperSource = AccessLocationSource;

export type PaperMatchReason =
  | "exact-identifier"
  | "exact-title"
  | "title"
  | "abstract"
  | "semantic"
  | "bibliographic";

/**
 * The source-independent paper shape consumed by search results and the local
 * library. Missing upstream metadata is represented explicitly instead of
 * inventing values such as an unknown publication year.
 */
export type Paper = {
  /** Stable identifier within `source` (for example, an OpenAlex W identifier). */
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  abstract?: string;
  /** Canonical, lowercase DOI without a doi.org URL prefix. */
  doi?: string;
  citedByCount: number;
  isOpenAccess: boolean;
  /** Upstream work type, used to distinguish articles, reviews and corrections. */
  publicationType?: string;
  /** Retractions should never be silently mixed into ordinary search results. */
  isRetracted?: boolean;
  /** Ephemeral search metadata. It is safe for older persisted items to omit it. */
  searchScore?: number;
  matchReasons?: PaperMatchReason[];
  /** Legacy shortcut retained for existing UI and persisted libraries. */
  openAccessUrl?: string;
  /** Ordered legal access options. Older persisted papers may omit this field. */
  accessLocations?: AccessLocation[];
  source: PaperSource;
};
