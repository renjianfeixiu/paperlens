# 参与 PaperLens

先阅读 [产品设计](docs/PRODUCT_DESIGN.md) 和 [迭代路线](docs/ROADMAP.md)。功能应服务于发现、合法获取、本地阅读和原文理解的连续流程。

## 提交修改

1. 从 `main` 新建功能分支，先说明可复现的问题或预期行为。
2. 修改对应模块，完成与改动有关的测试；文件和平台改动同时检查原生端。
3. 在 PR 中说明问题、最终行为、验证方式和未验证的平台。
4. 不上传个人 PDF、资料库、访问凭据、构建缓存或安装包；安装包通过 Releases 发布。

```sh
cd apps/desktop
pnpm install --frozen-lockfile
pnpm test
pnpm build
cargo test --release --locked --manifest-path src-tauri/Cargo.toml
```

外部索引、翻译或下载故障应保留来源与错误，不能将某渠道不可用表现为所有来源均无结果。阅读器修改应使用真实公开 PDF 检查文本选择、页码、缩放和恢复，测试资料应由测试者自行合法取得。

## 发布

三个版本字段必须保持一致：`apps/desktop/package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`。按 [发布流程](docs/GITHUB_WORKFLOW.md) 生成 Mac / Windows 安装包，检查校验值和平台验证记录后再发布。
