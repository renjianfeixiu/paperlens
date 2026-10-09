import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
} from "react";
import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfTextSelection, ReaderToolId } from "../domain/readerSelection";
import { readPdfTextContent } from "../services/pdfTextContent";
import { normalizeSelectedText } from "../domain/readerSelection";
import {
  attachBibliography,
  extractNumberedBibliography,
  extractPageCitations,
  pdfItemsToText,
  type CitationMention,
} from "../domain/citations";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import "./PdfReader.css";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type PdfReaderProps = {
  file: File | null;
  initialPage?: number;
  onChooseFile?: (file: File) => void;
  onReadingPositionChange?: (position: PdfReadingPosition) => void;
  onTextSelection?: (selection: PdfTextSelection | null) => void;
  onSelectionAction?: (tool: ReaderToolId, selection: PdfTextSelection) => void;
  onCitationsChange?: (citations: CitationMention[]) => void;
  onRequestChooseFile?: () => void;
  onClose?: () => void;
};

export type PdfReadingPosition = {
  currentPage: number;
  totalPages: number;
};

type LoadState = "empty" | "loading" | "ready" | "error";

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const SCALE_STEP = 0.1;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "PDF 文件无法读取，请确认文件完整后重试。";
}

export default function PdfReader({
  file,
  initialPage = 1,
  onChooseFile,
  onReadingPositionChange,
  onTextSelection,
  onSelectionAction,
  onCitationsChange,
  onRequestChooseFile,
  onClose,
}: PdfReaderProps): JSX.Element {
  const [activeFile, setActiveFile] = useState<File | null>(file);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [loadState, setLoadState] = useState<LoadState>(file ? "loading" : "empty");
  const [loadError, setLoadError] = useState("");
  const [renderError, setRenderError] = useState("");
  const [isRendering, setIsRendering] = useState(false);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [selection, setSelection] = useState<PdfTextSelection | null>(null);
  const [selectionPosition, setSelectionPosition] = useState({ left: 0, top: 0 });
  const [textLayerWarning, setTextLayerWarning] = useState("");
  const [pageText, setPageText] = useState("");
  const [bibliography, setBibliography] = useState<Record<number, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pageShellRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const discardPageDraftRef = useRef(false);
  const initialPageRef = useRef(initialPage);
  const readingPositionCallbackRef = useRef(onReadingPositionChange);
  const textSelectionCallbackRef = useRef(onTextSelection);
  const citationsCallbackRef = useRef(onCitationsChange);

  useEffect(() => {
    initialPageRef.current = initialPage;
  }, [initialPage]);

  useEffect(() => {
    readingPositionCallbackRef.current = onReadingPositionChange;
  }, [onReadingPositionChange]);

  useEffect(() => {
    textSelectionCallbackRef.current = onTextSelection;
  }, [onTextSelection]);

  useEffect(() => {
    citationsCallbackRef.current = onCitationsChange;
  }, [onCitationsChange]);

  useEffect(() => {
    setActiveFile(file);
  }, [file]);

  useEffect(() => {
    let isActive = true;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    setPdfDocument(null);
    setPageNumber(1);
    setPageDraft("1");
    setPageCount(0);
    setLoadError("");
    setRenderError("");
    setTextLayerWarning("");
    setPageText("");
    setBibliography({});
    setSelection(null);
    textSelectionCallbackRef.current?.(null);
    citationsCallbackRef.current?.([]);

    if (!activeFile) {
      setLoadState("empty");
      return () => {
        isActive = false;
      };
    }

    const fileToLoad = activeFile;
    setLoadState("loading");

    async function loadPdf() {
      try {
        const fileData = await fileToLoad.arrayBuffer();
        if (!isActive) return;

        loadingTask = getDocument({ data: new Uint8Array(fileData) });
        const loadedDocument = await loadingTask.promise;
        if (!isActive) return;

        const requestedPage = Number.isFinite(initialPageRef.current)
          ? Math.round(initialPageRef.current)
          : 1;
        const restoredPage = clamp(requestedPage, 1, loadedDocument.numPages);
        setPdfDocument(loadedDocument);
        setPageCount(loadedDocument.numPages);
        setPageNumber(restoredPage);
        setPageDraft(String(restoredPage));
        setLoadState("ready");

        // Read a few tail pages in the background. A missing/irregular list
        // stays unresolved rather than inventing reference metadata.
        const tailTexts: string[] = [];
        for (let pageIndex = Math.max(1, loadedDocument.numPages - 7);
          pageIndex <= loadedDocument.numPages; pageIndex += 1) {
          if (!isActive) return;
          try {
            const tailPage = await loadedDocument.getPage(pageIndex);
            const content = await readPdfTextContent(tailPage);
            tailTexts.push(pdfItemsToText(content.items));
          } catch {
            tailTexts.push("");
          }
        }
        if (isActive) setBibliography(extractNumberedBibliography(tailTexts));
      } catch (error) {
        if (!isActive) return;
        setLoadError(errorMessage(error));
        setLoadState("error");
      }
    }

    void loadPdf();

    return () => {
      isActive = false;
      if (loadingTask) {
        void loadingTask.destroy();
      }
    };
  }, [activeFile, reloadKey]);

  useEffect(() => {
    if (loadState !== "ready" || pageCount < 1) return;
    readingPositionCallbackRef.current?.({
      currentPage: pageNumber,
      totalPages: pageCount,
    });
  }, [loadState, pageCount, pageNumber]);

  useEffect(() => {
    if (loadState !== "ready" || !pageText) {
      citationsCallbackRef.current?.([]);
      return;
    }
    citationsCallbackRef.current?.(
      attachBibliography(extractPageCitations(pageText, pageNumber), bibliography),
    );
  }, [bibliography, loadState, pageNumber, pageText]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textLayerContainer = textLayerRef.current;
    if (!pdfDocument || !canvas || !textLayerContainer || loadState !== "ready") return;

    const documentToRender = pdfDocument;
    const canvasElement = canvas;
    const textLayerElement = textLayerContainer;

    let isActive = true;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;

    setIsRendering(true);
    setRenderError("");
    setTextLayerWarning("");
    setPageText("");
    setSelection(null);
    textSelectionCallbackRef.current?.(null);
    citationsCallbackRef.current?.([]);

    async function renderPage() {
      try {
        const page = await documentToRender.getPage(pageNumber);
        if (!isActive) return;

        const viewport = page.getViewport({ scale });
        const outputScale = clamp(window.devicePixelRatio || 1, 1, 2);

        canvasElement.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvasElement.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvasElement.style.width = `${Math.floor(viewport.width)}px`;
        canvasElement.style.height = `${Math.floor(viewport.height)}px`;
        canvasElement.setAttribute("aria-label", `PDF 第 ${pageNumber} 页`);
        textLayerElement.replaceChildren();
        textLayerElement.style.setProperty("--total-scale-factor", String(scale));
        textLayerElement.setAttribute("aria-label", `第 ${pageNumber} 页文本层`);

        renderTask = page.render({
          canvas: canvasElement,
          viewport,
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await renderTask.promise;
        if (!isActive) return;
        // Drawing is sufficient for reading. Text/selection failure must never
        // obscure a successfully rendered PDF with a full-page error overlay.
        setIsRendering(false);
        try {
          const textContent = await readPdfTextContent(page, {
            includeMarkedContent: true,
            disableNormalization: true,
          });
          if (!isActive) return;
          setPageText(pdfItemsToText(textContent.items));
          textLayer = new TextLayer({
            textContentSource: textContent,
            container: textLayerElement,
            viewport,
          });
          await textLayer.render();
        } catch {
          if (isActive) setTextLayerWarning("页面可正常阅读，但此页文字提取失败，暂时无法划词或识别引用。");
        }

        if (isActive) setIsRendering(false);
      } catch (error) {
        if (!isActive) return;
        setRenderError(errorMessage(error));
        setIsRendering(false);
      }
    }

    void renderPage();

    return () => {
      isActive = false;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [loadState, pageNumber, pdfDocument, scale]);

  useEffect(() => {
    setPageDraft(String(pageNumber));
  }, [pageNumber]);

  useEffect(() => {
    const area = scrollAreaRef.current;
    if (!area) return;
    area.scrollTop = 0;
    area.scrollLeft = 0;
  }, [pdfDocument, pageNumber]);

  const openFilePicker = () => {
    if (onRequestChooseFile) {
      onRequestChooseFile();
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!selectedFile) return;

    setActiveFile(selectedFile);
    onChooseFile?.(selectedFile);
  };

  const goToPage = (nextPage: number) => {
    if (!pageCount || !Number.isFinite(nextPage)) return;
    const destination = clamp(Math.round(nextPage), 1, pageCount);
    setPageNumber(destination);
    // The number may be unchanged after clamping; still reconcile the draft.
    setPageDraft(String(destination));
  };

  const commitPageDraft = (draft: string) => {
    const requestedPage = Number(draft);
    if (!draft.trim() || !Number.isFinite(requestedPage)) {
      setPageDraft(String(pageNumber));
      return;
    }

    goToPage(requestedPage);
  };

  const handlePageKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      commitPageDraft(event.currentTarget.value);
      event.currentTarget.blur();
    }

    if (event.key === "Escape") {
      event.preventDefault();
      // blur fires before React has committed the restored input value.
      discardPageDraftRef.current = true;
      setPageDraft(String(pageNumber));
      event.currentTarget.blur();
    }
  };

  const changeScale = (difference: number) => {
    setScale((currentScale) => {
      const nextScale = Math.round((currentScale + difference) * 10) / 10;
      return clamp(nextScale, MIN_SCALE, MAX_SCALE);
    });
  };

  const controlsDisabled = loadState !== "ready" || !pdfDocument;

  const captureTextSelection = () => {
    const nativeSelection = window.getSelection();
    const textLayer = textLayerRef.current;
    const pageShell = pageShellRef.current;
    if (!nativeSelection || nativeSelection.isCollapsed || nativeSelection.rangeCount < 1 || !textLayer || !pageShell) {
      return;
    }
    const range = nativeSelection.getRangeAt(0);
    if (!textLayer.contains(range.commonAncestorContainer)) return;

    const text = normalizeSelectedText(nativeSelection.toString());
    if (!text) return;
    const prefixRange = range.cloneRange();
    prefixRange.selectNodeContents(textLayer);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    const startOffset = normalizeSelectedText(prefixRange.toString()).length;
    const nextSelection: PdfTextSelection = {
      text,
      anchor: { pageNumber, startOffset, endOffset: startOffset + text.length },
    };
    const rangeRect = typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : pageShell.getBoundingClientRect();
    const shellRect = pageShell.getBoundingClientRect();
    setSelectionPosition({
      left: clamp(rangeRect.left - shellRect.left + rangeRect.width / 2, 120, shellRect.width - 120),
      top: Math.max(8, rangeRect.top - shellRect.top - 44),
    });
    setSelection(nextSelection);
    textSelectionCallbackRef.current?.(nextSelection);
  };

  const chooseSelectionTool = (tool: ReaderToolId) => {
    if (!selection) return;
    onSelectionAction?.(tool, selection);
  };

  return (
    <section className="pdf-reader" aria-label="PDF 阅读器">
      <input
        ref={fileInputRef}
        className="pdf-reader__file-input"
        type="file"
        accept="application/pdf,.pdf"
        aria-label="选择本地 PDF 文件"
        onChange={handleFileChange}
      />

      <header className="pdf-reader__toolbar">
        <div className="pdf-reader__document">
          <button
            className="pdf-reader__button pdf-reader__button--primary"
            type="button"
            onClick={openFilePicker}
          >
            打开 PDF
          </button>
          <div className="pdf-reader__file-meta">
            <span className="pdf-reader__file-name" title={activeFile?.name}>
              {activeFile?.name ?? "尚未选择文件"}
            </span>
            {activeFile && (
              <span className="pdf-reader__file-size">
                {(activeFile.size / 1024 / 1024).toFixed(1)} MB
              </span>
            )}
          </div>
        </div>

        <div className="pdf-reader__page-controls" aria-label="页面导航">
          <button
            className="pdf-reader__icon-button"
            type="button"
            aria-label="上一页"
            title="上一页"
            disabled={controlsDisabled || pageNumber <= 1}
            onClick={() => goToPage(pageNumber - 1)}
          >
            ‹
          </button>
          <label className="pdf-reader__page-field">
            <span className="pdf-reader__sr-only">页码</span>
            <input
              type="number"
              min={1}
              max={pageCount || 1}
              inputMode="numeric"
              value={pageDraft}
              disabled={controlsDisabled}
              onChange={(event) => setPageDraft(event.currentTarget.value)}
              onFocus={() => { discardPageDraftRef.current = false; }}
              onBlur={(event) => {
                if (discardPageDraftRef.current) {
                  discardPageDraftRef.current = false;
                  setPageDraft(String(pageNumber));
                  return;
                }
                commitPageDraft(event.currentTarget.value);
              }}
              onKeyDown={handlePageKeyDown}
            />
            <span aria-label={`共 ${pageCount} 页`}>/ {pageCount || "—"}</span>
          </label>
          <button
            className="pdf-reader__icon-button"
            type="button"
            aria-label="下一页"
            title="下一页"
            disabled={controlsDisabled || pageNumber >= pageCount}
            onClick={() => goToPage(pageNumber + 1)}
          >
            ›
          </button>
        </div>

        <div className="pdf-reader__zoom-controls" aria-label="缩放控制">
          <button
            className="pdf-reader__icon-button"
            type="button"
            aria-label="缩小"
            title="缩小"
            disabled={controlsDisabled || scale <= MIN_SCALE}
            onClick={() => changeScale(-SCALE_STEP)}
          >
            −
          </button>
          <button
            className="pdf-reader__zoom-value"
            type="button"
            title="恢复 100%"
            disabled={controlsDisabled}
            onClick={() => setScale(1)}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            className="pdf-reader__icon-button"
            type="button"
            aria-label="放大"
            title="放大"
            disabled={controlsDisabled || scale >= MAX_SCALE}
            onClick={() => changeScale(SCALE_STEP)}
          >
            +
          </button>
        </div>

        {onClose && (
          <button
            className="pdf-reader__icon-button pdf-reader__close"
            type="button"
            aria-label="关闭阅读器"
            title="关闭阅读器"
            onClick={onClose}
          >
            ×
          </button>
        )}
      </header>

      <div className="pdf-reader__stage">
        {loadState === "empty" && (
          <div className="pdf-reader__message pdf-reader__empty">
            <span className="pdf-reader__empty-icon" aria-hidden="true">
              PDF
            </span>
            <h2>打开一篇论文开始阅读</h2>
            <p>文件只在本地打开，不会自动上传。</p>
            <button
              className="pdf-reader__button pdf-reader__button--primary"
              type="button"
              onClick={openFilePicker}
            >
              选择本地 PDF
            </button>
          </div>
        )}

        {loadState === "loading" && (
          <div className="pdf-reader__message" role="status" aria-live="polite">
            <span className="pdf-reader__spinner" aria-hidden="true" />
            <h2>正在打开 PDF</h2>
            <p>正在解析页面和字体…</p>
          </div>
        )}

        {loadState === "error" && (
          <div className="pdf-reader__message pdf-reader__error" role="alert">
            <span className="pdf-reader__error-mark" aria-hidden="true">
              !
            </span>
            <h2>无法打开这份 PDF</h2>
            <p>{loadError}</p>
            <div className="pdf-reader__message-actions">
              <button
                className="pdf-reader__button"
                type="button"
                onClick={() => setReloadKey((key) => key + 1)}
              >
                重试
              </button>
              <button
                className="pdf-reader__button pdf-reader__button--primary"
                type="button"
                onClick={openFilePicker}
              >
                选择其他文件
              </button>
            </div>
          </div>
        )}

        {loadState === "ready" && (
          <div ref={scrollAreaRef} className="pdf-reader__scroll-area">
            <div
              ref={pageShellRef}
              className="pdf-reader__page-shell"
              onMouseUp={captureTextSelection}
            >
              <canvas ref={canvasRef} className="pdf-reader__canvas" />
              <div ref={textLayerRef} className="textLayer pdf-reader__text-layer" />
              {selection && (
                <div
                  className="pdf-reader__selection-tools"
                  style={{ left: selectionPosition.left, top: selectionPosition.top }}
                  aria-label="选区操作"
                  onMouseDown={(event) => event.preventDefault()}
                >
                  <button type="button" onClick={() => chooseSelectionTool("translation")}>翻译</button>
                  <button type="button" onClick={() => chooseSelectionTool("concept")}>解释</button>
                  <button type="button" onClick={() => chooseSelectionTool("formula")}>公式</button>
                </div>
              )}
              {textLayerWarning && <div className="pdf-reader__text-warning">{textLayerWarning}</div>}
              {isRendering && (
                <div className="pdf-reader__rendering" role="status">
                  <span className="pdf-reader__spinner" aria-hidden="true" />
                  <span>正在渲染第 {pageNumber} 页…</span>
                </div>
              )}
              {renderError && (
                <div className="pdf-reader__render-error" role="alert">
                  <strong>此页渲染失败</strong>
                  <span>{renderError}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
