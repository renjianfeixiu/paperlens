# GitHub 项目与发布流程

仓库：https://github.com/renjianfeixiu/paperlens

## 日常修改

`main` 保存当前代码。功能在独立分支完成，通过 PR 说明问题、行为和验证；Issues 用于缺陷、功能与平台验收。参考项目的结构与说明方式，但 PaperLens 使用原生安装包，不使用 FrameFlow 的独立 HTML 启动方式。

推送和 PR 会触发前端 CI。提交到远端后核对实际 commit 和 Actions 结果，不能把本地 commit 当成上传完成。

## 固定版本发布

1. 对齐 package.json、Cargo.toml、tauri.conf.json 的版本，更新 CHANGELOG 和 `docs/releases/<version>.md`。
2. 提交源码并推送，创建带注释的发布标签，例如 `v0.1.3-github`，再推送该标签。
3. `Desktop release` 在 Apple Silicon Mac、Intel Mac、Windows x64 三种原生 runner 上运行前端测试、Rust 测试和安装包构建。
4. 包校验脚本检查版本、架构、Mac 签名 / DMG 和 Windows PE，并生成各包清单。
5. 三个构建全部成功后，流程汇总 SHA-256 和 manifest，创建或更新 GitHub Release 草稿。手动运行 workflow 只生成 Actions 附件，不发布版本。
6. 下载并检查实际安装包、更新平台验证记录；确认草稿资产齐全后发布。当前 MVP 标记为测试版。

```sh
git tag -a v0.1.3-github -m 'PaperLens 0.1.3 cross-platform release'
git push origin main
git push origin v0.1.3-github
```

原生窗口的完整运行验收必须单独记录。未配置正式签名和公证时，下载说明明确显示该状态。

## 回滚

查看固定版本：`git switch --detach v0.1.3-github`。继续开发：`git switch main`。撤销改动使用 `git revert`，不重写已发布的标签，不使用强制推送覆盖公共历史。
