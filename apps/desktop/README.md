# PaperLens for macOS

PaperLens 的 macOS 客户端，基于 Tauri 2、React、TypeScript 与 PDF.js。

## 已实现

- macOS 风格首页、发现、资料库、笔记与阅读器框架
- arXiv（DataCite 原始登记）+ OpenAlex + Crossref 实时聚合搜索、摘要清洗、DOI 规范化和结果去重；单个渠道不可用时保留其他渠道结果
- 近 5 年、开放全文、综述组合筛选，以及来源透明标记
- 结构化开放获取位置，区分 PDF、落地页、版本、许可与宿主来源
- 自动联合查询 CORE 与 Europe PMC，不再要求用户配置 Unpaywall 邮箱；发行版可由应用运营方配置 Unpaywall 联系邮箱
- 对可信学术站点的开放落地页解析明确 PDF 元数据，含学术域名白名单、跳转和私网防护
- 对明确开放的 HTTPS PDF 提供原生“一键下载并阅读”，并保留原论文元数据
- 支持用户配置学校代理/图书馆入口；在系统浏览器合法登录下载后，90 秒内自动发现新 PDF
- 浏览器 PDF 会自动发现；用户核对真实文件名后才复制并关联到论文，防止同时下载的其他文件被错配
- 多个开放 PDF 候选的来源、版本、许可展示和按来源优先下载
- OpenAlex 参考文献、被引论文与相关推荐的按需加载
- 阅读器按当前页 PDF 文本识别数字式/作者年份式引用，尝试匹配文末编号参考文献，显示可核对的原文上下文
- OpenAlex 真实近期论文每日推荐（资料库主题与轮换主题）、期刊名称/ISSN 搜索与最新论文分页浏览
- macOS 原生 PDF 导入，文件复制到 AppLocalData 私有目录并可跨重启恢复
- 本地 PDF 分页、页码跳转、50%–250% 缩放和阅读页码恢复
- 使用 PDF.js legacy 浏览器构建兼容 macOS WKWebView，并在原生包中验证真实论文页面渲染
- PDF.js 真实文本层、选区操作条，以及页码与字符范围证据锚点
- 用户确认后发送选区的英中翻译，保护公式、引用编号、DOI 与图表编号
- 基于真实选区的公式结构提示、符号提取，以及内置常用词 / 维基百科通用概念解释
- 阅读器页码纠正、Esc 取消跳页、翻页回到页首，以及长中文 / emoji / 连续点文件名的保存恢复保护
- 版本化 localStorage 资料库，含异常数据恢复和阅读进度模型
- 单元测试与 PDF 阅读器组件测试

## 本地开发

需要 Node.js、pnpm、Rust stable，以及安装了命令行工具的 Xcode。

```bash
pnpm install
pnpm dev
```

启动原生 macOS 窗口：

```bash
pnpm tauri dev
```

验证与构建：

```bash
pnpm test
pnpm build
pnpm tauri build --debug
```

## 代码位置

- `src/App.tsx`：产品壳和主流程
- `src/components/PdfReader.tsx`：PDF.js 阅读器
- `src/services/openAlex.ts`：OpenAlex 适配器
- `src/services/crossref.ts`：Crossref 适配器
- `src/services/openAlexRelations.ts`：引用与相关推荐适配器
- `src/services/nativeFiles.ts`：macOS PDF 导入与恢复
- `src/services/remotePdf.ts`：原生网络 PDF 下载调用与错误模型
- `src/services/fullTextResolver.ts`：CORE、Europe PMC 与可选 Unpaywall 的并行全文补查
- `src/services/dailyRecommendations.ts`：真实近期论文推荐
- `src/services/journalBrowse.ts`：期刊搜索和最新论文浏览
- `src/domain/citations.ts`：PDF 引用线索与文末书目匹配
- `src/services/acquisitionBridge.ts`：可信落地页、学校访问和浏览器下载导入
- `src/domain/access.ts`：全文位置清洗、合并与开放版本选择
- `src/domain/`：论文、DOI、筛选、去重与关系领域逻辑
- `src/store/library.ts`：本地资料库状态与持久化
- `src-tauri/`：macOS 原生壳、权限和打包配置

## 当前边界

这是 MVP 测试版本。引用识别目前是启发式的，不保证所有 PDF 排版和书目格式；期刊页目前支持搜索、按日期浏览论文，不包含所有期刊的卷期目录。严格的上下文公式推导、OCR、SQLite 资料库、笔记、Developer ID 签名与 notarization 仍待实现。

当前翻译使用 MyMemory 公共接口；概念解释优先使用常用词的内置简明释义，其余查询维基百科，英文百科摘要可能调用翻译接口。查询由用户点击触发，不上传 PDF。通用释义不等于论文中的特定含义。

应用只会自动下载学术索引明确标记为开放获取的 HTTPS PDF；最多跟随 5 次逐跳校验的重定向，拒绝本机/私网目标，限制为 100 MiB，并验证 PDF 文件头。机构订阅无法在应用内直接使用浏览器 Cookie：用户需在系统浏览器完成登录和下载，PaperLens 发现新 PDF 后会请用户核对文件名，不绕过付费墙、验证码或 DRM。

0.1.2 优先提供 Apple Silicon 构建，最新检查与未完成验收见 [Mac 回归记录](../../docs/MACOS_0.1.2_REGRESSION.md)。

参考：[Tauri 2 文档](https://v2.tauri.app/)、[PDF.js](https://mozilla.github.io/pdf.js/)、[OpenAlex API](https://docs.openalex.org/)。
