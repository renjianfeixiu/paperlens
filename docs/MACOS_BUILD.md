# macOS 安装与构建

## 普通使用

从 [Releases](https://github.com/renjianfeixiu/paperlens/releases/tag/v0.1.3-github) 选择 Apple Silicon 或 Intel DMG，打开后将 PaperLens 拖入 Applications。

本次版本为 0.1.3，应用标识 `com.paperlens.desktop`。Mac 包使用 ad-hoc 签名，没有 Apple Developer ID 证书或公证；系统可能显示无法确认开发者的提示。此状态在 Release 和验收记录中保留，不要求关闭系统整体安全保护。

## 开发构建

需要 Node.js 24、pnpm 11.25.0、Rust stable、Xcode Command Line Tools。

```sh
cd apps/desktop
pnpm install --frozen-lockfile
pnpm test
cargo test --release --locked --manifest-path src-tauri/Cargo.toml
pnpm tauri build --target aarch64-apple-darwin --bundles app,dmg -- --locked
```

Intel 使用 `x86_64-apple-darwin`。输出位于 `src-tauri/target/<target>/release/bundle/`。跨芯片构建需要先通过 `rustup target add <target>` 安装目标标准库；对应系统库和部署版本以 Tauri / Xcode 设置为准。

在仓库根目录校验并整理安装包：

```sh
python3 scripts/package-release.py --target aarch64-apple-darwin --output releases
```

脚本检查版本、应用标识、Mach-O 架构、签名和 DMG 完整性，再生成命名统一的安装包及 SHA-256 清单。它不代替实际阅读和升级验收。

官方依据：[Tauri macOS 打包](https://v2.tauri.app/distribute/macos-application-bundle/)、[GitHub 构建流程](https://v2.tauri.app/distribute/pipelines/github/)。
