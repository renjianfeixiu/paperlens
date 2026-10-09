# Windows x64 版本

状态（2026-09-29）：Windows x64 0.1.1 NSIS 测试安装包已更新，包含最新原始论文检索修复。构建、macOS 上的自动测试和安装包静态校验通过；没有可访问的 Windows 测试环境，尚未完成 Windows 真机验收，未做代码签名。不能把这些检查等同于已确认 Windows 上可运行。

## 本次交付

- 安装包：[PaperLens-0.1.1-Windows-x64-20260929-setup.exe](../releases/PaperLens-0.1.1-Windows-x64-20260929-setup.exe)
- 大小：4,607,662 字节（约 4.6 MB）。
- SHA-256：`ba47ce185a536effb53796b5bd8289284bcbe107455882279683c5219b47b11f`。
- [安装说明与待实测清单](../releases/README-Windows-0.1.1.md)。旧 0.1.0 安装包保留，但不包含这轮原始论文检索修复。
- 复制到 Windows x64 电脑后双击安装，支持简体中文和英文，默认只为当前用户安装。不是 macOS 文件，也不是 ARM64 原生版。
- 安装器不内置完整 WebView2 Runtime。系统缺少它时，会从微软联网下载并安装；不是完全离线安装包。

## 更新内容

- 新增独立 arXiv / DataCite 检索渠道，减少对 OpenAlex 可用性的依赖。
- 修复完整标题小写输入、原文编号 / DOI 查询、转载覆盖原始年份和默认详情选错记录的问题。
- 修复 NeurIPS 新旧落地页 PDF 地址识别，以及某渠道故障被其他渠道空结果掩盖的问题。

代码与 macOS 功能回归证据见 [原始论文搜索回归](SEARCH_ORIGINAL_REGRESSION.md)。这些功能已打进本次 Windows 安装包，但 Windows 的 WebView2、下载和阅读流程仍待实测。

## 本次已完成的验证

- 前端 30 个测试文件、210 项测试通过；Rust 后端 13 项测试通过，1 项需显式启用的真实网络下载测试默认忽略。自动测试均在 macOS 构建机执行，不是 Windows 运行测试。
- TypeScript、Vite 生产构建及 `x86_64-pc-windows-msvc` release 编译成功。
- 7-Zip 对最终交付安装包进行完整性检测、列出文件和实际解压，全部通过；没有打包个人 PDF 或资料库。
- 解压出的 `paperlens.exe` 是 PE32+ / AMD64 / Windows GUI 程序。导入表中没有单独依赖 `vcruntime140.dll` 或 `msvcp140.dll`，仍使用 Windows 系统库及 Universal CRT。
- 从解压后的 PE 版本资源读取 `FileVersion` 和 `ProductVersion`，均为 `0.1.1`；嵌入资源包含当前构建的 `index-QxpTdZwe.js`、`PdfReader-D6uWZbja.js`、`pdf.worker.min-BmVo14Nb.mjs`，CSP 包含 `https://api.datacite.org`。
- 解压后的主程序与构建产物仅有 Tauri 正常写入的 `UNK` → `NSS` 安装包类型标记差异（3 字节），其余内容逐字节一致。
- 交付副本与构建生成的安装包 SHA-256 一致。
- 安装脚本已核对为 `currentUser`、中英文语言和缺失时下载 WebView2。只有在非更新模式、用户勾选删除应用数据时才清理资料目录；此处是脚本检查，不是升级或卸载实测。

Vite 提示 PDF 阅读器 / worker 资源较大，生产构建成功；本次没有为了消除体积提示而修改阅读器。静态检查不能证明 WebView2 启动、网络访问、文件对话框和阅读交互一定正常。

## 构建途径

优先在 Windows 原生环境复现构建和运行测试。当前仓库未配置 remote，以下 GitHub 流程尚未在线执行。

1. 将本项目上传到你授权的 GitHub 仓库（当前未配置 remote，尚未上传）。
2. 打开仓库 Actions → Windows installer → Run workflow。
3. 流程在 Windows Server 2022 上安装锁定的前端依赖，运行前端与 Rust 测试，构建 x64 NSIS 安装程序。
4. 成功后下载 `PaperLens-Windows-x64-installer` artifact，解压得到 `*-setup.exe`。流程只产出构建附件，不会自动创建 Release。

也可以在 Windows 上安装 Node.js 22、pnpm 10、Rust stable（MSVC）、Visual Studio C++ Build Tools / Windows SDK，然后在 `apps/desktop` 运行：

```powershell
pnpm install --frozen-lockfile
pnpm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm tauri build --target x86_64-pc-windows-msvc --bundles nsis -- --locked
```

Tauri 自动合并 `src-tauri/tauri.windows.conf.json`，不改变 macOS 的 app/dmg 配置。输出目录：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。

### 本次 macOS 交叉编译

使用 Rust 的 `x86_64-pc-windows-msvc` 标准库、cargo-xwin 0.23.1、LLVM/lld 23.1.2、NSIS 3.12、Windows SDK 10.0.26100 和 MSVC CRT 14.44.35220；C 依赖还需 CMake、Ninja、NASM。将 `cargo-xwin`、LLVM 和 lld 的可执行目录加入 PATH 后，在 `apps/desktop` 执行：

```bash
paperlens_xwin_cache=$(mktemp -d /tmp/paperlens-xwin.XXXXXX)
XWIN_ARCH=x86_64 XWIN_CACHE_DIR="$paperlens_xwin_cache" cargo-xwin cache xwin
CARGO_HTTP_PROXY='' XWIN_ARCH=x86_64 XWIN_CACHE_DIR="$paperlens_xwin_cache" pnpm tauri build \
  --runner cargo-xwin --target x86_64-pc-windows-msvc \
  --bundles nsis -- --locked
```

本次依赖缓存完整后增加了 `--offline`，没有修改锁定的依赖版本。cargo-xwin 来自其官方 0.23.1 universal2 发布附件，执行前 SHA-256 校验为 `1d74345d23ec744728124a0244696e9f21340fbb4b8a59cc1e39ba4ab18d8113`。

SDK 缓存的**真实路径不能含空格**：cargo-xwin 0.23.1 会将其拼入空格分隔的编译参数，报 `flag in rustflags must not contain its separator (' ')`。本次通过把已下载缓存复制到无空格的临时目录解决；仅增加引号或设置 `CARGO_ENCODED_RUSTFLAGS` 不能修复此工具内部的编码方式，符号链接也会被解析为真实路径。相关实现见 [cargo-xwin 编译参数](https://github.com/rust-cross/cargo-xwin/blob/v0.23.1/src/compiler/clang_cl.rs) 和 [缓存路径解析](https://github.com/rust-cross/cargo-xwin/blob/v0.23.1/src/cache.rs)。

本机没有可用 Windows 系统或虚拟机，因此未实际运行安装器和 WebView2 界面；GitHub Windows 构建流程也尚未在线运行。

## 安装与测试边界

- 首先以 Windows 11 x64 为验收目标。不是 Windows ARM64 原生构建，也不宣称支持 Windows 7/8。
- 使用当前用户安装模式；如果缺少 WebView2 Runtime，安装程序尝试联网获取并安装，因此首次安装可能需要联网及额外系统许可。
- 未配置 Windows 代码签名，可能出现 SmartScreen 未知发布者提示。不要关闭系统整体安全保护。
- 快捷键改为 Ctrl+1/2/3、Ctrl+L、Ctrl+O；macOS 保留 Command。
- PDF 使用应用自己的本地数据目录，浏览器导入使用系统 Downloads 路径；不会打包当前 Mac 的个人资料库。
- 原生 Rust 测试和编译成功不能替代 WebView2 UI 验收。

必须在 Windows 实机确认：安装与启动；中文/空格路径导入；PDF 翻页、缩放、划词；关闭重启恢复；联网搜索和下载；通用概念解释；浏览器下载确认导入；升级和卸载时的资料保留。特别检查没有预装 WebView2 的测试机。

卸载前请先备份资料。若要保留本地 PDF 和资料库，不要勾选卸载器的删除应用数据选项。

官方构建依据：[Tauri Windows 安装包文档](https://v2.tauri.app/distribute/windows-installer/)。
