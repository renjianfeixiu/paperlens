// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import PdfReader from "./PdfReader";

const pdfMocks = vi.hoisted(() => {
  const cancel = vi.fn();
  const renderPage = vi.fn(() => ({
    promise: Promise.resolve(),
    cancel,
  }));
  const getViewport = vi.fn(({ scale }: { scale: number }) => ({
    width: 600 * scale,
    height: 800 * scale,
  }));
  const getTextContent = vi.fn(async () => ({
    items: [{ str: "This method builds on prior work [2].", hasEOL: true }],
    styles: {}, lang: null,
  }));
  const textLayerRender = vi.fn(async () => undefined);
  const textLayerCancel = vi.fn();
  class TextLayer {
    private readonly container: HTMLElement;

    constructor({ container }: { container: HTMLElement }) {
      this.container = container;
    }

    render = async () => {
      const span = document.createElement("span");
      span.textContent = "Attention selects relevant context";
      this.container.append(span);
      await textLayerRender();
    };
    cancel = textLayerCancel;
  }
  const getPage = vi.fn(async () => ({
    getViewport,
    getTextContent,
    streamTextContent: () => new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(await getTextContent());
          controller.close();
        } catch (error) { controller.error(error); }
      },
    }),
    render: renderPage,
  }));
  const destroy = vi.fn(async () => undefined);
  const documentProxy = {
    numPages: 3,
    getPage,
    getTextContent,
  };
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve(documentProxy),
    destroy,
  }));

  return {
    cancel,
    destroy,
    documentProxy,
    getDocument,
    getPage,
    getTextContent,
    getViewport,
    renderPage,
    TextLayer,
    textLayerRender,
  };
});

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  TextLayer: pdfMocks.TextLayer,
  getDocument: pdfMocks.getDocument,
}));

vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({
  default: "/pdf.worker.test.mjs",
}));

function makePdfFile(name = "paper.pdf") {
  const file = new File(["%PDF-1.7"], name, { type: "application/pdf" });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: vi.fn(async () => new ArrayBuffer(8)),
  });
  return file;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PdfReader", () => {
  it("normalizes an out-of-range page draft even when the actual page stays the same", async () => {
    render(<PdfReader file={makePdfFile()} />);
    const input = await screen.findByRole("spinbutton");
    await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe("1");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe("3");
  });

  it("cancels a page draft on Escape without committing it during blur", async () => {
    const onReadingPositionChange = vi.fn();
    render(<PdfReader file={makePdfFile()} onReadingPositionChange={onReadingPositionChange} />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    input.focus();
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("1");
    expect(onReadingPositionChange).toHaveBeenLastCalledWith({ currentPage: 1, totalPages: 3 });
  });

  it("resets scroll on page changes but keeps the reading position when zooming", async () => {
    render(<PdfReader file={makePdfFile()} />);
    await waitFor(() => expect(pdfMocks.renderPage).toHaveBeenCalled());
    const scroll = document.querySelector<HTMLElement>(".pdf-reader__scroll-area")!;
    scroll.scrollTop = 500;
    scroll.scrollLeft = 60;
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    await waitFor(() => expect(pdfMocks.getViewport).toHaveBeenCalledWith({ scale: 1.1 }));
    expect(scroll.scrollTop).toBe(500);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(scroll.scrollTop).toBe(0));
    expect(scroll.scrollLeft).toBe(0);
  });
  it("keeps the rendered page readable when text extraction fails", async () => {
    pdfMocks.getTextContent.mockRejectedValue(new Error("Text stream failed"));
    render(<PdfReader file={makePdfFile()} />);
    try {
      await screen.findByText("页面可正常阅读，但此页文字提取失败，暂时无法划词或识别引用。");
      expect(screen.queryByText("此页渲染失败")).toBeNull();
      expect(document.querySelector("canvas")).toBeTruthy();
      expect(document.querySelector(".pdf-reader__rendering")).toBeNull();
    } finally {
      pdfMocks.getTextContent.mockResolvedValue({
        items: [{ str: "This method builds on prior work [2].", hasEOL: true }], styles: {}, lang: null,
      });
    }
  });
  it("从隐藏的文件输入导入 PDF，并完成第一页渲染", async () => {
    const onChooseFile = vi.fn();
    const user = userEvent.setup();
    const file = makePdfFile();

    render(<PdfReader file={null} onChooseFile={onChooseFile} />);

    expect(screen.getByText("打开一篇论文开始阅读")).toBeTruthy();

    await user.upload(screen.getByLabelText("选择本地 PDF 文件"), file);

    expect(onChooseFile).toHaveBeenCalledWith(file);
    await waitFor(() => expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pdfMocks.getPage).toHaveBeenCalledWith(1));
    await waitFor(() => expect(pdfMocks.renderPage).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByText("正在渲染第 1 页…")).toBeNull(),
    );
    expect(screen.getByTitle("paper.pdf")).toBeTruthy();
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("1");
  });

  it("支持前后翻页、输入页码和缩放", async () => {
    const user = userEvent.setup();
    render(<PdfReader file={makePdfFile()} />);

    await waitFor(() => expect(pdfMocks.getPage).toHaveBeenCalledWith(1));

    await user.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(pdfMocks.getPage).toHaveBeenCalledWith(2));

    const pageInput = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(pageInput, { target: { value: "3" } });
    fireEvent.keyDown(pageInput, { key: "Enter" });
    await waitFor(() => expect(pdfMocks.getPage).toHaveBeenCalledWith(3));

    await user.click(screen.getByRole("button", { name: "放大" }));
    await waitFor(() =>
      expect(pdfMocks.getViewport).toHaveBeenCalledWith({ scale: 1.1 }),
    );
    expect(screen.getByRole("button", { name: "110%" })).toBeTruthy();
  });

  it("恢复上次阅读页，并在页码变化时报告阅读进度", async () => {
    const onReadingPositionChange = vi.fn();
    const user = userEvent.setup();

    render(
      <PdfReader
        file={makePdfFile()}
        initialPage={2}
        onReadingPositionChange={onReadingPositionChange}
      />,
    );

    await waitFor(() => expect(pdfMocks.getPage).toHaveBeenCalledWith(2));
    await waitFor(() =>
      expect(onReadingPositionChange).toHaveBeenLastCalledWith({
        currentPage: 2,
        totalPages: 3,
      }),
    );

    await user.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(onReadingPositionChange).toHaveBeenLastCalledWith({
        currentPage: 3,
        totalPages: 3,
      }),
    );
  });

  it("把真实文本选区绑定到页码并交给阅读工具", async () => {
    const onTextSelection = vi.fn();
    const onSelectionAction = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <PdfReader
        file={makePdfFile()}
        onTextSelection={onTextSelection}
        onSelectionAction={onSelectionAction}
      />,
    );

    await waitFor(() => expect(pdfMocks.textLayerRender).toHaveBeenCalled());
    const text = container.querySelector(".pdf-reader__text-layer span")?.firstChild;
    expect(text).toBeTruthy();
    const range = document.createRange();
    range.setStart(text!, 0);
    range.setEnd(text!, 9);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(container.querySelector(".pdf-reader__page-shell")!);

    const selection = {
      text: "Attention",
      anchor: { pageNumber: 1, startOffset: 0, endOffset: 9 },
    };
    expect(onTextSelection).toHaveBeenLastCalledWith(selection);
    await user.click(screen.getByRole("button", { name: "翻译" }));
    expect(onSelectionAction).toHaveBeenCalledWith("translation", selection);
    expect(screen.getByRole("button", { name: "解释" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "公式" })).toBeTruthy();
  });

  it("从当前 PDF 页面的真实文本报告引用线索", async () => {
    const onCitationsChange = vi.fn();
    render(<PdfReader file={makePdfFile()} onCitationsChange={onCitationsChange} />);
    await waitFor(() => expect(onCitationsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        pageNumber: 1,
        label: "[2]",
        context: "This method builds on prior work [2].",
      }),
    ]));
  });

  it("展示 PDF 加载错误，并保留重试和重新选择入口", async () => {
    pdfMocks.getDocument.mockReturnValueOnce({
      promise: Promise.reject(new Error("文件已损坏")),
      destroy: pdfMocks.destroy,
    });

    render(<PdfReader file={makePdfFile("broken.pdf")} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("文件已损坏");
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "选择其他文件" })).toBeTruthy();
  });
});
