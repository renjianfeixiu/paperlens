import {
  type DragEvent,
  type FormEvent,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Bookmark,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  FilePlus2,
  FileText,
  Home,
  Languages,
  LibraryBig,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  Network,
  NotebookPen,
  Search,
  Settings2,
  Sigma,
  Sparkles,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CitationMention } from "./domain/citations";
import {
  deduplicateAccessLocations,
  openAccessPdfLocations,
} from "./domain/access";
import { deduplicatePapers, mergePapers } from "./domain/deduplicatePapers";
import { filterPapers, type PaperFilter } from "./domain/filterPapers";
import { explainFormulaStructure } from "./domain/formulaExplanation";
import type { Paper } from "./domain/paper";
import { hasCommandModifier, shortcutModifier } from "./domain/platform";
import type {
  PaperRelationKind,
  PaperRelations,
} from "./domain/paperRelations";
import {
  selectionEvidenceLabel,
  type PdfTextSelection,
  type ReaderToolId,
} from "./domain/readerSelection";
import {
  lookupChineseConcept,
  type ConceptResult,
} from "./services/conceptLookup";
import { getOpenAlexPaperRelations } from "./services/openAlexRelations";
import {
  searchPapers,
  type AcademicSearchProgress,
  type AcademicSearchResult,
} from "./services/search";
import {
  MAX_TRANSLATION_CHARACTERS,
  translateEnglishToChinese,
} from "./services/translation";
import {
  findRecentBrowserPdf,
  importBrowserPdfCandidate,
  institutionAccessUrl,
  resolveTrustedLandingPage,
  type BrowserPdfCandidate,
} from "./services/acquisitionBridge";
import { resolveFullTextLocations } from "./services/fullTextResolver";
import { listJournalPapers, searchJournals, type Journal } from "./services/journalBrowse";
import {
  getDailyRecommendations,
  type DailyRecommendation,
} from "./services/dailyRecommendations";
import {
  isTauriEnvironment,
  loadLocalPdf,
  persistNativePdf,
  selectNativePdf,
} from "./services/nativeFiles";
import {
  downloadRemotePdf,
  RemotePdfError,
} from "./services/remotePdf";
import {
  addPaper,
  attachLocalPdf,
  isSamePaper,
  loadLibrary,
  persistLibrary,
  removePaper as removeLibraryPaper,
  updateReadingState,
  type LibraryItem,
  type LibraryState,
} from "./store/library";
import "./App.css";
import { downloadPdfFromLocations, PdfSourcesExhaustedError } from "./services/pdfDownloadCandidates";

type View = "home" | "discover" | "journals" | "library" | "notes" | "reader";
type ReaderTool = ReaderToolId | "citations";
type SearchOptions = { page?: number; filters?: PaperFilter[]; value?: string };
type DownloadState =
  | { status: "downloading"; locationUrl: string; attempt: number; total: number }
  | { status: "failed"; locationUrl: string; message: string; failures?: { url: string; message: string }[] };

const INSTITUTION_ACCESS_KEY = "paperlens.institution-access-template";
const APP_UNPAYWALL_CONTACT_EMAIL = import.meta.env.VITE_UNPAYWALL_CONTACT_EMAIL?.trim();

const PdfReader = lazy(() => import("./components/PdfReader"));

const recommendationAccents = [
  "linear-gradient(145deg, #dfe7ff, #aebeff)",
  "linear-gradient(145deg, #dff3ea, #aadac8)",
  "linear-gradient(145deg, #f7e8d7, #efcda7)",
];

const topics = ["大语言模型推理", "时间序列预测", "因果推断", "强化学习", "计算机视觉"];

const navItems: Array<{
  id: Exclude<View, "reader">;
  label: string;
  shortcut?: string;
  icon: typeof Home;
}> = [
  { id: "home", label: "首页", shortcut: `${shortcutModifier()}1`, icon: Home },
  { id: "discover", label: "发现", shortcut: `${shortcutModifier()}2`, icon: Search },
  { id: "journals", label: "期刊", icon: BookOpen },
  { id: "library", label: "资料库", shortcut: `${shortcutModifier()}3`, icon: LibraryBig },
  { id: "notes", label: "笔记", icon: NotebookPen },
];

function formatAuthors(authors: string[]) {
  if (authors.length === 0) return "作者未知";
  if (authors.length <= 3) return authors.join("、");
  return `${authors.slice(0, 3).join("、")} 等`;
}

function paperIdentity(paper: Paper) {
  return paper.doi ?? paper.id;
}

function paperPdfLocations(paper: Paper) {
  const legacy = paper.openAccessUrl && paper.isOpenAccess
    ? [{
        url: paper.openAccessUrl,
        kind: "pdf" as const,
        source: paper.source,
        isOpenAccess: true,
        license: null,
        version: null,
      }]
    : [];
  return openAccessPdfLocations([...(paper.accessLocations ?? []), ...legacy])
    .filter((location) => location.url.startsWith("https://"));
}

function directOpenAccessPdf(paper: Paper) {
  return paperPdfLocations(paper)[0];
}

function openAccessLandingPage(paper: Paper) {
  return paper.accessLocations?.find(
    (location) =>
      location.isOpenAccess &&
      location.kind === "landing-page" &&
      /^https?:\/\//.test(location.url),
  );
}

function accessVersionLabel(version: string | null) {
  switch (version?.toLowerCase()) {
    case "publishedversion":
      return "出版版本";
    case "acceptedversion":
      return "作者接收稿";
    case "submittedversion":
      return "预印本";
    default:
      return version || "版本未标注";
  }
}

function accessLicenseLabel(license: string | null) {
  if (!license) return "许可信息未标注";

  try {
    const url = new URL(license);
    if (url.hostname.endsWith("creativecommons.org")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const licenseIndex = parts.indexOf("licenses");
      if (licenseIndex >= 0 && parts[licenseIndex + 1]) {
        return `CC ${parts[licenseIndex + 1].toUpperCase()} ${parts[licenseIndex + 2] ?? ""}`.trim();
      }
      return "Creative Commons";
    }
  } catch {
    // Some indexes return short license identifiers instead of URLs.
  }

  return license.length <= 36 ? license : "许可信息已标注";
}

function accessHostLabel(url: string, hostName?: string) {
  if (hostName) return hostName;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "论文来源";
  }
}

function downloadErrorMessage(error: unknown) {
  if (error instanceof RemotePdfError) {
    if (error.code === "http-status" && [401, 403].includes(error.httpStatus ?? 0)) {
      return "该网站需要登录、机构权限或人工验证。请在浏览器完成访问后，再把 PDF 导入 PaperLens。";
    }
    if (error.code === "http-status" && error.httpStatus === 404) {
      return "论文网站上的 PDF 地址已失效。可以打开来源页面寻找新的开放版本。";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "下载 PDF 失败，请稍后重试。";
}

function sourceLabel(source: Paper["source"]) {
  switch (source) {
    case "openalex":
      return "OpenAlex";
    case "crossref":
      return "Crossref";
    case "semantic-scholar":
      return "Semantic Scholar";
    case "arxiv":
      return "arXiv（DataCite）";
    case "local":
      return "本机";
    case "unpaywall":
      return "Unpaywall";
    case "core":
      return "CORE";
    case "europe-pmc":
      return "Europe PMC";
    case "publisher-metadata":
      return "出版方元数据";
    case "institution":
      return "学校访问";
  }
}

function matchReasonLabel(reason: NonNullable<Paper["matchReasons"]>[number]) {
  switch (reason) {
    case "exact-identifier": return "标识符一致";
    case "exact-title": return "标题完全一致";
    case "title": return "标题命中";
    case "abstract": return "摘要命中";
    case "semantic": return "语义相关";
    case "bibliographic": return "书目信息相关";
  }
}

function localPaperFromFile(file: File, localFilePath?: string): Paper {
  return {
    id: localFilePath ?? `${file.name}:${file.size}:${file.lastModified}`,
    title: file.name,
    authors: [],
    year: null,
    venue: "本地 PDF",
    citedByCount: 0,
    isOpenAccess: false,
    source: "local",
  };
}

function App() {
  const [view, setView] = useState<View>("home");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<Paper[]>([]);
  const [selectedPaper, setSelectedPaper] = useState<Paper | null>(null);
  const [library, setLibrary] = useState<LibraryState>(() => loadLibrary());
  const [openedFile, setOpenedFile] = useState<File | null>(null);
  const [openedPaperId, setOpenedPaperId] = useState<string | null>(null);
  const [readerTool, setReaderTool] = useState<ReaderTool>("translation");
  const [readerSelection, setReaderSelection] = useState<PdfTextSelection | null>(null);
  const [pageCitations, setPageCitations] = useState<CitationMention[]>([]);
  const [dailyRecommendations, setDailyRecommendations] = useState<DailyRecommendation[]>([]);
  const [recommendationsState, setRecommendationsState] = useState<"loading" | "ready" | "error">("loading");
  const [journalQuery, setJournalQuery] = useState("");
  const [journalList, setJournalList] = useState<Journal[] | null>(null);
  const [selectedJournal, setSelectedJournal] = useState<Journal | null>(null);
  const [journalPapers, setJournalPapers] = useState<Paper[]>([]);
  const [journalPage, setJournalPage] = useState(1);
  const [journalHasMore, setJournalHasMore] = useState(false);
  const [journalLoading, setJournalLoading] = useState(false);
  const [journalPapersLoading, setJournalPapersLoading] = useState(false);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [translationState, setTranslationState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "done"; text: string }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [conceptState, setConceptState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "done"; result: ConceptResult }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isImportingPdf, setIsImportingPdf] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchProgress, setSearchProgress] = useState<AcademicSearchProgress | null>(null);
  const [searchStopped, setSearchStopped] = useState(false);
  const [searchPage, setSearchPage] = useState(1);
  const [hasMoreResults, setHasMoreResults] = useState(false);
  const [searchInterpretation, setSearchInterpretation] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchWarnings, setSearchWarnings] = useState<string[]>([]);
  const [paperFilters, setPaperFilters] = useState<PaperFilter[]>([]);
  const [paperRelations, setPaperRelations] = useState<PaperRelations | null>(null);
  const [relationTab, setRelationTab] = useState<PaperRelationKind>("recommendations");
  const [isLoadingRelations, setIsLoadingRelations] = useState(false);
  const [relationsError, setRelationsError] = useState<string | null>(null);
  const [downloadStates, setDownloadStates] = useState<Record<string, DownloadState>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [institutionAccessTemplate, setInstitutionAccessTemplate] = useState(() =>
    window.localStorage.getItem(INSTITUTION_ACCESS_KEY) ?? "",
  );
  const [institutionAccessDraft, setInstitutionAccessDraft] = useState(institutionAccessTemplate);
  const [fullTextLookupState, setFullTextLookupState] = useState<"idle" | "loading" | "done">("idle");
  const [fullTextSources, setFullTextSources] = useState<string[]>([]);
  const [fullTextWarnings, setFullTextWarnings] = useState<string[]>([]);
  const [browserImportState, setBrowserImportState] = useState<
    | { status: "waiting"; paperId: string }
    | { status: "candidate"; paperId: string; candidate: BrowserPdfCandidate }
    | { status: "importing"; paperId: string; candidate: BrowserPdfCandidate }
    | { status: "failed"; paperId: string; message: string }
    | null
  >(null);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRequestIdRef = useRef(0);
  const searchControllerRef = useRef<AbortController | null>(null);
  const searchRetryRef = useRef<SearchOptions>({});
  const manualPaperSelectionRef = useRef(false);
  const relationsRequestIdRef = useRef(0);
  const fullTextRequestIdRef = useRef(0);
  const browserImportSessionRef = useRef(0);
  const journalRequestIdRef = useRef(0);
  const journalPapersRequestIdRef = useRef(0);
  const translationRequestIdRef = useRef(0);
  const conceptRequestIdRef = useRef(0);
  const recommendationsRequestIdRef = useRef(0);
  const importTargetPaperRef = useRef<Paper | null>(null);
  const downloadsInFlightRef = useRef(new Set<string>());
  const selectedPaperRef = useRef<Paper | null>(selectedPaper);
  const libraryRef = useRef(library);
  const savedPapers = useMemo(
    () => library.items.map((item) => item.paper),
    [library.items],
  );
  const recommendationSignature = library.items
    .map((item) => paperIdentity(item.paper)).join("|");
  const visibleResults = useMemo(
    () => filterPapers(results, paperFilters),
    [paperFilters, results],
  );
  const savedPaperCount = useMemo(
    () => library.items.filter((item) => !item.localFilePath).length,
    [library.items],
  );
  const localPdfCount = useMemo(
    () => library.items.filter((item) => Boolean(item.localFilePath)).length,
    [library.items],
  );
  const recentLocalItem = useMemo(
    () =>
      library.items
        .filter((item) => item.localFilePath)
        .reduce<LibraryItem | undefined>((latest, item) => {
          if (!latest) return item;
          const itemTime = Date.parse(item.reading.lastReadAt ?? item.addedAt);
          const latestTime = Date.parse(latest.reading.lastReadAt ?? latest.addedAt);
          return itemTime >= latestTime ? item : latest;
        }, undefined),
    [library.items],
  );
  const openedLibraryItem = useMemo(
    () => library.items.find((item) => item.paper.id === openedPaperId),
    [library.items, openedPaperId],
  );
  const selectedLibraryItem = useMemo(
    () =>
      selectedPaper
        ? library.items.find((item) => isSamePaper(item.paper, selectedPaper))
        : undefined,
    [library.items, selectedPaper],
  );
  const selectedDirectPdf = selectedPaper
    ? directOpenAccessPdf(selectedPaper)
    : undefined;
  const selectedPdfCandidates = selectedPaper
    ? paperPdfLocations(selectedPaper)
    : [];
  const selectedLandingPage = selectedPaper
    ? openAccessLandingPage(selectedPaper)
    : undefined;
  const selectedDownloadState = selectedPaper
    ? downloadStates[paperIdentity(selectedPaper)]
    : undefined;
  const selectedBrowserImportState = selectedPaper &&
    browserImportState?.paperId === paperIdentity(selectedPaper)
    ? browserImportState
    : null;
  const formulaExplanation = useMemo(
    () => readerSelection ? explainFormulaStructure(readerSelection.text) : null,
    [readerSelection],
  );

  const updateReaderSelection = (selection: PdfTextSelection | null) => {
    translationRequestIdRef.current += 1;
    conceptRequestIdRef.current += 1;
    setReaderSelection(selection);
    setTranslationState({ status: "idle" });
    setConceptState({ status: "idle" });
  };

  const chooseReaderTool = (tool: ReaderTool, selection: PdfTextSelection) => {
    updateReaderSelection(selection);
    setReaderTool(tool);
  };

  const translateReaderSelection = async () => {
    if (!readerSelection) return;
    const requestId = ++translationRequestIdRef.current;
    setTranslationState({ status: "loading" });
    try {
      const text = await translateEnglishToChinese(readerSelection.text);
      if (requestId !== translationRequestIdRef.current) return;
      setTranslationState({ status: "done", text });
    } catch (error) {
      if (requestId !== translationRequestIdRef.current) return;
      setTranslationState({
        status: "error",
        message: error instanceof Error ? error.message : "翻译失败，请稍后重试。",
      });
    }
  };

  const lookupReaderConcept = async () => {
    if (!readerSelection) return;
    const requestId = ++conceptRequestIdRef.current;
    setConceptState({ status: "loading" });
    try {
      const result = await lookupChineseConcept(readerSelection.text);
      if (requestId !== conceptRequestIdRef.current) return;
      setConceptState({ status: "done", result });
    } catch (error) {
      if (requestId !== conceptRequestIdRef.current) return;
      setConceptState({
        status: "error",
        message: error instanceof Error ? error.message : "概念查询失败，请稍后重试。",
      });
    }
  };
  const selectedAccessLocation = selectedDirectPdf ?? selectedLandingPage;
  const continueItem = openedLibraryItem ?? recentLocalItem;
  const continueProgress = Math.round((continueItem?.reading.progress ?? 0) * 100);

  const today = useMemo(
    () =>
      new Intl.DateTimeFormat("zh-CN", {
        month: "long",
        day: "numeric",
        weekday: "long",
      }).format(new Date()),
    [],
  );

  useEffect(() => {
    libraryRef.current = library;
    persistLibrary(library);
  }, [library]);

  useEffect(() => {
    let active = true;
    const requestId = ++recommendationsRequestIdRef.current;
    setRecommendationsState("loading");
    void getDailyRecommendations(savedPapers)
      .then((items) => {
        if (!active || requestId !== recommendationsRequestIdRef.current) return;
        setDailyRecommendations(items);
        setRecommendationsState("ready");
      })
      .catch(() => {
        if (active && requestId === recommendationsRequestIdRef.current) setRecommendationsState("error");
      });
    return () => { active = false; };
  }, [recommendationSignature]);

  useEffect(() => {
    if (view !== "journals" || journalList !== null) return;
    void runJournalSearch("");
  }, [view, journalList]);

  selectedPaperRef.current = selectedPaper;

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => () => {
    searchRequestIdRef.current += 1;
    searchControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (
      selectedPaper &&
      (manualPaperSelectionRef.current
        ? visibleResults.some((paper) => isSamePaper(paper, selectedPaper))
        : visibleResults[0] && isSamePaper(visibleResults[0], selectedPaper))
    ) {
      return;
    }
    setSelectedPaper(visibleResults[0] ?? null);
  }, [selectedPaper, visibleResults]);

  useEffect(() => {
    relationsRequestIdRef.current += 1;
    setPaperRelations(null);
    setRelationsError(null);
    setIsLoadingRelations(false);
    setRelationTab("recommendations");
  }, [selectedPaper?.id]);

  useEffect(() => {
    const paper = selectedPaper;
    setFullTextWarnings([]);
    if (!paper) {
      setFullTextLookupState("idle");
      setFullTextSources([]);
      return;
    }

    const requestId = ++fullTextRequestIdRef.current;
    setFullTextLookupState("loading");
    setFullTextSources([]);
    void resolveFullTextLocations(paper, {
      unpaywallContactEmail: APP_UNPAYWALL_CONTACT_EMAIL,
    })
      .then(async (resolved) => {
        if (fullTextRequestIdRef.current !== requestId) return;
        const initialLocations = deduplicateAccessLocations([
          ...(paper.accessLocations ?? []),
          ...resolved.locations,
        ]);
        const metadataResults = isTauriEnvironment()
          ? await Promise.allSettled(
              initialLocations
                .filter((location) => location.kind === "landing-page" && location.isOpenAccess)
                .slice(0, 3)
                .map((location) => resolveTrustedLandingPage(location)),
            )
          : [];
        if (fullTextRequestIdRef.current !== requestId) return;
        const metadataLocations = metadataResults.flatMap((result) =>
          result.status === "fulfilled" ? result.value : [],
        );
        const locations = deduplicateAccessLocations([
          ...initialLocations,
          ...metadataLocations,
        ]);
        const enriched = mergePapers(paper, {
          ...paper,
          isOpenAccess: paper.isOpenAccess || locations.some((location) => location.isOpenAccess),
          accessLocations: locations,
        });
        setResults((current) => current.map((candidate) =>
          isSamePaper(candidate, paper) ? mergePapers(candidate, enriched) : candidate
        ));
        setSelectedPaper((current) => current && isSamePaper(current, paper)
          ? mergePapers(current, enriched)
          : current);
        setFullTextSources([
          ...resolved.sources,
          ...(metadataLocations.length > 0 ? ["出版方元数据"] : []),
        ]);
        setFullTextWarnings([
          ...resolved.warnings,
          ...(metadataResults.some((result) => result.status === "rejected")
            ? ["部分出版方页面解析失败，可尝试浏览器访问"] : []),
        ]);
        setFullTextLookupState("done");
      })
      .catch(() => {
        if (fullTextRequestIdRef.current === requestId) {
          setFullTextLookupState("done");
          setFullTextWarnings(["全文补查失败，不代表没有可下载版本"]);
        }
      });
    return () => {
      if (fullTextRequestIdRef.current === requestId) fullTextRequestIdRef.current += 1;
    };
  }, [selectedPaper?.id]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!hasCommandModifier(event)) return;

      if (event.key === "1") {
        event.preventDefault();
        setView("home");
      }
      if (event.key === "2") {
        event.preventDefault();
        setView("discover");
      }
      if (event.key === "3") {
        event.preventDefault();
        setView("library");
      }
      if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        setView("discover");
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void openPdfPicker();
      }
    };

    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  const isPaperSaved = (paper: Paper) =>
    savedPapers.some((candidate) => isSamePaper(candidate, paper));

  const savePaper = (paper: Paper) => {
    if (isPaperSaved(paper)) {
      setNotice("这篇论文已经在资料库中");
      return;
    }
    setLibrary((current) => addPaper(current, paper));
    setNotice("已保存到资料库");
  };

  const removePaper = (paper: Paper) => {
    setLibrary((current) => removeLibraryPaper(current, paper.id));
  };

  const runSearch = async (
    event?: FormEvent,
    options: SearchOptions = {},
  ) => {
    event?.preventDefault();
    const value = (options.value ?? query).trim();
    if (!value) {
      searchInputRef.current?.focus();
      return;
    }

    const page = options.page ?? 1;
    const filters = options.filters ?? paperFilters;
    const requestId = ++searchRequestIdRef.current;
    searchControllerRef.current?.abort();
    const controller = new AbortController();
    searchControllerRef.current = controller;
    searchRetryRef.current = { page, filters: [...filters], value };

    setView("discover");
    setIsSearching(page === 1);
    setIsLoadingMore(page > 1);
    setSearchProgress(null);
    setSearchStopped(false);
    setSearchError(null);
    setSubmittedQuery(value);
    if (page === 1) {
      manualPaperSelectionRef.current = false;
      setResults([]);
      setSelectedPaper(null);
      setSearchPage(1);
      setHasMoreResults(false);
      setSearchWarnings([]);
      setSearchInterpretation(null);
    }

    const isCurrent = () => searchRequestIdRef.current === requestId && !controller.signal.aborted;
    const displayResults = (outcome: AcademicSearchResult) => {
      if (!isCurrent()) return;
      setResults((current) => {
        // Retain full-text enrichment that may have arrived while another
        // search channel was still running. A new query clears current first.
        const enriched = outcome.papers.map((paper) => {
          const previous = current.find((item) => isSamePaper(item, paper));
          return previous ? mergePapers(previous, paper) : paper;
        });
        return page === 1 ? enriched : deduplicatePapers([...current, ...enriched]);
      });
      // A later, higher-ranked result must not steal the user's selection.
      setSelectedPaper((current) => {
        const updated = current && outcome.papers.find((paper) => isSamePaper(paper, current));
        return current && updated ? mergePapers(current, updated) : current;
      });
      setSearchWarnings(outcome.warnings);
      setSearchInterpretation(outcome.interpretation ?? null);
    };

    try {
      const outcome = await searchPapers(value, {
        page,
        signal: controller.signal,
        onProgress: (progress) => {
          if (!isCurrent()) return;
          displayResults(progress);
          setSearchProgress(progress);
        },
        filters: {
          recent: filters.includes("recent"),
          openAccess: filters.includes("open-access"),
        },
      });
      if (!isCurrent()) return;
      displayResults(outcome);
      setSearchPage(page);
      setHasMoreResults(outcome.hasMore);
      if (page === 1 && outcome.papers.length === 0) {
        setSearchError("没有找到结果，试试更短的关键词或 DOI。");
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (page === 1) {
        setResults([]);
        setSelectedPaper(null);
      }
      setSearchError(error instanceof Error ? error.message : "搜索暂时不可用，请稍后重试。");
    } finally {
      if (searchRequestIdRef.current === requestId) {
        setIsSearching(false);
        setIsLoadingMore(false);
        setSearchProgress(null);
        searchControllerRef.current = null;
      }
    }
  };

  const stopSearch = () => {
    searchRequestIdRef.current += 1;
    searchControllerRef.current?.abort();
    searchControllerRef.current = null;
    setIsSearching(false);
    setIsLoadingMore(false);
    setSearchProgress(null);
    setSearchStopped(true);
  };

  const chooseTopic = (topic: string) => {
    setQuery(topic);
    setView("discover");
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const resetDiscoveryNavigation = () => {
    manualPaperSelectionRef.current = true;
    searchRequestIdRef.current += 1;
    searchControllerRef.current?.abort();
    searchControllerRef.current = null;
    setIsSearching(false);
    setIsLoadingMore(false);
    setSearchProgress(null);
    setSearchStopped(false);
    setPaperFilters([]);
    setSearchWarnings([]);
    setSearchError(null);
    setHasMoreResults(false);
    setSubmittedQuery("");
    setView("discover");
  };

  const openRelatedPaper = (paper: Paper) => {
    resetDiscoveryNavigation();
    setResults((current) => [paper, ...current.filter((item) => !isSamePaper(item, paper))]);
    setSelectedPaper(paper);
    setSearchInterpretation("从引用关系打开的论文");
  };

  const showRecommendations = (paper?: Paper) => {
    const papers = dailyRecommendations.map((item) => item.paper);
    if (papers.length === 0) return;
    resetDiscoveryNavigation();
    setResults(papers);
    setSelectedPaper(paper ?? papers[0]);
    setSearchInterpretation("今日推荐 · 来自 OpenAlex 的真实近期论文");
  };

  const openJournalPaper = (paper: Paper) => {
    resetDiscoveryNavigation();
    setResults([paper]);
    setSelectedPaper(paper);
    setQuery(paper.title);
    setSearchInterpretation(`来自期刊「${selectedJournal?.name ?? "未知"}」`);
  };

  const loadJournalWorks = async (journal: Journal, page = 1) => {
    const requestId = ++journalPapersRequestIdRef.current;
    setJournalPapersLoading(true);
    setJournalError(null);
    if (page === 1) {
      setJournalPapers([]);
      setJournalPage(1);
      setJournalHasMore(false);
    }
    try {
      const result = await listJournalPapers(journal, page);
      if (journalPapersRequestIdRef.current !== requestId) return;
      setJournalPapers((current) => page === 1 ? result.papers : [...current, ...result.papers]);
      setJournalPage(page);
      setJournalHasMore(result.hasMore);
    } catch (error) {
      if (journalPapersRequestIdRef.current === requestId) {
        setJournalError(error instanceof Error ? error.message : "无法加载期刊论文。");
      }
    } finally {
      if (journalPapersRequestIdRef.current === requestId) setJournalPapersLoading(false);
    }
  };

  const runJournalSearch = async (value: string) => {
    const requestId = ++journalRequestIdRef.current;
    journalPapersRequestIdRef.current += 1;
    setJournalPapersLoading(false);
    setJournalHasMore(false);
    setJournalPage(1);
    setJournalLoading(true);
    setJournalError(null);
    setSelectedJournal(null);
    setJournalPapers([]);
    try {
      const journals = await searchJournals(value);
      if (journalRequestIdRef.current !== requestId) return;
      setJournalList(journals);
      const first = journals[0] ?? null;
      setSelectedJournal(first);
      if (first) void loadJournalWorks(first);
    } catch (error) {
      if (journalRequestIdRef.current === requestId) {
        setJournalList([]);
        setJournalError(error instanceof Error ? error.message : "期刊搜索失败。");
      }
    } finally {
      if (journalRequestIdRef.current === requestId) setJournalLoading(false);
    }
  };

  const refreshRecommendations = () => {
    const requestId = ++recommendationsRequestIdRef.current;
    setRecommendationsState("loading");
    void getDailyRecommendations(savedPapers)
      .then((items) => {
        if (requestId !== recommendationsRequestIdRef.current) return;
        setDailyRecommendations(items);
        setRecommendationsState("ready");
      })
      .catch(() => {
        if (requestId === recommendationsRequestIdRef.current) setRecommendationsState("error");
      });
  };

  const togglePaperFilter = (filter: PaperFilter) => {
    const next = paperFilters.includes(filter)
      ? paperFilters.filter((candidate) => candidate !== filter)
      : [...paperFilters, filter];
    setPaperFilters(next);
    if (submittedQuery && filter !== "review") {
      void runSearch(undefined, { filters: next, value: submittedQuery });
    }
  };

  const loadPaperRelations = async () => {
    if (!selectedPaper) return;

    const requestId = ++relationsRequestIdRef.current;
    setIsLoadingRelations(true);
    setRelationsError(null);

    try {
      const relations = await getOpenAlexPaperRelations(selectedPaper, {
        limits: { references: 8, citedBy: 8, recommendations: 8 },
      });
      if (relationsRequestIdRef.current !== requestId) return;
      setPaperRelations(relations);
    } catch (error) {
      if (relationsRequestIdRef.current !== requestId) return;
      setRelationsError(
        error instanceof Error ? error.message : "无法加载这篇论文的引用关系。",
      );
    } finally {
      if (relationsRequestIdRef.current === requestId) {
        setIsLoadingRelations(false);
      }
    }
  };

  const onFileChosen = (file: File, localFilePath?: string) => {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setNotice("请选择 PDF 文件");
      return;
    }
    const targetPaper = importTargetPaperRef.current;
    importTargetPaperRef.current = null;
    const paper = targetPaper ?? localPaperFromFile(file, localFilePath);
    setOpenedFile(file);
    setOpenedPaperId(paper.id);
    setLibrary((current) => {
      const next = targetPaper && localFilePath
        ? attachLocalPdf(current, targetPaper, localFilePath)
        : addPaper(current, paper, { localFilePath });
      return updateReadingState(next, paper.id, {
        status: "reading",
        lastReadAt: new Date().toISOString(),
      });
    });
    setView("reader");
  };

  const importPdfFile = async (file: File) => {
    if (!isTauriEnvironment()) {
      onFileChosen(file);
      return;
    }

    setIsImportingPdf(true);
    try {
      const imported = await persistNativePdf(file);
      onFileChosen(imported.file, imported.localFilePath);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法导入 PDF，请稍后重试");
    } finally {
      setIsImportingPdf(false);
    }
  };

  const handleFileInput = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void importPdfFile(file);
  };

  async function openPdfPicker(targetPaper?: Paper) {
    importTargetPaperRef.current = targetPaper ?? null;
    if (!isTauriEnvironment()) {
      filePickerRef.current?.click();
      return;
    }

    setIsImportingPdf(true);
    try {
      const imported = await selectNativePdf();
      if (imported) onFileChosen(imported.file, imported.localFilePath);
      else importTargetPaperRef.current = null;
    } catch (error) {
      importTargetPaperRef.current = null;
      setNotice(error instanceof Error ? error.message : "无法导入 PDF，请稍后重试");
    } finally {
      setIsImportingPdf(false);
    }
  }

  const openLibraryItem = async (item: LibraryItem) => {
    if (openedPaperId === item.paper.id && openedFile) {
      setView("reader");
      return;
    }
    if (!item.localFilePath) {
      setNotice("这份 PDF 需要重新导入后才能阅读");
      return;
    }

    setIsImportingPdf(true);
    try {
      const file = await loadLocalPdf(item.localFilePath);
      setOpenedFile(file);
      setOpenedPaperId(item.paper.id);
      setLibrary((current) =>
        updateReadingState(current, item.paper.id, {
          status: "reading",
          lastReadAt: new Date().toISOString(),
        }),
      );
      setView("reader");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法恢复这份 PDF");
    } finally {
      setIsImportingPdf(false);
    }
  };

  const handlePdfDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDraggingFile(false);
    handleFileInput(event.dataTransfer.files);
  };

  const openExternal = async (url: string) => {
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const openOfficialPaperPage = (paper: Paper) => {
    const url = paper.doi
      ? `https://doi.org/${paper.doi}`
      : paper.id.startsWith("url:")
        ? paper.id.slice(4)
        : paper.source === "openalex"
          ? `https://openalex.org/${paper.id}`
          : paper.openAccessUrl;
    if (url) void openExternal(url);
  };

  const attachDownloadedPdf = async (
    paper: Paper,
    downloaded: Awaited<ReturnType<typeof downloadRemotePdf>>,
  ) => {
    const file = await loadLocalPdf(downloaded.localFilePath);
    const currentLibrary = libraryRef.current;
    const matchingItem = currentLibrary.items.find((item) =>
      isSamePaper(item.paper, paper),
    );
    const storedPaperId = matchingItem?.paper.id ?? paper.id;
    const nextLibrary = updateReadingState(
      attachLocalPdf(currentLibrary, paper, downloaded.localFilePath),
      storedPaperId,
      { status: "reading", lastReadAt: new Date().toISOString() },
    );
    libraryRef.current = nextLibrary;
    setLibrary(nextLibrary);
    if (selectedPaperRef.current && isSamePaper(selectedPaperRef.current, paper)) {
      setOpenedFile(file);
      setOpenedPaperId(storedPaperId);
      setView("reader");
    } else {
      setNotice("PDF 已保存到资料库");
    }
  };

  const cancelBrowserImport = () => {
    browserImportSessionRef.current += 1;
    setBrowserImportState(null);
  };

  const confirmBrowserImport = async (paper: Paper, candidate: BrowserPdfCandidate) => {
    setBrowserImportState({ status: "importing", paperId: paperIdentity(paper), candidate });
    try {
      const imported = await importBrowserPdfCandidate(candidate, `${paper.title}.pdf`);
      await attachDownloadedPdf(paper, imported);
      setBrowserImportState(null);
      setNotice("浏览器下载的 PDF 已导入并关联此论文");
    } catch (error) {
      setBrowserImportState({
        status: "failed",
        paperId: paperIdentity(paper),
        message: error instanceof Error ? error.message : "浏览器 PDF 导入失败。",
      });
    }
  };

  const startBrowserDownloadImport = async (paper: Paper, viaInstitution = false) => {
    let targetUrl: string | undefined;
    if (viaInstitution) {
      targetUrl = institutionAccessUrl(institutionAccessTemplate, paper);
      if (!targetUrl) {
        setInstitutionAccessDraft(institutionAccessTemplate);
        setSettingsOpen(true);
        setNotice("请先配置学校代理或图书馆入口");
        return;
      }
    } else {
      targetUrl = openAccessLandingPage(paper)?.url
        ?? (paper.doi ? `https://doi.org/${paper.doi}` : undefined)
        ?? (paper.id.startsWith("url:") ? paper.id.slice(4) : undefined)
        ?? (paper.source === "openalex" ? `https://openalex.org/${paper.id}` : paper.openAccessUrl);
    }
    if (!targetUrl) {
      setNotice("这条记录没有可打开的论文页面");
      return;
    }

    const sessionId = ++browserImportSessionRef.current;
    const startedAtMs = Date.now();
    setBrowserImportState({ status: "waiting", paperId: paperIdentity(paper) });
    await openExternal(targetUrl);
    if (!isTauriEnvironment()) {
      setBrowserImportState({
        status: "failed",
        paperId: paperIdentity(paper),
        message: "浏览器预览无法监测下载目录，请下载后手动导入 PDF。",
      });
      return;
    }

    try {
      for (let attempt = 0; attempt < 45; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        if (browserImportSessionRef.current !== sessionId) return;
        const candidate = await findRecentBrowserPdf(startedAtMs);
        if (!candidate) continue;
        setBrowserImportState({ status: "candidate", paperId: paperIdentity(paper), candidate });
        return;
      }
      setBrowserImportState({
        status: "failed",
        paperId: paperIdentity(paper),
        message: "90 秒内未在下载文件夹发现新 PDF，可重试或手动导入。",
      });
    } catch (error) {
      setBrowserImportState({
        status: "failed",
        paperId: paperIdentity(paper),
        message: error instanceof Error ? error.message : "无法检查浏览器下载的 PDF。",
      });
    }
  };

  const downloadAndRead = async (paper: Paper, preferredUrl?: string) => {
    const existingItem = libraryRef.current.items.find((item) =>
      isSamePaper(item.paper, paper),
    );
    if (existingItem?.localFilePath) {
      await openLibraryItem(existingItem);
      return;
    }

    const candidates = paperPdfLocations(paper);
    const locations = preferredUrl
      ? [
          ...candidates.filter((location) => location.url === preferredUrl),
          ...candidates.filter((location) => location.url !== preferredUrl),
        ]
      : candidates;
    if (locations.length === 0) {
      const landingPage = openAccessLandingPage(paper);
      if (landingPage) await openExternal(landingPage.url);
      else openOfficialPaperPage(paper);
      return;
    }

    if (!isTauriEnvironment()) {
      await openExternal(locations[0].url);
      return;
    }

    const identity = paperIdentity(paper);
    if (downloadsInFlightRef.current.has(identity)) return;

    downloadsInFlightRef.current.add(identity);
    try {
      const downloaded = await downloadPdfFromLocations(locations, `${paper.title}.pdf`, {
        onAttempt: (location, attempt, total) => setDownloadStates((current) => ({
          ...current,
          [identity]: { status: "downloading", locationUrl: location.url, attempt, total },
        })),
      });
      await attachDownloadedPdf(paper, downloaded);
      setDownloadStates((current) => {
        const next = { ...current };
        delete next[identity];
        return next;
      });
    } catch (error) {
      setDownloadStates((current) => ({
        ...current,
        [identity]: {
          status: "failed",
          locationUrl: locations[0].url,
          message: downloadErrorMessage(error),
          ...(error instanceof PdfSourcesExhaustedError ? {
            failures: error.failures.map(({ location, error: cause }) => ({
              url: location.url, message: downloadErrorMessage(cause),
            })),
          } : {}),
        },
      }));
    } finally {
      downloadsInFlightRef.current.delete(identity);
    }
  };

  const shellTitle =
    view === "home"
      ? "首页"
      : view === "discover"
        ? "发现"
        : view === "journals"
          ? "期刊"
        : view === "library"
          ? "资料库"
          : view === "notes"
            ? "笔记"
            : openedFile?.name ?? "阅读器";

  const saveInstitutionSettings = () => {
    const value = institutionAccessDraft.trim();
    if (value && !institutionAccessUrl(value, { title: "Test paper", doi: "10.1000/test" })) {
      setNotice("请输入有效的 HTTPS 学校访问模板");
      return;
    }
    if (value) window.localStorage.setItem(INSTITUTION_ACCESS_KEY, value);
    else window.localStorage.removeItem(INSTITUTION_ACCESS_KEY);
    setInstitutionAccessTemplate(value);
    setSettingsOpen(false);
    setNotice(value ? "已保存学校访问入口" : "已清除学校访问入口");
  };

  return (
    <div className="app-shell">
      <input
        ref={filePickerRef}
        className="visually-hidden"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => {
          handleFileInput(event.target.files);
          event.currentTarget.value = "";
        }}
      />

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div>
              <p className="section-kicker">全文获取</p>
              <h2 id="settings-title">全文与学校访问</h2>
              <p>CORE 和 Europe PMC 会自动查询，不要求你填写 Unpaywall 邮箱。{APP_UNPAYWALL_CONTACT_EMAIL ? " 当前应用版本也已启用 Unpaywall。" : " 当前版本未配置 Unpaywall 的应用联系邮箱。"}</p>
            </div>
            <label>
              学校代理或图书馆入口（可选）
              <input
                type="url"
                value={institutionAccessDraft}
                placeholder="https://proxy.example.edu/login?url={url}"
                onChange={(event) => setInstitutionAccessDraft(event.target.value)}
              />
            </label>
            <p className="settings-help">支持 <code>{"{url}"}</code> 和 <code>{"{doi}"}</code>；如未写占位符，PaperLens 会添加 <code>url</code> 参数。该设置只保存在本机。</p>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => setSettingsOpen(false)}>取消</button>
              <button className="primary-button" type="button" onClick={saveInstitutionSettings}>保存</button>
            </div>
          </section>
        </div>
      )}

      <aside className="sidebar">
        <div className="window-drag-area" data-tauri-drag-region />
        <div className="brand">
          <img src="/paperlens-mark.svg" alt="" />
          <div>
            <strong>PaperLens</strong>
            <span>研究阅读器</span>
          </div>
        </div>

        <nav aria-label="主导航">
          <p className="nav-label">工作区</p>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${active ? "is-active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => setView(item.id)}
              >
                <Icon size={17} strokeWidth={1.8} />
                <span>{item.label}</span>
                {item.shortcut && <kbd>{item.shortcut}</kbd>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-collections">
          <p className="nav-label">收藏夹</p>
          <button type="button" className="collection-row" onClick={() => setView("library")}>
            <span className="collection-dot blue" />
            稍后阅读
            <span>{savedPaperCount}</span>
          </button>
          <button type="button" className="collection-row" onClick={() => setView("library")}>
            <span className="collection-dot green" />
            阅读中
            <span>{localPdfCount}</span>
          </button>
        </div>

        <div className="sidebar-bottom">
          <div className="privacy-chip">
            <LockKeyhole size={14} />
            <span>
              <strong>本地模式</strong>
              PDF 默认留在本机
            </span>
          </div>
          <button type="button" className="nav-item" aria-label="设置" onClick={() => {
            setInstitutionAccessDraft(institutionAccessTemplate);
            setSettingsOpen(true);
          }}>
            <Settings2 size={17} />
            <span>设置</span>
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar" data-tauri-drag-region>
          <div className="topbar-title">
            {view === "reader" && (
              <button
                className="icon-button"
                type="button"
                aria-label="返回资料库"
                onClick={() => setView("library")}
              >
                <ArrowLeft size={18} />
              </button>
            )}
            <h1>{shellTitle}</h1>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={isImportingPdf}
              onClick={() => void openPdfPicker()}
            >
              {isImportingPdf ? <LoaderCircle className="spin" size={16} /> : <FilePlus2 size={16} />}
              {isImportingPdf ? "正在导入" : "打开 PDF"}
            </button>
            <button className="icon-button" type="button" aria-label="更多操作">
              <MoreHorizontal size={18} />
            </button>
          </div>
        </header>

        {view === "home" && (
          <main className="page home-page">
            <section className="hero-row">
              <div>
                <p className="eyebrow">{today}</p>
                <h2>继续你的研究</h2>
                <p>从一篇论文开始，翻译、公式、概念和引用都留在原文旁边。</p>
              </div>
              <button className="primary-button" type="button" onClick={() => setView("discover")}>
                <Search size={17} />
                查找论文
              </button>
            </section>

            <section className="continue-panel">
              {openedFile || recentLocalItem ? (
                <button
                  className="continue-document"
                  type="button"
                  onClick={() => {
                    if (openedFile) setView("reader");
                    else if (recentLocalItem) void openLibraryItem(recentLocalItem);
                  }}
                >
                  <div className="document-cover">
                    <FileText size={30} />
                    <span>PDF</span>
                  </div>
                  <div className="continue-copy">
                    <span className="section-kicker">继续阅读</span>
                    <strong>{openedFile?.name ?? recentLocalItem?.paper.title}</strong>
                    <span>
                      {continueItem?.reading.currentPage && continueItem.reading.totalPages
                        ? `第 ${continueItem.reading.currentPage} / ${continueItem.reading.totalPages} 页 · ${continueProgress}%`
                        : openedFile
                          ? "本地文件 · 刚刚打开"
                          : "保存在本机 · 点击恢复"}
                    </span>
                    <div className="progress-track">
                      <span style={{ width: `${continueProgress}%` }} />
                    </div>
                  </div>
                  <ChevronRight size={20} />
                </button>
              ) : (
                <div
                  className={`drop-zone ${isDraggingFile ? "is-dragging" : ""}`}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setIsDraggingFile(true);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setIsDraggingFile(false);
                    }
                  }}
                  onDrop={handlePdfDrop}
                >
                  <div className="drop-icon">
                    <BookOpen size={24} />
                  </div>
                  <div>
                    <strong>开始你的第一篇阅读</strong>
                    <span>把 PDF 拖到这里，或从网上查找论文。</span>
                  </div>
                  <div className="drop-actions">
                    <button
                      className="primary-button compact"
                      type="button"
                      onClick={() => void openPdfPicker()}
                    >
                      打开 PDF
                    </button>
                    <button className="text-button" type="button" onClick={() => setView("discover")}>
                      去发现
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="section-kicker">为你精选</p>
                  <h3>今日推荐</h3>
                </div>
                <button type="button" className="text-button" onClick={() => showRecommendations()} disabled={dailyRecommendations.length === 0}>
                  查看全部 <ChevronRight size={15} />
                </button>
              </div>
              <div className="recommendation-list">
                {recommendationsState === "loading" && <p className="recommendation-status" role="status">正在从 OpenAlex 获取近期论文…</p>}
                {recommendationsState === "error" && (
                  <div className="recommendation-status" role="alert">每日推荐暂时不可用。<button type="button" onClick={refreshRecommendations}>重试</button></div>
                )}
                {recommendationsState === "ready" && dailyRecommendations.length === 0 && <p className="recommendation-status">当前没有符合条件的近期论文，稍后可再试。</p>}
                {recommendationsState === "ready" && dailyRecommendations.map(({ paper, reason }, index) => (
                  <article className="recommendation-row" key={paperIdentity(paper)}>
                    <div className="paper-index">{String(index + 1).padStart(2, "0")}</div>
                    <div className="paper-swatch" style={{ background: recommendationAccents[index % recommendationAccents.length] }}>
                      <FileText size={20} />
                    </div>
                    <div className="paper-copy">
                      <strong>{paper.title}</strong>
                      <span>
                        {formatAuthors(paper.authors)} · {paper.venue || "来源未知"} · {paper.year ?? "年份未知"}
                      </span>
                      <em>
                        <Sparkles size={13} /> {reason}
                      </em>
                    </div>
                    <span className="access-badge">{paper.isOpenAccess ? "开放全文" : "查看来源"}</span>
                    <button
                      type="button"
                      className="icon-button subtle"
                      aria-label={`查找 ${paper.title}`}
                      onClick={() => showRecommendations(paper)}
                    >
                      <ArrowUpRight size={17} />
                    </button>
                  </article>
                ))}
              </div>
            </section>

            <section className="section-block topic-section">
              <div className="section-heading">
                <div>
                  <p className="section-kicker">快速开始</p>
                  <h3>浏览研究主题</h3>
                </div>
              </div>
              <div className="topic-grid">
                {topics.map((topic, index) => (
                  <button type="button" key={topic} onClick={() => chooseTopic(topic)}>
                    <span>{["AI", "TS", "C", "RL", "CV"][index]}</span>
                    {topic}
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
            </section>
          </main>
        )}

        {view === "discover" && (
          <main className="discover-layout">
            <section className="discover-main">
              <form className="search-box" onSubmit={runSearch}>
                <Search size={18} />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="主题、标题、作者、DOI 或 arXiv ID；中文主题会补充英文术语…"
                  aria-label="搜索论文"
                />
                <button
                  className="search-submit"
                  type="submit"
                  aria-label="搜索"
                  disabled={!query.trim()}
                >
                  {isSearching && <LoaderCircle className="spin" size={14} />}
                  <span>搜索</span><kbd>↵</kbd>
                </button>
              </form>

              <div className="filter-bar" aria-label="筛选">
                <button
                  type="button"
                  className={`filter-chip ${paperFilters.length === 0 ? "is-selected" : ""}`}
                  aria-pressed={paperFilters.length === 0}
                  onClick={() => {
                    setPaperFilters([]);
                    if (submittedQuery) void runSearch(undefined, { filters: [], value: submittedQuery });
                  }}
                >
                  综合排序
                </button>
                <button
                  type="button"
                  className={`filter-chip ${paperFilters.includes("recent") ? "is-selected" : ""}`}
                  aria-pressed={paperFilters.includes("recent")}
                  onClick={() => togglePaperFilter("recent")}
                >
                  近 5 年
                </button>
                <button
                  type="button"
                  className={`filter-chip ${paperFilters.includes("open-access") ? "is-selected" : ""}`}
                  aria-pressed={paperFilters.includes("open-access")}
                  onClick={() => togglePaperFilter("open-access")}
                >
                  开放全文
                </button>
                <button
                  type="button"
                  className={`filter-chip ${paperFilters.includes("review") ? "is-selected" : ""}`}
                  aria-pressed={paperFilters.includes("review")}
                  onClick={() => togglePaperFilter("review")}
                >
                  综述
                </button>
              </div>

              <div className="results-header">
                <div>
                  <p className="section-kicker">ARXIV + OPENALEX + CROSSREF · 聚合检索</p>
                  <h2>{submittedQuery ? `“${submittedQuery}”` : "发现真实论文"}</h2>
                </div>
                {results.length > 0 && (
                  <span>
                    {visibleResults.length === results.length
                      ? `已加载 ${results.length} 条`
                      : `显示 ${visibleResults.length} / 已加载 ${results.length} 条`}
                  </span>
                )}
              </div>

              {searchInterpretation && submittedQuery && (
                <div className="search-interpretation" role="status">
                  <Sparkles size={14} />
                  <span>{searchInterpretation}</span>
                </div>
              )}

              {(isSearching || isLoadingMore) && (
                <div className="search-progress" aria-label="搜索进度">
                  <div role="status" aria-live="polite">
                    <LoaderCircle className="spin" size={15} aria-hidden="true" />
                    <span>
                      {results.length > 0 ? "已显示返回结果，可以先阅读。" : "正在检索论文…"}
                      {searchProgress && searchProgress.pendingSources.length > 0
                        ? ` 仍在等待 ${searchProgress.pendingSources.map(sourceLabel).join("、")}（${searchProgress.completed}/${searchProgress.total} 项检索完成）`
                        : " 可随时更换关键词。"}
                    </span>
                  </div>
                  <button type="button" onClick={stopSearch}>停止搜索</button>
                </div>
              )}

              {searchStopped && (
                <div className="inline-message search-stopped" role="status">
                  <span>已停止检索，已收到的结果会保留。尚未返回的渠道不代表没有结果。</span>
                  <button type="button" onClick={() => void runSearch(undefined, searchRetryRef.current)}>
                    {(searchRetryRef.current.page ?? 1) > 1 ? "重新加载此页" : "重新搜索"}
                  </button>
                </div>
              )}

              {searchError && (
                <div className="inline-message error-message" role="alert">
                  <CircleAlert size={18} />
                  <span>{searchError}</span>
                  <button type="button" onClick={() => void runSearch(undefined, searchRetryRef.current)}>重试</button>
                </div>
              )}

              {searchWarnings.length > 0 && !searchError && (
                <div className="inline-message warning-message" role="status">
                  <CircleAlert size={18} />
                  <span>{searchWarnings.join(" ")} 已保留成功返回的结果。</span>
                </div>
              )}

              {!query && results.length === 0 && !isSearching && (
                <div className="discover-empty">
                  <div className="empty-orbit"><Search size={28} /></div>
                  <h3>从一个研究问题开始</h3>
                  <p>结果来自学术索引，不会由 AI 编造论文。试试下面的主题：</p>
                  <div className="suggestion-row">
                    {topics.slice(0, 3).map((topic) => (
                      <button key={topic} type="button" onClick={() => chooseTopic(topic)}>
                        {topic}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {isSearching && results.length === 0 && (
                <div className="skeleton-list" aria-label="正在搜索">
                  {[1, 2, 3, 4].map((item) => (
                    <div className="result-skeleton" key={item}><span /><span /><span /></div>
                  ))}
                </div>
              )}

              {!isSearching && results.length > 0 && visibleResults.length === 0 && (
                <div className="discover-empty compact-empty">
                  <h3>没有符合当前筛选的论文</h3>
                  <p>可以关闭一个筛选条件，或恢复“综合排序”。</p>
                  <button type="button" onClick={() => {
                    setPaperFilters([]);
                    if (submittedQuery) void runSearch(undefined, { filters: [], value: submittedQuery });
                  }}>清除筛选</button>
                </div>
              )}

              <div className="result-list">
                {visibleResults.map((paper) => {
                  const active = selectedPaper ? isSamePaper(selectedPaper, paper) : false;
                  return (
                    <button
                      type="button"
                      key={paper.id}
                      className={`result-row ${active ? "is-active" : ""}`}
                      onClick={() => { manualPaperSelectionRef.current = true; setSelectedPaper(paper); }}
                    >
                      <div className="result-title-line">
                        <strong>{paper.title}</strong>
                        {paper.isOpenAccess && <span className="oa-dot">OA</span>}
                      </div>
                      <span className="result-meta">
                        {formatAuthors(paper.authors)} · {paper.venue || "来源未知"} · {paper.year ?? "年份未知"}
                      </span>
                      <p>
                        {paper.abstract
                          ? paper.abstract.slice(0, 170)
                          : "暂无摘要；可以打开来源页面查看出版方提供的信息。"}
                      </p>
                      <div className="result-foot">
                        <span>{paper.citedByCount.toLocaleString()} 次引用</span>
                        <span>来源：{sourceLabel(paper.source)}</span>
                        {paper.matchReasons?.slice(0, 2).map((reason) => (
                          <span className="match-reason" key={reason}>{matchReasonLabel(reason)}</span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
              {results.length > 0 && hasMoreResults && (
                <button
                  className="load-more-button"
                  type="button"
                  disabled={isLoadingMore || isSearching}
                  onClick={() => void runSearch(undefined, {
                    page: searchPage + 1,
                    value: submittedQuery,
                  })}
                >
                  {isLoadingMore ? <LoaderCircle className="spin" size={15} /> : null}
                  {isLoadingMore ? "正在加载" : "加载更多结果"}
                </button>
              )}
            </section>

            <aside className="paper-inspector" aria-label="论文详情">
              {selectedPaper ? (
                <>
                  <div className="inspector-scroll">
                    <div className="inspector-cover"><FileText size={26} /><span>{selectedPaper.year ?? "—"}</span></div>
                    <div className="inspector-title">
                      <span className={selectedPaper.isOpenAccess || selectedLibraryItem?.localFilePath ? "status success" : "status"}>
                        {selectedLibraryItem?.localFilePath ? (
                          <><Check size={13} /> 已下载到本机</>
                        ) : selectedDirectPdf ? (
                          <><Download size={13} /> 可直接下载{selectedPdfCandidates.length > 1 ? ` · ${selectedPdfCandidates.length} 个来源` : ""}</>
                        ) : selectedLandingPage ? (
                          <><Check size={13} /> 已发现开放版本页面</>
                        ) : selectedPaper.isOpenAccess ? (
                          <><Check size={13} /> 已发现开放版本</>
                        ) : fullTextLookupState === "loading" ? (
                          <><LoaderCircle className="spin" size={13} /> 正在补查开放全文</>
                        ) : (
                          "暂未发现开放全文"
                        )}
                      </span>
                      <h3>{selectedPaper.title}</h3>
                      <p>{formatAuthors(selectedPaper.authors)}</p>
                    </div>

                    <dl className="metadata-grid">
                      <div><dt>发表渠道</dt><dd>{selectedPaper.venue || "未知"}</dd></div>
                      <div><dt>年份</dt><dd>{selectedPaper.year ?? "未知"}</dd></div>
                      <div><dt>引用</dt><dd>{selectedPaper.citedByCount.toLocaleString()}</dd></div>
                      <div><dt>标识符</dt><dd>{selectedPaper.doi ?? selectedPaper.id}</dd></div>
                    </dl>

                    {(selectedLibraryItem?.localFilePath || selectedAccessLocation) && (
                      <section className="access-evidence" aria-label="全文访问方式">
                        <div className="access-evidence-icon">
                          {selectedLibraryItem?.localFilePath ? <Check size={15} /> : <Download size={15} />}
                        </div>
                        <div>
                          <strong>
                            {selectedLibraryItem?.localFilePath
                              ? "全文已保存在 PaperLens 资料库"
                              : selectedDirectPdf
                                ? `开放 PDF 可下载后离线阅读${selectedPdfCandidates.length > 1 ? `（${selectedPdfCandidates.length} 个候选，失败会自动切换）` : ""}`
                                : "开放版本需在来源网页获取"}
                          </strong>
                          {selectedAccessLocation && (
                            <span>
                              {accessHostLabel(selectedAccessLocation.url, selectedAccessLocation.hostName)}
                              {` · ${accessVersionLabel(selectedAccessLocation.version)}`}
                              {` · ${accessLicenseLabel(selectedAccessLocation.license)}`}
                            </span>
                          )}
                          <small>仅保存索引明确标记为开放的 PDF；网站权限仍由来源方决定。</small>
                        </div>
                      </section>
                    )}

                    {selectedPdfCandidates.length > 1 && !selectedLibraryItem?.localFilePath && (
                      <section className="inspector-section access-options" aria-label="可选开放 PDF 来源">
                        <h4>可选开放 PDF 来源</h4>
                        <p>选择一个优先下载；若失败，会继续尝试其他来源。</p>
                        <div>
                          {selectedPdfCandidates.map((location) => (
                            <button
                              key={location.url}
                              type="button"
                              disabled={selectedDownloadState?.status === "downloading"}
                              onClick={() => void downloadAndRead(selectedPaper, location.url)}
                              title={location.url}
                            >
                              <span><strong>{sourceLabel(location.source)}</strong> · {accessHostLabel(location.url, location.hostName)}</span>
                              <small>{accessVersionLabel(location.version)} · {accessLicenseLabel(location.license)}</small>
                              <Download size={14} aria-hidden="true" />
                            </button>
                          ))}
                        </div>
                      </section>
                    )}

                    {fullTextLookupState !== "idle" && (
                      <p className="fulltext-sources">
                        {fullTextLookupState === "loading"
                          ? "正在联合查询 CORE 和 Europe PMC…"
                          : `全文补查已完成${fullTextSources.length > 0 ? `：${fullTextSources.join("·")}` : ""}`}
                        {fullTextWarnings.length > 0 && <><br />{fullTextWarnings.join("；")}。可继续尝试官方页面或学校访问。</>}
                      </p>
                    )}

                    <section className="inspector-section">
                      <h4>摘要</h4>
                      <p>{selectedPaper.abstract ?? "当前索引未提供摘要。打开官方来源可以查看更完整的信息。"}</p>
                    </section>

                    <section className="inspector-section relation-section">
                      <div className="relation-heading">
                        <div>
                          <Network size={15} />
                          <h4>研究脉络</h4>
                        </div>
                        {paperRelations && (
                          <button
                            type="button"
                            className="relation-refresh"
                            disabled={isLoadingRelations}
                            onClick={() => void loadPaperRelations()}
                          >
                            刷新
                          </button>
                        )}
                      </div>

                      {!paperRelations && !isLoadingRelations && !relationsError && (
                        <div className="relation-intro">
                          <p>从引用与相似论文继续探索，关系数据来自 OpenAlex。</p>
                          {selectedPaper.source === "openalex" || selectedPaper.doi ? (
                            <button type="button" onClick={() => void loadPaperRelations()}>
                              加载引用与相关推荐
                            </button>
                          ) : (
                            <span>这条记录缺少 DOI 或 OpenAlex ID，暂时无法解析关系。</span>
                          )}
                        </div>
                      )}

                      {isLoadingRelations && (
                        <div className="relation-loading" role="status">
                          <LoaderCircle className="spin" size={15} /> 正在连接论文关系…
                        </div>
                      )}

                      {relationsError && !isLoadingRelations && (
                        <div className="relation-error" role="alert">
                          <span>{relationsError}</span>
                          <button type="button" onClick={() => void loadPaperRelations()}>重试</button>
                        </div>
                      )}

                      {paperRelations && !isLoadingRelations && (
                        <>
                          <div className="relation-tabs" role="tablist" aria-label="论文关系">
                            {([
                              ["recommendations", "相关推荐"],
                              ["citedBy", "后续工作"],
                              ["references", "参考文献"],
                            ] as const).map(([kind, label]) => (
                              <button
                                key={kind}
                                type="button"
                                role="tab"
                                aria-selected={relationTab === kind}
                                className={relationTab === kind ? "is-active" : ""}
                                onClick={() => setRelationTab(kind)}
                              >
                                {label}
                                <span>{paperRelations[kind].length}</span>
                              </button>
                            ))}
                          </div>

                          {paperRelations.warnings.length > 0 && (
                            <p className="relation-warning">
                              {paperRelations.warnings.map(({ message }) => message).join(" ")}
                            </p>
                          )}

                          <div className="relation-list">
                            {paperRelations[relationTab].length > 0 ? (
                              paperRelations[relationTab].map((paper) => (
                                <button
                                  key={paperIdentity(paper)}
                                  type="button"
                                  onClick={() => openRelatedPaper(paper)}
                                >
                                  <strong>{paper.title}</strong>
                                  <span>
                                    {paper.year ?? "年份未知"} · {paper.citedByCount.toLocaleString()} 次引用
                                    {paper.isOpenAccess ? " · OA" : ""}
                                  </span>
                                </button>
                              ))
                            ) : (
                              <p className="relation-empty">当前索引没有返回这一类论文。</p>
                            )}
                          </div>
                        </>
                      )}
                    </section>

                    <section className="trust-note">
                      <LockKeyhole size={16} />
                      <p><strong>来源透明</strong>元数据来自 {sourceLabel(selectedPaper.source)}；全文状态不等于转载许可，下载前会保留来源与版本。</p>
                    </section>
                  </div>

                  <div className="inspector-actions">
                    {selectedBrowserImportState?.status === "waiting" && (
                      <div className="download-error browser-import-status" role="status">
                        <LoaderCircle className="spin" size={16} />
                        <div>
                          <strong>等待浏览器下载</strong>
                          <span>在网页中完成登录和 PDF 下载。PaperLens 会在 90 秒内发现新 PDF，并请你核对文件名后关联到此论文。</span>
                          <div><button type="button" onClick={cancelBrowserImport}>取消监测</button></div>
                        </div>
                      </div>
                    )}
                    {selectedBrowserImportState?.status === "candidate" && (
                      <div className="download-error browser-import-status" role="status">
                        <FileText size={16} />
                        <div>
                          <strong>发现新下载的 PDF</strong>
                          <span>{selectedBrowserImportState.candidate.fileName} · {(selectedBrowserImportState.candidate.byteSize / 1024 / 1024).toFixed(1)} MB</span>
                          <span>请确认它就是「{selectedPaper.title}」。确认前不会复制或关联文件。</span>
                          <div>
                            <button type="button" onClick={() => void confirmBrowserImport(selectedPaper, selectedBrowserImportState.candidate)}>确认导入并阅读</button>
                            <button type="button" onClick={cancelBrowserImport}>不是这篇</button>
                          </div>
                        </div>
                      </div>
                    )}
                    {selectedBrowserImportState?.status === "importing" && (
                      <div className="download-error browser-import-status" role="status">
                        <LoaderCircle className="spin" size={16} />
                        <div><strong>正在导入 PDF</strong><span>{selectedBrowserImportState.candidate.fileName}</span></div>
                      </div>
                    )}
                    {selectedBrowserImportState?.status === "failed" && (
                      <div className="download-error" role="alert">
                        <CircleAlert size={16} />
                        <div>
                          <strong>未自动导入</strong>
                          <span>{selectedBrowserImportState.message}</span>
                          <div>
                            <button type="button" onClick={() => void startBrowserDownloadImport(selectedPaper)}>重试</button>
                            <button type="button" onClick={() => void openPdfPicker(selectedPaper)}>手动导入 PDF</button>
                          </div>
                        </div>
                      </div>
                    )}
                    {selectedDownloadState?.status === "failed" && (
                      <div className="download-error" role="alert">
                        <CircleAlert size={16} />
                        <div>
                          <strong>下载未完成</strong>
                          <span>{selectedDownloadState.message}</span>
                          {!!selectedDownloadState.failures?.length && (
                            <details className="download-failures">
                              <summary>查看各来源的失败原因</summary>
                              <ul>
                                {selectedDownloadState.failures.map((failure) => (
                                  <li key={failure.url}>
                                    <button type="button" onClick={() => void openExternal(failure.url)}>
                                      {accessHostLabel(failure.url)}
                                    </button>
                                    <span>{failure.message}</span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                          <div>
                            {selectedDirectPdf && (
                              <button type="button" onClick={() => void downloadAndRead(selectedPaper)}>
                                重试
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void openExternal(selectedDownloadState.locationUrl)}
                            >
                              在浏览器打开来源
                            </button>
                            <button type="button" onClick={() => void openPdfPicker(selectedPaper)}>
                              导入浏览器下载的 PDF
                            </button>
                            <button type="button" onClick={() => void startBrowserDownloadImport(selectedPaper)}>
                              浏览器获取并自动导入
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                    {selectedLibraryItem?.localFilePath ? (
                      <button
                        className="primary-button"
                        type="button"
                        disabled={isImportingPdf}
                        onClick={() => void openLibraryItem(selectedLibraryItem)}
                      >
                        {isImportingPdf ? <LoaderCircle className="spin" size={17} /> : <BookOpen size={17} />}
                        {isImportingPdf ? "正在打开" : "继续阅读"}
                      </button>
                    ) : selectedDirectPdf ? (
                      <button
                        className="primary-button"
                        type="button"
                        disabled={selectedDownloadState?.status === "downloading"}
                        onClick={() => void downloadAndRead(selectedPaper)}
                      >
                        {selectedDownloadState?.status === "downloading" ? (
                          <LoaderCircle className="spin" size={17} />
                        ) : (
                          <Download size={17} />
                        )}
                        {selectedDownloadState?.status === "downloading"
                          ? `正在下载 ${selectedDownloadState.attempt}/${selectedDownloadState.total}`
                          : "下载并阅读"}
                      </button>
                    ) : selectedLandingPage ? (
                      <button
                        className="primary-button"
                        type="button"
                        disabled={selectedBrowserImportState?.status === "waiting" || selectedBrowserImportState?.status === "importing"}
                        onClick={() => void startBrowserDownloadImport(selectedPaper)}
                      >
                        <ArrowUpRight size={17} />浏览器获取并自动导入
                      </button>
                    ) : selectedPaper.isOpenAccess ? (
                      <button className="primary-button" type="button" onClick={() => void startBrowserDownloadImport(selectedPaper)}>
                        <ArrowUpRight size={17} />浏览器获取并自动导入
                      </button>
                    ) : (
                      <button className="primary-button" type="button" onClick={() => void startBrowserDownloadImport(selectedPaper)}>
                        <ArrowUpRight size={17} />在浏览器尝试获取
                      </button>
                    )}
                    {!selectedLibraryItem?.localFilePath && (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={selectedBrowserImportState?.status === "waiting"}
                        onClick={() => void startBrowserDownloadImport(selectedPaper, true)}
                      >
                        <LibraryBig size={16} />通过学校访问
                      </button>
                    )}
                    <button className="secondary-button" type="button" onClick={() => savePaper(selectedPaper)}>
                      {isPaperSaved(selectedPaper) ? <Check size={16} /> : <Bookmark size={16} />}
                      {isPaperSaved(selectedPaper) ? "已在资料库" : "保存"}
                    </button>
                    <button className="text-button full-width" type="button" onClick={() => openOfficialPaperPage(selectedPaper)}>
                      打开官方页面 <ArrowUpRight size={15} />
                    </button>
                  </div>
                </>
              ) : (
                <div className="inspector-empty"><FileText size={26} /><p>选择一篇论文查看摘要、来源和全文状态。</p></div>
              )}
            </aside>
          </main>
        )}

        {view === "journals" && (
          <main className="page journals-page">
            <section className="page-heading-row">
              <div>
                <p className="eyebrow">按来源浏览</p>
                <h2>期刊</h2>
                <p>搜索期刊名称或 ISSN，浏览 OpenAlex 收录的近期文章；收录不等于全文开放。</p>
              </div>
            </section>
            <form className="journal-search" onSubmit={(event) => {
              event.preventDefault();
              void runJournalSearch(journalQuery);
            }}>
              <Search size={17} />
              <input
                value={journalQuery}
                onChange={(event) => setJournalQuery(event.target.value)}
                placeholder="例如 Nature Methods、The Lancet 或 ISSN"
                aria-label="搜索期刊"
              />
              <button className="primary-button compact" type="submit" disabled={journalLoading}>
                {journalLoading ? <LoaderCircle className="spin" size={15} /> : "搜索期刊"}
              </button>
            </form>
            {journalError && <p className="journal-error" role="alert">{journalError}</p>}
            <div className="journals-layout">
              <section className="journal-list" aria-label="期刊搜索结果">
                <h3>{journalQuery.trim() ? "搜索结果" : "热门期刊"}</h3>
                {journalLoading && <p className="journal-empty" role="status">正在加载期刊…</p>}
                {!journalLoading && journalList?.length === 0 && <p className="journal-empty">没有找到期刊，请试试完整名称或 ISSN。</p>}
                {journalList?.map((journal) => (
                  <button
                    key={journal.id}
                    type="button"
                    className={selectedJournal?.id === journal.id ? "is-active" : ""}
                    onClick={() => {
                      setSelectedJournal(journal);
                      void loadJournalWorks(journal);
                    }}
                  >
                    <strong>{journal.name}</strong>
                    <span>{journal.issn ? `ISSN ${journal.issn} · ` : ""}{journal.worksCount.toLocaleString()} 篇收录</span>
                    {journal.isOpenAccess && <small>开放获取期刊</small>}
                  </button>
                ))}
              </section>
              <section className="journal-works" aria-label="期刊论文">
                {selectedJournal ? (
                  <>
                    <div className="journal-works-heading">
                      <div><h3>{selectedJournal.name}</h3><span>按发表日期排序 · 来源 OpenAlex</span></div>
                      {selectedJournal.homepageUrl && (
                        <button type="button" onClick={() => void openExternal(selectedJournal.homepageUrl!)}>
                          期刊官网 <ArrowUpRight size={14} />
                        </button>
                      )}
                    </div>
                    {journalPapersLoading && journalPapers.length === 0 && <p className="journal-empty" role="status">正在加载论文…</p>}
                    {!journalPapersLoading && journalPapers.length === 0 && !journalError && <p className="journal-empty">当前索引没有返回这本期刊的文章。</p>}
                    <div className="journal-work-list">
                      {journalPapers.map((paper) => (
                        <button key={paperIdentity(paper)} type="button" onClick={() => openJournalPaper(paper)}>
                          <strong>{paper.title}</strong>
                          <span>{formatAuthors(paper.authors)} · {paper.year ?? "年份未知"} · {paper.citedByCount.toLocaleString()} 次引用</span>
                          <small>{paper.isOpenAccess ? "有开放版本" : "需查看来源权限"} <ChevronRight size={13} /></small>
                        </button>
                      ))}
                    </div>
                    {journalHasMore && (
                      <button className="load-more-button" type="button" disabled={journalPapersLoading} onClick={() => void loadJournalWorks(selectedJournal, journalPage + 1)}>
                        {journalPapersLoading ? "正在加载" : "加载更多论文"}
                      </button>
                    )}
                  </>
                ) : <p className="journal-empty">选择一本期刊查看文章。</p>}
              </section>
            </div>
          </main>
        )}

        {view === "library" && (
          <main className="page library-page">
            <section className="page-heading-row">
              <div>
                <p className="eyebrow">保存在本机</p>
                <h2>资料库</h2>
                <p>论文与阅读进度保存在本机；重启 PaperLens 后也能从上次页码继续。</p>
              </div>
              <button className="primary-button" type="button" onClick={() => void openPdfPicker()}>
                <FilePlus2 size={17} />导入 PDF
              </button>
            </section>

            {library.items.length === 0 ? (
              <div className="library-empty">
                <div className="empty-stack"><FileText size={30} /></div>
                <h3>资料库还是空的</h3>
                <p>拖入 PDF，或从“发现”保存论文。</p>
                <div>
                  <button className="primary-button" type="button" onClick={() => void openPdfPicker()}>导入 PDF</button>
                  <button className="secondary-button" type="button" onClick={() => setView("discover")}>查找论文</button>
                </div>
              </div>
            ) : (
              <div className="library-table-wrap">
                <table className="library-table">
                  <thead><tr><th>标题</th><th>作者</th><th>年份</th><th>来源</th><th>状态</th><th aria-label="操作" /></tr></thead>
                  <tbody>
                    {library.items.map((item) => {
                      const hasLocalPdf = Boolean(item.localFilePath);
                      return (
                        <tr
                          key={paperIdentity(item.paper)}
                          onDoubleClick={() => {
                            if (hasLocalPdf) void openLibraryItem(item);
                          }}
                        >
                          <td><span className="file-title"><FileText size={16} /> {item.paper.title}</span></td>
                          <td>{item.paper.source === "local" ? "本地导入" : formatAuthors(item.paper.authors)}</td>
                          <td>{item.paper.year ?? "—"}</td>
                          <td>{item.paper.source === "local" ? "本机" : item.paper.venue || "未知"}</td>
                          <td>
                            {hasLocalPdf ? (
                              <span className="reading-status">
                                <Clock3 size={13} />
                                {item.reading.progress >= 1
                                  ? "已读完"
                                  : item.reading.currentPage > 0
                                    ? `第 ${item.reading.currentPage} 页 · ${Math.round(item.reading.progress * 100)}%`
                                    : "待读"}
                              </span>
                            ) : (
                              <span className="saved-status"><Bookmark size={13} /> 稍后阅读</span>
                            )}
                          </td>
                          <td>
                            {hasLocalPdf ? (
                              <button className="icon-button subtle" type="button" onClick={() => void openLibraryItem(item)} aria-label={`打开 ${item.paper.title}`}><ChevronRight size={16} /></button>
                            ) : (
                              <button className="icon-button subtle" type="button" aria-label={`移除 ${item.paper.title}`} onClick={() => removePaper(item.paper)}><MoreHorizontal size={16} /></button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="table-hint">双击已下载 PDF 继续阅读 · 论文元数据与文件都保存在本机</p>
              </div>
            )}
          </main>
        )}

        {view === "notes" && (
          <main className="page notes-page">
            <section className="page-heading-row">
              <div>
                <p className="eyebrow">证据可追溯</p>
                <h2>笔记</h2>
                <p>后续将在这里汇总高亮、公式卡片、概念解释和论文笔记。</p>
              </div>
            </section>
            <div className="notes-preview-grid">
              <article><Languages size={20} /><strong>双语摘录</strong><p>中文译文始终保留原句与页码锚点。</p></article>
              <article><Sigma size={20} /><strong>公式卡片</strong><p>从一句直觉逐步展开到符号和推导。</p></article>
              <article><BookOpen size={20} /><strong>论文笔记</strong><p>把来自多页、多篇论文的证据组织到一起。</p></article>
            </div>
          </main>
        )}

        {view === "reader" && (
          <main className="reader-workspace">
            <section className="reader-document" aria-label="论文页面">
              <Suspense
                fallback={(
                  <div className="reader-loading" role="status">
                    <LoaderCircle className="spin" size={22} />
                    正在载入 PDF 引擎…
                  </div>
                )}
              >
                <PdfReader
                  file={openedFile}
                  initialPage={openedLibraryItem?.reading.currentPage || 1}
                  onTextSelection={updateReaderSelection}
                  onSelectionAction={chooseReaderTool}
                  onCitationsChange={setPageCitations}
                  onChooseFile={(file) => void importPdfFile(file)}
                  onReadingPositionChange={({ currentPage, totalPages }) => {
                    if (!openedPaperId) return;
                    setLibrary((current) =>
                      updateReadingState(current, openedPaperId, {
                        currentPage,
                        totalPages,
                      }),
                    );
                  }}
                  onRequestChooseFile={() => void openPdfPicker()}
                  onClose={() => setView("library")}
                />
              </Suspense>
            </section>

            <aside className="reader-assistant" aria-label="阅读助手">
              <header>
                <div>
                  <p className="section-kicker">上下文助手</p>
                  <h2>读懂这一页</h2>
                </div>
                <span className="preview-badge">原文锚定</span>
              </header>

              <div className="reader-tool-tabs" role="tablist" aria-label="阅读辅助工具">
                {([
                  ["translation", "翻译", Languages],
                  ["formula", "公式", Sigma],
                  ["concept", "概念", BookOpen],
                  ["citations", "引用", Network],
                ] as const).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={readerTool === id}
                    className={readerTool === id ? "is-active" : ""}
                    onClick={() => setReaderTool(id)}
                  >
                    <Icon size={15} />
                    {label}
                  </button>
                ))}
              </div>

              <div className="reader-tool-content">
                {!readerSelection && readerTool !== "citations" && (
                  <section className="assistant-callout">
                    <BookOpen size={18} />
                    <div>
                      <strong>先在 PDF 中选择原文</strong>
                      <p>选区上方会出现“翻译、解释、公式”，结果会绑定当前页码和字符范围。</p>
                    </div>
                  </section>
                )}

                {readerTool === "translation" && readerSelection && (
                  <>
                    <section className="assistant-callout">
                      <Languages size={18} />
                      <div>
                        <strong>准备翻译真实选区</strong>
                        <p>只有点击下方按钮后，最多 {MAX_TRANSLATION_CHARACTERS} 个字符会发送到 MyMemory；PDF 文件不会上传。</p>
                      </div>
                    </section>
                    <section className="translation-preview">
                      <div className="assistant-card-label"><span>选中原文</span><span>{selectionEvidenceLabel(readerSelection)}</span></div>
                      <p lang="en">{readerSelection.text}</p>
                    </section>
                    {translationState.status === "idle" && (
                      <button className="assistant-primary-action" type="button" onClick={() => void translateReaderSelection()}>
                        同意发送选区并翻译
                      </button>
                    )}
                    {translationState.status === "loading" && (
                      <div className="assistant-progress" role="status"><LoaderCircle className="spin" size={15} />正在翻译选区…</div>
                    )}
                    {translationState.status === "error" && (
                      <div className="assistant-error" role="alert"><CircleAlert size={15} /><span>{translationState.message}</span><button type="button" onClick={() => void translateReaderSelection()}>重试</button></div>
                    )}
                    {translationState.status === "done" && (
                      <section className="translation-preview translated">
                        <div className="assistant-card-label"><span>中文译文</span><span>MyMemory</span></div>
                        <p>{translationState.text}</p>
                      </section>
                    )}
                  </>
                )}

                {readerTool === "formula" && readerSelection && formulaExplanation && (
                  <>
                    <section className="formula-preview">
                      <div className="assistant-card-label"><span>选中公式</span><span>{selectionEvidenceLabel(readerSelection)}</span></div>
                      <p className="formula-line">{readerSelection.text}</p>
                    </section>
                    <ol className="explanation-steps">
                      <li><span>1</span><p><strong>一句话直觉</strong>{formulaExplanation.intuition}</p></li>
                      {formulaExplanation.observations.map((observation, index) => (
                        <li key={observation}><span>{index + 2}</span><p><strong>结构提示</strong>{observation}</p></li>
                      ))}
                    </ol>
                    <section className="symbol-card">
                      <div className="assistant-card-label"><span>待结合本文确认的符号</span><span>{formulaExplanation.symbols.length}</span></div>
                      <div>{formulaExplanation.symbols.length > 0 ? formulaExplanation.symbols.map((symbol) => <code key={symbol}>{symbol}</code>) : <span>未识别到独立符号</span>}</div>
                    </section>
                    <p className="assistant-disclaimer">这是结构分析，不会凭空断言变量含义；请结合公式前后的定义核对。</p>
                  </>
                )}

                {readerTool === "concept" && readerSelection && (
                  <>
                    <section className="concept-preview">
                      <div className="assistant-card-label"><span>选中概念</span><span>{selectionEvidenceLabel(readerSelection)}</span></div>
                      <h3>{readerSelection.text}</h3>
                        <p>用简短的话解释“这是什么”。部分常见词可离线查询；其他词仅将选中文字发送到百科，英文摘要可能交给翻译服务，不上传 PDF 或周围正文。</p>
                    </section>
                    {conceptState.status === "idle" && <button className="assistant-primary-action" type="button" onClick={() => void lookupReaderConcept()}>查询中文概念解释</button>}
                    {conceptState.status === "loading" && <div className="assistant-progress" role="status"><LoaderCircle className="spin" size={15} />正在查询概念来源…</div>}
                    {conceptState.status === "error" && <div className="assistant-error" role="alert"><CircleAlert size={15} /><span>{conceptState.message}</span><button type="button" onClick={() => void lookupReaderConcept()}>重试</button></div>}
                    {conceptState.status === "done" && (
                      <section className="concept-preview concept-result">
                        <div className="assistant-card-label"><span>这是什么</span><span>{conceptState.result.sourceLabel}</span></div>
                        <h3>{conceptState.result.title}</h3>
                        <p>{conceptState.result.summary}</p>
                        <button type="button" className="source-link" onClick={() => void openExternal(conceptState.result.sourceUrl)}>查看来源 <ArrowUpRight size={13} /></button>
                        {conceptState.result.notice && <p className="assistant-disclaimer">{conceptState.result.notice}</p>}
                        {!!conceptState.result.alternatives?.length && <details>
                          <summary>其他含义或相关词条（{conceptState.result.alternatives.length}）</summary>
                          {conceptState.result.alternatives.map((meaning) => <section key={meaning.sourceUrl}>
                            <h4>{meaning.title}</h4><p>{meaning.summary}</p>
                            <button type="button" className="source-link" onClick={() => void openExternal(meaning.sourceUrl)}>{meaning.sourceLabel} <ArrowUpRight size={13} /></button>
                          </section>)}
                        </details>}
                      </section>
                    )}
                  </>
                )}

                {readerTool === "citations" && (
                  <section className="citation-panel">
                    <div className="assistant-card-label"><span>本页引用线索</span><span>{pageCitations.length} 处</span></div>
                    <p className="citation-disclaimer">仅从当前 PDF 文本识别显式引用标记；条目与引用意图必须结合原文核对，不会臆测“为何引用”。</p>
                    {pageCitations.length === 0 ? (
                      <div className="assistant-callout">
                        <Network size={18} />
                        <div><strong>本页未识别到引用标记</strong><p>扫描件、特殊排版或未使用数字/作者年份格式的论文可能无法识别。</p></div>
                      </div>
                    ) : pageCitations.map((citation) => (
                      <article className="citation-card" key={citation.id}>
                        <div className="assistant-card-label"><strong>{citation.label}</strong><span>第 {citation.pageNumber} 页</span></div>
                        <p>{citation.context}</p>
                        {citation.references.length > 0 ? (
                          <div className="citation-references">
                            {citation.references.map((reference) => (
                              <div key={reference}>
                                <span>{reference}</span>
                                <button
                                  type="button"
                                  onClick={() => void openExternal(`https://scholar.google.com/scholar?q=${encodeURIComponent(reference)}`)}
                                >
                                  查找文献 <ArrowUpRight size={12} />
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <small>暂未能可靠对应到文末书目条目。</small>
                        )}
                      </article>
                    ))}
                  </section>
                )}
              </div>

              <footer>
                <LockKeyhole size={14} />
                <span>选区和页码保留在本机；只有你确认的文字会发送给对应服务。</span>
              </footer>
            </aside>
          </main>
        )}
      </section>

      {notice && <div className="toast" role="status"><Check size={16} /> {notice}</div>}
    </div>
  );
}

export default App;
