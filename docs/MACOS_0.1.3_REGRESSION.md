# Apple Silicon 0.1.3 回归记录

日期：2026-10-06。延续 0.1.2 的待验收清单，使用 `com.paperlens.qa.macos.20260929` 独立资料库及公开论文，完成 Mac 原生流程验收并修复新发现的问题。正式应用使用 `com.paperlens.desktop`。

## 原生窗口操作

| 检查 | 结果与证据 |
| --- | --- |
| 0.1.2 搜索 `attention is all you need` | 91 条结果，2017 原文首位，DOI `10.48550/arxiv.1706.03762` |
| 0.1.2 点击下载 | 两个候选均未完成下载，旧界面只显示最后来源的失效提示，无法从该提示判断首个来源的失败原因 |
| 同一 Rust 下载管线获取 NeurIPS 官方 PDF | 显式执行 `remote_pdf::tests::live_pdf_download` 成功，569,417 字节，校验 PDF 头和保存文件大小 |
| 原生选择器导入 `论文 draft..v2.pdf` | 11 页文档真实渲染，文字层可用；退出重启后成功重新加载并恢复第 2 页 |
| 0.1.3 精确检索 `1706.03762` | 2017 原文，官方正式版本进入候选，并排在 arXiv 之前 |
| 0.1.3 点击“下载并阅读” | 第一个官方候选成功，进入阅读器，11 页、0.5 MB，实际出现完整标题、作者和正文 |
| 0.1.3 再搜小写完整标题 | 91 条结果，2017 原文仍首位，显示“已下载到本机” |
| 页码 `999` | 输入栏限幅为 11，同时显示第 11 页正文 |
| 0.1.3 已下载论文的重启恢复 | 改为第 2 页，退出并启动同一 QA 包；首页显示第 2 / 11 页，点击继续后真实渲染第 2 页 |
| 深色模式 | 新 QA 包中侧栏导航与“打开 PDF”文字可读，截图观察确认 |

经核对的出版来源为 [NeurIPS 官方论文页](https://papers.nips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html)。补充链接同时校验准确 DOI 与标题；未对同名记录按标题猜链接。该人工核对表目前只有这一篇论文，不能推断为整个论文库的覆盖提升。

## 真正的 PDF.js 与系统 WebKit

运行独立生产构建的 `scripts/reader-smoke.html`，由 `scripts/reader-smoke.swift` 提供公开 PDF 字节，使用非持久化 WKWebView。测试入口和测试 PDF 不进入正式应用。

9 项通过：第一页渲染、文字选区回调、下一页、缩放、上一页、无效页码草稿限幅、Esc 取消、翻页滚动归零、重新挂载时恢复第 2 页。

实际输出：

```json
{"done":true,"ok":true,"darkPixels":133470,"selectedCharacters":25,"textSpans":111}
```

该 WebKit 的 `ReadableStream.prototype[Symbol.asyncIterator]` 为 `undefined`；现有兼容处理下本轮仍成功渲染，未出现此前的 `undefined is not a function`。此结果验证当前系统，不能替代所有旧 macOS 的验证。

概念测试使用同一 WebKit 脚本加载 `concept-smoke.html`，四项通过：苹果短释义、NVIDIA V100 GPU 短释义、自行车在线中文摘要、photosynthesis 对应的光合作用中文词条。这里验证服务与 WebKit 的实际返回；不是对整份 PDF 进行 AI 解读的验收。

## 自动测试与构建

- 前端：33 个文件，232 项通过。新增测试包含精确出版版本匹配、上游全部失败时保留已核对版本、首个候选失败后继续下载、保留全部下载错误，以及实际 React 错误面板的展示。
- Rust：13 项通过，1 项联网用例常规运行中忽略；本轮单独启用官方 PDF 下载用例并通过。
- TypeScript、Vite、arm64 release 构建通过。QA 与正式包使用相同生产前端资源；正式标识在打包前复核。
- 默认权限下的 pnpm 启动检查曾因沙箱网络失败，之后从已有依赖直接运行测试与测试资源构建并成功；不把工具启动失败计为测试通过。

## 安装包

[PaperLens-0.1.3-macOS-AppleSilicon-20261006.dmg](../releases/PaperLens-0.1.3-macOS-AppleSilicon-20261006.dmg)：7,129,143 字节。

SHA-256：`7ec112153eda1dec81e0b253536221a9ece74fcc19c2e2d6d9f19d3e845b4ba4`。

`hdiutil verify` 通过。只读挂载确认包内仅有 `PaperLens.app`、`Applications -> /Applications` 与安装说明；应用版本 0.1.3、arm64、标识 `com.paperlens.desktop`。打包副本重新完成本地 ad-hoc 签名，`codesign --verify --deep --strict` 通过。没有 Developer ID 签名、公证，也没有随包放入个人或测试 PDF。

## 未解决的边界

CORE 仍报告不可用。过去观察到的 arXiv 原生直连超时未作网络绕行或全局修复；当前通过可用的正式版本完成此论文获取。未绕过网站登录、付费墙、验证码或原生下载器的公开网络校验。学校访问、浏览器下载自动导入、其余出版渠道、Intel Mac、Windows 与其他 macOS 版本不属于本轮全部实测通过的范围。
