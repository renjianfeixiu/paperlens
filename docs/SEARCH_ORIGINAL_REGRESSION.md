# 原始论文搜索回归 · 2026-09-27

## 用户问题与实测根因

输入 `attention is all you need`，不能稳定找到 Ashish Vaswani 等人的 2017 年原始论文。
这不是付费墙：arXiv 和 NeurIPS 官方都提供 PDF。

修复前，在隔离的系统 WKWebView 中重复运行真实 App + 真实网络接口：

- 一次返回 68 条结果，但同名论文被合并为 2025 年记录，右侧默认选中 `Is Attention All You Need?`。
- 第二次 OpenAlex 返回 HTTP 429，只剩 27 条 Crossref 结果；原始 2017 年记录缺失。
- OpenAlex 用 `10.48550/arxiv.1706.03762` 查询返回 0 条；Crossref 同样不返回该 DOI。
- Crossref 的若干 `posted-content` 登记为 2025 年转载，但原来的合并逻辑仅凭渠道名称判断预印本，错误地优先保留了转载。
- 小写输入没有触发精确标题候选；渐进搜索把“自动选中的首条”与“用户主动选中”混为一谈，后续正确结果无法更新默认详情。

权威原始记录：[arXiv](https://arxiv.org/abs/1706.03762)、[arXiv 在 DataCite 的登记](https://api.datacite.org/dois/10.48550/arxiv.1706.03762)、[NeurIPS 2017](https://papers.nips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html)。

## 修复

1. 新增独立 arXiv 元数据检索，限定 DataCite `arxiv.content` 仓库；标题、主题和 DOI/编号均支持，不需要用户申请密钥。
2. 按相关性而非入库时间排序；验证返回的 arXiv DOI 后才构造官方 PDF 链接。不内置这篇论文的搜索结果。
3. 完整标题候选不再要求英文首字母大写；关键词与语义检索仍保留。
4. 识别 `posted-content` / `preprint`；同族同类版本选择较早年份，避免 2025 年转载覆盖 2017 年原文。
5. 默认详情跟随最新最佳结果；用户点击后保持其选择。
6. 支持 NeurIPS 新旧域名和 `/paper_files/paper/...` 路径；仍拒绝仿冒域名。
7. 某渠道报错、其他渠道空结果时，不再当成“已经搜完且没有结果”，保留失败重试流程。

## 已执行的验证

- 先新增回归测试，观察到 8 项失败，再修复；另外用先失败的测试锁定 NeurIPS 路径与空结果掩盖故障问题。
- 全量前端：30 个文件、210 项通过；TypeScript + Vite 生产构建通过。
- Rust：13 项离线测试通过；真实网络下载测试默认忽略，单独显式运行。
- 真实网络 + 系统 WKWebView：小写完整标题返回 69 条，原始论文第一位，年份 2017，DOI `10.48550/arxiv.1706.03762`，默认详情及“下载并阅读”正确；当次 OpenAlex 真实返回 429。
- 主动模拟 OpenAlex 不可用：输入 `1706.03762` 仍返回唯一原文；DataCite 与 Crossref 请求均是真实网络请求。
- 使用与 Tauri `download_pdf` 命令相同的 HTTPS、DNS、重定向、PDF 头与落盘流程，实际下载 arXiv PDF **2,215,244 字节**，NeurIPS 官方 PDF **569,417 字节**。文件保存到新建的临时测试目录，没有修改用户资料库。
- 下载后的 arXiv PDF 在真实 PDF.js + 系统 WebKit 下通过首屏非空、文字选择、下一页、缩放、返回第一页检查；当前 arXiv 链接为 v7，PDF 共 15 页，其修订时间不是首发年份。
- 交互回归：渐进结果、用户选中保持、原页重试、更换关键词、取消保留已有结果、横向不溢出，6 项通过。
- 生产压缩代码：在模拟 OpenAlex 不可用的真实网络标题检索中同样返回 2017 年原文第一位。
- 2026-09-29 中断恢复后重新执行全量 210 项前端测试，通过；在打包的 Tauri 原生应用（`tauri://localhost`，非开发网页）实际输入完整小写标题，返回 69 条结果，默认选中 2017 年原文、正确 DOI 和“下载并阅读”。当次 OpenAlex 仍真实返回 429，确认发布版 CSP 也允许独立 arXiv 渠道工作。没有在用户资料库内重复导入测试 PDF。

## 重跑方式

在 `apps/desktop` 启动 `pnpm dev --host 127.0.0.1`，再执行：

```sh
pnpm test
pnpm build
swift -module-cache-path /tmp/paperlens-swift-cache scripts/reader-smoke.swift - /tmp/paperlens-original.png \
  'http://127.0.0.1:1420/scripts/search-smoke.html?live&expect-exact&expect-year=2017&expect-doi=10.48550%2Farxiv.1706.03762&query=attention%20is%20all%20you%20need'
swift -module-cache-path /tmp/paperlens-swift-cache scripts/reader-smoke.swift - /tmp/paperlens-id.png \
  'http://127.0.0.1:1420/scripts/search-smoke.html?live&block-openalex&expect-exact&expect-title=Attention%20Is%20All%20You%20Need&expect-year=2017&expect-doi=10.48550%2Farxiv.1706.03762&query=1706.03762'
```

原生网络下载测试在 `apps/desktop/src-tauri` 执行；必须使用新建的隔离目录：

```sh
paperlens_smoke_dir=$(mktemp -d /tmp/paperlens-pdf-smoke.XXXXXX)
env CARGO_HTTP_PROXY='' \
  PAPERLENS_SMOKE_PDF_URL='https://arxiv.org/pdf/1706.03762' \
  PAPERLENS_SMOKE_OUTPUT_DIR="$paperlens_smoke_dir" \
  cargo test --locked --offline live_pdf_download -- --ignored --nocapture
```

命令打印下载文件的绝对路径，将该路径交给 `scripts/reader-smoke.swift` 可检验真实阅读器。测试入口不会进入正式发布构建。

## 验证边界

这些检查分别覆盖真实 UI 搜索、实际原生下载流程和真实 PDF 阅读器，不等于所有网站或所有论文均已可下载。网络限流和索引缺漏仍会明确显示；“近 5 年”等主动筛选依然生效，不会暗中绕过用户过滤条件。DataCite 的引用计数覆盖较窄，不能当作全网引用总数。Intel / Windows 运行状态须单独验证，不能从本机 WebKit 成功推断。
