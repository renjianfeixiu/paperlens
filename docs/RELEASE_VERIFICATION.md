# PaperLens 0.1.3 平台验证

验证日期：2026-10-10（北京时间）。发布标签 `v0.1.3-github`，三个安装包的源码提交均为 `16214b2a2c22bfb0a07d932fadf5fd742247eb3b`。后续补充发布记录不移动这个标签。

## 本次构建验证

[前端 CI](https://github.com/renjianfeixiu/paperlens/actions/runs/37970645653) 与 [三平台 Desktop release](https://github.com/renjianfeixiu/paperlens/actions/runs/37970818704) 均已成功完成。本次发布包含三个安装包、三个平台 manifest、`release-manifest.json` 和 `SHA256SUMS.txt`，共八个资产。

| 平台 | 原生 runner / target | 前端测试 | Rust 常规测试 | 生产构建及包检查 |
| --- | --- | --- | --- | --- |
| Mac Apple Silicon | macos-15 / aarch64-apple-darwin | 232 通过 / 33 文件 | 13 通过，1 个联网测试 ignored | 通过：应用版本与标识、arm64、签名、DMG |
| Mac Intel | macos-15-intel / x86_64-apple-darwin | 232 通过 / 33 文件 | 13 通过，1 个联网测试 ignored | 通过：应用版本与标识、x86_64、签名、DMG |
| Windows x64 | windows-2022 / x86_64-pc-windows-msvc | 232 通过 / 33 文件 | 13 通过，1 个联网测试 ignored | 通过：主程序 PE / AMD64、版本资源、NSIS 安装器 |

三处源码版本均为 `0.1.3`。Mac 应用标识为 `com.paperlens.desktop`。Windows 安装器按当前用户安装，支持简体中文和英文，缺少 WebView2 时使用下载引导程序。

## 下载后复核

已取得三个实际成品，并核对文件长度、SHA-256、各平台 manifest、汇总 manifest 和 `SHA256SUMS.txt`；结果也与 GitHub 发布资产的服务端 SHA-256 摘要一致。

两个 Mac DMG 在本机重新通过 `hdiutil verify`，只读挂载后再次核对了版本、应用标识、Mach-O 架构和 `codesign --verify --deep --strict`。Windows 安装器在本机检查了 MZ / PE 文件头；包内主程序的 AMD64 架构与 ProductVersion 在原生 Windows runner 中检查。本机未执行 Windows 安装器。

| 安装包 | 字节数 | SHA-256 |
| --- | ---: | --- |
| PaperLens-0.1.3-macOS-AppleSilicon.dmg | 6656534 | `674ceedb045caa845ad97858a64ecafe7f2430deedd70df021a4bde6e53420dc` |
| PaperLens-0.1.3-macOS-Intel.dmg | 7045498 | `26d954ec7008c5c86c25492ec13e6289b60fdec3a0331928016762c544b9a2d3` |
| PaperLens-0.1.3-Windows-x64-setup.exe | 4590410 | `b7a9e7c9bcabb06eb01c39429f0cf4de84c49c5ef35cb37e314023d2d941a52a` |

## 原生运行边界

本次本机处于锁屏状态，原生窗口工具未能取得应用界面，因此未重新执行新安装包的完整 GUI 阅读流程。历史 Apple Silicon 0.1.3 的搜索、开放 PDF 下载、11 页阅读、翻页和重启恢复曾完成实测，见 [历史回归](MACOS_0.1.3_REGRESSION.md)；该记录不计入本次验收。

Intel Mac 与 Windows 的完整安装 / WebView 阅读 / 升级卸载验收尚未执行。三个 manifest 的 `gui_runtime_verified` 均为 `false`，构建和包检查通过不代表这些实机操作已通过。

Mac 使用 ad-hoc 签名，没有 Developer ID 签名和公证；Windows 未配置发布者代码签名。当前发行版标记为测试版。
