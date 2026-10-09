# Windows x64 安装与构建

## 普通使用

从 [Releases](https://github.com/renjianfeixiu/paperlens/releases/tag/v0.1.3-github) 下载 `PaperLens-0.1.3-Windows-x64-setup.exe`，选择中文或英文，为当前用户安装。

安装器在缺少 WebView2 Runtime 时会从微软联网获取运行环境；不是完全离线安装包。Windows 包没有发布者代码签名，可能出现 SmartScreen 提示，不要求关闭系统整体安全保护。

## 原生构建

需要 Windows x64、Node.js 24、pnpm 11.25.0、Rust stable 的 MSVC 工具链、Visual Studio C++ Build Tools 和 Windows SDK。

```powershell
cd apps/desktop
pnpm install --frozen-lockfile
pnpm test
cargo test --release --locked --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
pnpm tauri build --target x86_64-pc-windows-msvc --bundles nsis -- --locked
```

Tauri 自动合并 `tauri.windows.conf.json`，使用 `currentUser`、中英文语言和缺失时下载 WebView2 的配置。安装包位于 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。

仓库根目录运行：

```powershell
python scripts/package-release.py --target x86_64-pc-windows-msvc --output releases
```

脚本检查主程序 PE 架构、版本资源和安装器文件头，生成统一名称及 SHA-256 清单。GitHub Actions 使用 Windows 原生构建机执行测试与构建，不依赖本机 macOS 交叉编译。

## 实际运行验收

原生单元测试和安装包生成不能代替 WebView2 界面验收。需要检查安装和启动、中文路径导入、PDF 翻页 / 缩放 / 划词、重启恢复、搜索与下载、升级和卸载时的资料保留。

历史 0.1.1 交叉编译记录见 [归档](archive/WINDOWS_0.1.1_BUILD.md)。本次结果见 [验证记录](RELEASE_VERIFICATION.md)。

官方依据：[Tauri Windows 安装包](https://v2.tauri.app/distribute/windows-installer/)。
