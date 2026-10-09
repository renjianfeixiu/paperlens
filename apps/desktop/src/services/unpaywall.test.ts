import { describe, expect, it, vi } from "vitest";

import {
  findUnpaywallLocations,
  isValidContactEmail,
  mapUnpaywallLocations,
} from "./unpaywall";

describe("Unpaywall OA lookup", () => {
  it("maps and de-duplicates best and alternate locations", () => {
    const locations = mapUnpaywallLocations({
      is_oa: true,
      best_oa_location: {
        url_for_pdf: "https://repository.example/paper.pdf",
        url_for_landing_page: "https://repository.example/paper",
        license: "cc-by",
        version: "acceptedVersion",
        host_type: "repository",
      },
      oa_locations: [
        { url_for_pdf: "https://repository.example/paper.pdf" },
        { url_for_pdf: "https://publisher.example/download?id=1", version: "publishedVersion" },
      ],
    });

    expect(locations.filter((location) => location.kind === "pdf")).toHaveLength(2);
    expect(locations[0]).toMatchObject({
      source: "unpaywall",
      isOpenAccess: true,
      license: "cc-by",
    });
  });

  it("requires an honest contact email and sends it only as the API parameter", async () => {
    expect(isValidContactEmail("researcher@example.org")).toBe(true);
    expect(isValidContactEmail("not-an-email")).toBe(false);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ is_oa: false, oa_locations: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      findUnpaywallLocations("10.1000/example", "researcher@example.org", fetchMock as typeof fetch),
    ).resolves.toEqual([]);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/v2/10.1000%2Fexample");
    expect(url.searchParams.get("email")).toBe("researcher@example.org");
  });

  it("treats a missing DOI record as no OA locations", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(
      findUnpaywallLocations("10.1000/missing", "r@example.org", fetchMock as typeof fetch),
    ).resolves.toEqual([]);
  });
});
