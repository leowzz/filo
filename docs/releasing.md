# Filo 构建与发布

## 本地版本

初次检出复制 `.env.example` 到 `.env`，不要覆盖已有配置。唯一版本行必须为 `version=vX.Y.Z`，不允许空白、引号或重复定义；其他配置保留。未创建 `.env` 时，校验/构建读取 `.env.example`。所有版本命令支持 `ENV_FILE=/absolute/path/local.env`。

同步位置：根目录与桌面 `package.json`、`Cargo.toml` 的 workspace 版本、`Cargo.lock` 的本项目 packages、Tauri 配置及 `.env.example`。各 crate 必须继承 workspace 版本；不修改第三方依赖版本。界面从应用元数据读取实际版本，不另维护展示常量。

```bash
make version-check
make test-release
make check
make test
make build

# 要求干净工作区，包含未跟踪文件检查。
make release                  # 正式版 patch + 1
make release V=v0.2.0         # 显式版本
make release V=v0.2.0-beta.1
make release V=0.2.0 RC=2     # v0.2.0-rc.2
make release RC=1             # 当前基础版本 patch + 1，再追加 -rc.1
```

`make version-set V=v0.2.0` 仅同步版本文件，不提交或创建 tag；通常直接使用 `make release V=...`。预发布不能隐式升级为下一个版本，请传 `V` 或 `RC`。排序为 alpha < beta < rc < 正式版，序号按数字比较。拒绝降级；当前版本尚无 tag 时允许为当前提交创建首次 annotated tag。

`release` 只 stage 版本白名单，存在版本变更时提交 `chore: release vX.Y.Z`，再创建 annotated tag。不会构建或推送，只检查本地 tag。tag 失败时保留已成功的 commit 并报告其 SHA，不能通过 reset 或强制覆盖隐藏失败。

确认要发布后，先推版本所在分支，再仅推对应 tag，例如在 main 分支：

```bash
git push origin main
git push origin v0.2.0
```

不要使用 `git push --tags`。工作流允许 tag 的提交属于任意已推送分支，并非仅 main。

## GitHub Actions

`.github/workflows/release.yml` 只响应 `v*` tag push，不响应普通分支/PR，也没有手动发布入口。校验 job 先重新获取远端版本 tag，避免 checkout 的回退 fetch 将 runner 内的 annotated tag 替换为提交引用；随后核对 tag 指向本次检出提交、版本格式、annotated tag、远端分支归属及所有版本来源，并运行发布脚本测试。两个平台分别执行 TypeScript、ESLint、rustfmt、Clippy、Rust 测试，再构建：

| 目标 | Runner | 产物 |
| --- | --- | --- |
| macOS Apple Silicon（aarch64） | macos-14 | `.dmg`、`.app.tar.gz`、归档 `.sig` |
| Windows x64 | windows-2022 | NSIS `.exe`、`.exe.sig` |

两个平台在 metadata 成功后并行运行，`fail-fast: false` 保证单个平台失败不会取消另一平台；publish 等待两者全部成功。macOS 只安装和编译 `aarch64-apple-darwin` 目标，不再构建 Intel 或 Universal，产物名称使用 `_aarch64` 后缀。

每个文件（含签名文件）都有 `.sha256`，共 10 个上传文件；正式版另加 `latest.json`。CI 中间产物保存 30 天，位于 `target/release-assets/<target>/`，本地普通构建位于 `target/release/bundle/`。普通构建不需要 updater 私钥；发布构建额外叠加 `tauri.updater.conf.json`，缺更新签名私钥直接失败。

工作流只有 publish job 获得 `contents: write`。发布序列按仓库串行，防止较旧版本覆盖 Latest。GitHub concurrency 只保留一个等待中的 run；不要连续快速推多个发布 tag，需要时从 Actions 重跑被取消的版本。

发布先校验完整产物与 SHA-256，再创建 draft、上传并核对 GitHub 返回的资产 digest，最后公开。重跑失败的 publish job 可续传 draft；保留原正文。已公开的版本只能在文件集合和字节完全一致时作为成功重试，拒绝不同字节覆盖同名资产；重新构建可能产生不同签名/时间戳，应发布新版本。已有 Release 若启用了 GitHub 资产不可变策略，仍按平台规则处理。

## 更新签名与平台签名

GitHub 仓库 Settings → Secrets and variables → Actions：

| Secret | 说明 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | 必需，Tauri updater 私钥文件内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码；无密码密钥可为空 |
| `APPLE_CERTIFICATE` | macOS 发布必需，应用签名 P12 的 base64 内容 |
| `APPLE_CERTIFICATE_PASSWORD` | P12 导出密码 |
| `APPLE_SIGNING_IDENTITY` | 签名 identity；公证时使用 Developer ID Application |
| `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` | 可选公证组；密码为 app-specific password |

macOS 发布必须提供 Apple 证书组三项，缺项或使用 ad-hoc 身份 `-` 时在发布编译前失败。公证组三项全有或全无，公证要求 Developer ID Application 证书。未配置的可选公证 Secrets 会从构建进程环境中移除，避免空字符串被 Tauri 误判为已配置。

发布脚本将 P12 导入临时钥匙串，检查 identity 与证书匹配、有效期和私钥访问，并试签验证后才启动发布编译。Tauri 直接使用导入证书的指纹，避免其自动 P12 导入流程无法识别自签证书名称。仅在 GitHub 托管的临时 runner 上为自签证书添加 code-signing 信任；构建成功或失败都会尝试移除该信任、恢复钥匙串搜索列表并删除临时文件。临时 runner 的信任移除失败或超时仅告警，信任设置随 runner 销毁，不阻止已成功签名的产物进入收集流程；钥匙串和私钥文件清理失败仍阻止发布。本机运行不修改证书信任设置。

自签证书不代表 Gatekeeper 信任。没有内嵌 PKG，因此不需要 Installer 证书。本机开发签名继续使用 `~/.config/filo/signing/`，不与 updater 密钥混用。

项目 updater 公钥已固定在 `apps/desktop/src-tauri/tauri.conf.json`。初始私钥备份保存在 `~/.config/filo/updater/private.key`，密码位于同目录 `password.txt`，目录权限 700，私钥及密码权限 600。两者都不在仓库中，应另做安全备份；已有客户端发布后不能随意更换公钥。恢复 CI 时可使用：

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo leowzz/filo < ~/.config/filo/updater/private.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo leowzz/filo < ~/.config/filo/updater/password.txt
```

`.sig` 是更新包签名，SHA-256 是文件完整性校验，均不等于 Apple/Windows 发布者身份认证。Windows Authenticode 尚未配置。Apple 签名、公证是否实际完成，以对应 CI 与最终产物验证为准。

## 自动更新行为

更新源为公开仓库的 `https://github.com/leowzz/filo/releases/latest/download/latest.json`。源代码仓库必须保持公开；不要把 GitHub token 放进客户端。manifest URL 指向明确版本资产，签名字段为签名文件内容。macOS 仅发布 `darwin-aarch64` 的 `.app.tar.gz`，不提供 Intel Mac 更新；Windows 使用 NSIS `.exe`，不能将 DMG 当成 macOS 更新包。

alpha、beta、RC 被标记为 prerelease，不生成稳定通道 manifest、不设置 Latest，默认手动安装；与正式版共用应用身份和数据目录。稳定客户端不会安装预发布。较旧正式版的补发不会抢占更新的 Latest。

正式构建启动 5 秒后检查，失败不打断文件浏览；设置页可查看状态、重试。安装是用户明确操作，先检查传输状态，下载后再次检查；下载/安装期间使用模态进度窗口避免发起新操作。签名验证由 Tauri 完成，安装后重启；重启失败时可手动重启。开发构建与浏览器预览关闭自动检查。

端到端验收需要两次真实发布：从旧安装版检查 → 下载 → 验签 → 安装 → 重启，验证版本变化和原存储连接保留，并验证网络失败、无更新、有传输时阻止安装。macOS DMG 与 updater App 归档的签名/公证状态应分别检查；构建通过不能代替实际升级验收。

官方资料：[Tauri Updater](https://v2.tauri.app/plugin/updater/)、[macOS 签名与公证](https://v2.tauri.app/distribute/sign/macos/)。
