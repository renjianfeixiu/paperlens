import { deduplicateAccessLocations, type AccessLocation } from "../domain/access";
import type { Paper } from "../domain/paper";
import { findCoreLocations } from "./core";
import { findEuropePmcLocations } from "./europePmc";
import { findUnpaywallLocations } from "./unpaywall";
import { verifiedPublisherLocations } from "./verifiedPublisherLocations";

export type FullTextResolverResult = {
  locations: AccessLocation[];
  sources: string[];
  warnings: string[];
};

type Resolver = {
  name: string;
  run: (fetchImpl: typeof fetch) => Promise<AccessLocation[]>;
};

export async function resolveFullTextLocations(
  paper: Pick<Paper, "doi" | "title">,
  options: {
    fetchImpl?: typeof fetch;
    unpaywallContactEmail?: string;
    timeoutMs?: number;
  } = {},
): Promise<FullTextResolverResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolvers: Resolver[] = [
    { name: "CORE", run: (client) => findCoreLocations(paper, client) },
    { name: "Europe PMC", run: (client) => findEuropePmcLocations(paper, client) },
  ];
  if (paper.doi && options.unpaywallContactEmail) {
    resolvers.push({
      name: "Unpaywall",
      run: (client) => findUnpaywallLocations(paper.doi!, options.unpaywallContactEmail!, client),
    });
  }

  const settled = await Promise.allSettled(resolvers.map(async (resolver) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const client: typeof fetch = (input, init) => fetchImpl(input, {
      ...init,
      signal: controller.signal,
    });
    try {
      return await Promise.race([
        resolver.run(client),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("全文渠道查询超时"));
            controller.abort();
          }, options.timeoutMs ?? 12_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }));
  const locations: AccessLocation[] = verifiedPublisherLocations(paper);
  const sources: string[] = locations.length ? ["官方发表版本"] : [];
  const warnings: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      sources.push(resolvers[index].name);
      locations.push(...result.value);
    } else {
      warnings.push(`${resolvers[index].name} 暂时不可用`);
    }
  });
  return { locations: deduplicateAccessLocations(locations), sources, warnings };
}
