# PaperLens 0.1.3 平台验证

本次使用相同版本源码生成三个平台安装包。记录只列已执行的检查，不把历史 macOS 阅读结果算成 Windows 或 Intel Mac 的实际运行结果。

## 本次构建验证

GitHub Actions 的 `Desktop release` 将分别在 Apple Silicon Mac、Intel Mac 和 Windows x64 运行前端 / Rust 测试、生产构建和安装包检查。最终结果、源码 commit 和运行地址在实际执行后更新。

包检查覆盖：

- 三处版本一致，安装包版本 0.1.3，应用标识不变。
- Mac 应用 Mach-O 架构、ad-hoc 签名、DMG 完整性。
- Windows 主程序 PE / AMD64 架构、版本资源、NSIS 安装器文件头。
- 三个发布资产均具有 SHA-256，汇总 manifest 对应同一源码 commit。

## 原生运行边界

历史 Apple Silicon 0.1.3 的搜索、开放 PDF 下载、11 页阅读、翻页和重启恢复曾完成实测，见 [历史回归](MACOS_0.1.3_REGRESSION.md)。本次安装包是否重新完成对应操作另行列出。

Intel Mac 与 Windows 的完整安装 / WebView 阅读 / 升级卸载验收，未经执行不会标记为通过。Mac 没有 Developer ID 签名和公证；Windows 未配置发布者代码签名。
