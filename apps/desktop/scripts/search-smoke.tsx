import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";

// Real React + request adapters + system WebKit. Only upstream responses are
// controlled here; this separate entry is never shipped with the application.
const report = (value: unknown) => window.webkit.messageHandlers.result.postMessage(JSON.stringify(value));
const errors: string[] = [];
const parameters = new URLSearchParams(location.search);
const isLive = parameters.has("live");
const liveQuery = parameters.get("query") ?? "attention";
const liveResponses: unknown[] = [];
const liveFetch = window.fetch.bind(window);
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const waiting = new Map<string, { signal?: AbortSignal | null; finish: (response: Response) => void }>();
const calls: Array<{ source: string; query: string; page: number }> = [];
let failNextPage = true;
const titles = { first: "Research result returned first", selected: "Paper selected while search is running", top: "Later result ranked above the selection", second: "Result from the second page", next: "Results for the new search", stop: "Partial result retained after stopping" };
const crossrefWork = (title: string, id: string) => ({
  DOI: `10.5555/${id}`, title: [title], author: [{ given: "Ada", family: "Lovelace" }],
  published: { "date-parts": [[2026]] }, "container-title": ["Search regression fixture"], type: "journal-article",
});
const openAlexWork = (title: string, id: string) => ({
  id: `https://openalex.org/W-${id}`, doi: `https://doi.org/10.5555/${id}`, display_name: title,
  publication_year: 2026, authorships: [{ author: { display_name: "Ada Lovelace" } }],
  primary_location: { source: { display_name: "Search regression fixture" } }, type: "article",
});
const alexResponse = () => json({ results: [openAlexWork(titles.top, "top"), openAlexWork(titles.selected, "selected")], meta: { count: 100 } });

window.fetch = async (input, init) => {
  if (isLive) {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    if (parameters.has("block-openalex") && requestUrl.hostname === "api.openalex.org") return new Response("Controlled OpenAlex outage", { status: 429 });
    const response = await liveFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (["api.openalex.org", "api.crossref.org"].includes(url.hostname)) {
      const data = await response.clone().json().catch(() => null);
      const works = data?.results ?? data?.message?.items ?? [];
      liveResponses.push({ url: url.href, status: response.status, total: data?.meta?.count ?? data?.message?.["total-results"],
        matches: works.filter((work: any) => String(work.display_name ?? work.title?.[0] ?? "").toLowerCase() === liveQuery.toLowerCase())
          .map((work: any) => ({ id: work.id ?? work.DOI, title: work.display_name ?? work.title,
            year: work.publication_year ?? work.published, venue: work.primary_location?.source?.display_name ?? work.publisher,
            type: work.type, locations: work.locations ?? work.resource, doi: work.doi ?? work.DOI })) });
    }
    return response;
  }
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.datacite.org") return json({ data: [], meta: { total: 0 } });
  const source = url.hostname === "api.openalex.org" ? "openalex" : url.hostname === "api.crossref.org" ? "crossref" : "other";
  const query = url.searchParams.get("search") ?? url.searchParams.get("query.bibliographic") ?? "";
  const page = source === "openalex" ? Number(url.searchParams.get("page") ?? 1)
    : Number(url.searchParams.get("offset") ?? 0) / Number(url.searchParams.get("rows") ?? 35) + 1;
  if (!query.startsWith("smoke")) {
    if (source === "openalex") return json({ results: [], meta: { count: 0 } });
    if (url.hostname === "api.core.ac.uk") return json({ results: [], totalHits: 0 });
    if (url.hostname === "www.ebi.ac.uk") return json({ hitCount: 0, resultList: { result: [] } });
    throw new Error(`Unexpected smoke-test URL: ${url.origin}${url.pathname}`);
  }
  calls.push({ source, query, page });
  if (page === 2) {
    if (failNextPage) throw new TypeError("Controlled second-page connection failure");
    return source === "openalex"
      ? json({ results: [openAlexWork(titles.second, "second")], meta: { count: 51 } })
      : json({ message: { items: [], "total-results": 50 } });
  }
  if (source === "openalex" && query !== "smoke-new") {
    // Deliberately ignore abort, exercising both actual signal propagation and
    // protection against an already-queued response arriving after cancellation.
    return new Promise<Response>((finish) => waiting.set(query, { signal: init?.signal, finish }));
  }
  const items = query === "smoke"
    ? [crossrefWork(titles.first, "first"), crossrefWork(titles.selected, "selected")]
    : [crossrefWork(query === "smoke-new" ? titles.next : titles.stop, query)];
  return source === "openalex"
    ? json({ results: [], meta: { count: 0 } })
    : json({ message: { items, "total-results": query === "smoke" ? 100 : 1 } });
};

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
async function waitFor(test: () => boolean, label: string) {
  const deadline = Date.now() + 18_000;
  while (!test()) {
    if (errors.length) throw new Error(errors.join("; "));
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
function button(text: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.getAttribute("aria-label") === text || item.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
const busy = () => !!document.querySelector(".search-progress");
const selectedTitle = () => document.querySelector(".inspector-title h3")?.textContent;
const hasResult = (title: string) => [...document.querySelectorAll(".result-row strong")].some((item) => item.textContent === title);
function fillSearch(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索论文"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function search(value: string) {
  fillSearch(value);
  await waitFor(() => !button("搜索").disabled, "enabled search button");
  button("搜索").click();
  await waitFor(() => document.querySelector(".results-header h2")?.textContent?.includes(value) ?? false, "submitted query rendered");
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function run() {
  await waitFor(() => !!document.querySelector(".nav-item"), "app mount");
  [...document.querySelectorAll<HTMLButtonElement>(".nav-item")].find((item) => item.textContent?.startsWith("发现"))!.click();
  await waitFor(() => !!document.querySelector('input[aria-label="搜索论文"]'), "discovery");
  if (isLive) {
    const started = performance.now();
    await search(liveQuery);
    await waitFor(() => document.querySelectorAll(".result-row").length > 0 || !busy(), "live search response");
    const firstResultMs = Math.round(performance.now() - started);
    const resultsBeforeCompletion = busy() && document.querySelectorAll(".result-row").length > 0;
    await waitFor(() => !busy(), "live search completion");
    const count = document.querySelectorAll(".result-row").length;
    const rows = [...document.querySelectorAll<HTMLButtonElement>(".result-row")];
    const expectedTitle = parameters.get("expect-title") ?? liveQuery;
    const exact = rows.find((row) => row.querySelector("strong")?.textContent?.toLowerCase() === expectedTitle.toLowerCase());
    const automaticSelection = selectedTitle();
    if (parameters.has("expect-exact")) check(automaticSelection?.toLowerCase() === expectedTitle.toLowerCase(), "Default detail panel is not showing the exact paper");
    if (exact) {
      exact.click();
      await waitFor(() => selectedTitle()?.toLowerCase() === expectedTitle.toLowerCase(), "selected exact result");
    }
    report({ checkpoint: "live search evidence", query: liveQuery, count, automaticSelection, selectedTitle: selectedTitle(),
      rows: rows.slice(0, 8).map((row) => row.textContent), responses: liveResponses,
      inspector: document.querySelector(".paper-inspector")?.textContent });
    check(count > 0, document.querySelector(".error-message")?.textContent ?? "Live search returned no results");
    if (parameters.has("expect-exact")) check(exact, "Exact original title is absent from the search results");
    if (parameters.has("expect-year")) check(exact?.textContent?.includes(`· ${parameters.get("expect-year")}`), "Original publication year is missing or replaced by a later copy");
    if (parameters.has("expect-doi")) {
      check(document.querySelector(".paper-inspector")?.textContent?.includes(parameters.get("expect-doi")!), "Original DOI is missing from the detail panel");
      check(button("下载并阅读"), "Original paper has no direct PDF download action");
    }
    check(errors.length === 0, errors.join("; "));
    report({ done: true, ok: true, mode: "live", query: liveQuery, firstResultMs,
      completionMs: Math.round(performance.now() - started), resultsBeforeCompletion, count,
      titles: [...document.querySelectorAll(".result-row strong")].slice(0, 3).map((item) => item.textContent),
      warnings: document.querySelector(".warning-message")?.textContent ?? null });
    return;
  }
  await search("smoke");
  await waitFor(() => hasResult(titles.selected) && busy(), "fast results before slow source");
  report({ checkpoint: "partial results visible while OpenAlex is pending", results: document.querySelectorAll(".result-row").length });
  [...document.querySelectorAll<HTMLButtonElement>(".result-row")].find((item) => item.textContent?.includes(titles.selected))!.click();
  waiting.get("smoke")!.finish(alexResponse());
  await waitFor(() => !busy() && hasResult(titles.top), "late source merged");
  check(selectedTitle() === titles.selected, "Late higher-ranked result changed selection");

  button("加载更多结果").click();
  await waitFor(() => !!document.querySelector(".error-message") && !busy(), "second-page failure");
  fillSearch("unsubmitted draft");
  failNextPage = false;
  button("重试").click();
  await waitFor(() => hasResult(titles.second) && !busy(), "second-page retry");
  check(hasResult(titles.first), "Retry discarded the first page");
  check(calls.filter((call) => call.query === "smoke" && call.page === 2).length === 4, "Retry did not target the same page and query");

  await search("smoke-stale");
  await waitFor(() => hasResult(titles.stop) && busy(), "old search in progress");
  await search("smoke-new");
  await waitFor(() => hasResult(titles.next) && !busy(), "replacement search");
  check(waiting.get("smoke-stale")?.signal?.aborted, "Replacement did not abort the old request");
  waiting.get("smoke-stale")!.finish(alexResponse());
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(!hasResult(titles.top) && selectedTitle() === titles.next, "Stale request overwrote the new query");

  await search("smoke-stop");
  await waitFor(() => hasResult(titles.stop) && busy(), "cancelable partial results");
  button("停止搜索").click();
  await waitFor(() => !busy(), "stopped search");
  check(waiting.get("smoke-stop")?.signal?.aborted, "Stop did not abort the provider signal");
  waiting.get("smoke-stop")!.finish(alexResponse());
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(hasResult(titles.stop) && !hasResult(titles.top), "Stopped search changed its retained results");
  check(!document.querySelector(".error-message"), "Cancellation was shown as an error");
  check(document.documentElement.scrollWidth <= window.innerWidth, "App overflows the test window horizontally");
  check(errors.length === 0, errors.join("; "));
  report({ done: true, ok: true, userAgent: navigator.userAgent, checks: ["partial results", "stable selection", "page retry", "superseding query", "cancel keeps results", "no horizontal overflow"], network: "controlled fixtures; no user data" });
}
void run().catch((error) => report({ done: true, ok: false, error: String(error), stack: error.stack }));
