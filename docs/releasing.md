# 自动发布

发布流程监听 `master` 推送。升级项目版本、补好公告并推送后，GitHub Actions 会自动建标签和发布 Release，无需手动执行 `git tag` 或 `git push --tags`。

## 日常操作

1. 同步 `package.json`、`package-lock.json`、`manifest.json` 和 `versions.json` 的版本信息。可以运行 `npm version patch --no-git-tag-version`，它会调用现有版本同步脚本。
2. 在 `src/utils/changelog.ts` 增加对应版本的中英文公告。
3. 提交并推送到 `master`。
4. 在 Actions 的 **Release Obsidian plugin** 查看结果。

## 脚本如何发布

入口是 `.github/workflows/release.yml`，实现位于 `.github/scripts/release.mjs`：

- `prepare`：检查版本一致性和已有 Release。相同版本已经发布且三个安装附件完整时，直接跳过，不安装依赖、不移动标签、不重复上传。
- 新版本执行依赖安装、测试、生产构建和构建来源证明。
- `publish`：从项目公告生成双语说明，自动创建与构建提交对应的版本标签，创建草稿并上传 `main.js`、`manifest.json`、`styles.css`。
- 检查附件大小和 GitHub 提供的 SHA-256 校验值后，公开 Release 并设为最新版。

版本号相同的普通代码推送不会重新发布。要让新的插件改动自动更新给用户，需要升级版本号。

## 重试和保护

- 测试或构建失败时不会新建版本标签。
- 上传失败时保留草稿，可以重新运行同一提交的失败任务。
- 已存在标签但指向其他提交时，流程会停止，不自动强制改写标签。
- 保留手动推送数字版本标签的兼容入口，标签必须与 manifest 的版本一致。
- Release 任务按仓库串行执行，避免两个发布任务同时修改附件。

使用工作流自带的 `GITHUB_TOKEN`，不需要配置个人令牌。因为该令牌创建的标签不会再次触发普通工作流事件，建标签和发布在同一任务中完成，参见 [GitHub 的工作流触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。
