# macOS 阅读器真实内核回归

## 2026-09-22 故障与根因

用户打开 MetaFormer Baselines for Vision 时，页面覆盖“此页渲染失败”。
在本机系统 WKWebView 中使用同一 PDF、真实 PdfReader 组件、真实 PDF.js 和 worker，连续两次复现：

```text
undefined is not a function (near '...value of readableStream...')
typeof ReadableStream.prototype[Symbol.asyncIterator] === "undefined"
```

PDF.js 6.3.289 的 `getTextContent()` 用 `for await` 遍历 ReadableStream。
legacy 构建没有补齐此环境的接口，导致文字提取失败。此前页面绘制和文字提取在同一个错误边界中，提取错误被显示成整页绘制失败，模糊遮罩遮住已经绘制出的内容。

修复采用 `streamTextContent().getReader()` 逐块读取并释放锁，不改动浏览器全局对象；XFA 保留库原有路径。绘制与文字层错误分开：文字层失败只提示不能划词，不阻挡阅读。

上游同类报告：https://github.com/mozilla/pdf.js/issues/21557

## 之前测试漏在哪里

`PdfReader.test.tsx` 模拟了 PDF.js。它验证组件交互，但不覆盖真实解析、worker、Canvas 和系统浏览器接口；打包成功也不覆盖运行时行为。不能把这些测试当作真实 PDF 阅读验收。

## 可重复的真实内核检查

从 `apps/desktop` 启动 `pnpm dev --host 127.0.0.1`，另一个终端运行：

```sh
swift -module-cache-path /tmp/paperlens-swift-cache scripts/reader-smoke.swift "/绝对路径/论文.pdf" /tmp/paperlens-reader-smoke.png
```

检查器使用临时存储 WKWebView 和指定 PDF 的本地字节，不上传、不修改资料库。断言实际 Canvas 非空、真实文本层、选区回调、翻页、缩放、返回第一页；失败退出码非零。截图可选。没有 PDF.js mock。

验证生产压缩代码（输出目录应使用新建的临时目录）：

```sh
pnpm exec vite build --config scripts/vite.reader-smoke.config.ts --outDir /tmp/paperlens-reader-smoke-build
pnpm exec vite preview --outDir /tmp/paperlens-reader-smoke-build --host 127.0.0.1 --port 1421
swift -module-cache-path /tmp/paperlens-swift-cache scripts/reader-smoke.swift "/绝对路径/论文.pdf" /tmp/paperlens-reader-smoke.png http://127.0.0.1:1421/scripts/reader-smoke.html
```

测试入口不属于应用发布构建，不包含用户 PDF。真实内核测试仍不等于所有 PDF、学校认证或完整 Tauri 外壳均已验收。

## 本次实际结果

- 修复前：同一 MetaFormer PDF 两次真实 WebKit 失败，捕获上述文本流错误。
- 修复后：开发代码及生产压缩代码均通过 MetaFormer 的五项检查；生产代码又通过 RAGAs PDF 的同样检查。
- MetaFormer 首页面画布检测到 236797 个深色像素，187 个文字片段，选区回调返回 62 个字符。
- RAGAs 首页面画布检测到 209630 个深色像素，151 个文字片段，选区回调返回 107 个字符。
- 27 个前端测试文件、168 项测试通过；TypeScript 构建及 macOS `.app` 打包通过。
- 真实测试覆盖第一页、第二页和缩放，不宣称已逐页验收整个资料库。
