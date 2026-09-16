# Filo · 菲洛

本地优先的桌面存储管理器。当前为 **LocalFS + S3 Demo**，可以选择已有、带文件的目录；没有模拟文件数据，也不需要后端服务器。

## 启动

开发环境：Rust stable、Node.js 22.12+、pnpm 11，以及 Tauri 2 对应平台的系统依赖。当前在 macOS 验证；macOS 需要 Xcode Command Line Tools。

```bash
pnpm install
make dev
```

在桌面窗口点击「添加存储空间」→「选择本地目录」，选择 Documents、项目目录或其他已有目录即可。可以勾选「以只读方式添加」先看效果。重复添加同一目录会打开原来的连接，保留原有只读配置。

浏览器中的 `pnpm dev:web` 仅用于界面预览，不能访问真实文件。真实文件操作必须使用 Tauri 桌面窗口。

## 当前可用

- 系统原生目录选择器，支持多个已有目录，SQLite 保存连接。
- 右键侧栏「位置」→「编辑连接…」，可修改显示名称、切换只读或通过系统选择器更换目录；保存后立即生效。
- 目录列表、面包屑、双击进入、前进/后退/上级、刷新。
- 当前目录名称筛选、名称/大小/修改时间排序、隐藏文件开关。
- 系统默认应用打开文件、文件属性、新建文件夹、单文件重命名。
- 文件右键菜单提供打开、复制、移动、删除与强制删除；支持回收站的后端默认移入回收站。
- 右键移除位置，仅移除连接配置，保留磁盘文件。
- 本地单文件复制、移动，目标目录浏览，传输进度、取消和持久化任务记录。
- 只读模式、根目录保护、路径逃逸检查、符号链接禁止跟随。
- Finder 风格浅色界面、原生窗口按钮、紧凑文件列表、概览与详情面板、加载/空列表/错误状态。当前固定浅色，主题切换留待后续。

普通删除按后端能力优先移入回收站；回收站失败时提示「继续删除将永久删除，无法找回」，可取消或另行确认「仍然永久删除」；不会自动永久删除。不支持回收站的后端会在确认弹窗中明确提示永久删除。「强制删除」跳过回收站，需要单独确认。本地文件夹可整体移入回收站，永久删除仍仅支持空文件夹。重命名不会覆盖同名目标；暂不支持目录重命名和递归永久删除。双击普通文件用系统默认应用打开，详情通过右键「显示简介」查看。

S3 兼容存储现已支持连接测试、系统钥匙串凭据保存、Bucket/Prefix 浏览、单文件上传下载、复制、移动、重命名和删除。点击「添加存储空间」→「S3 兼容存储」；S3 工具栏提供原生文件选择器上传/下载，复制和移动可在已连接的本地/S3 位置间执行。参见 [S3 与本机 RustFS](docs/11-s3.md)、[LocalFS 实施记录](docs/10-local-demo.md) 与 [完整指导文档](docs/README.md)。

## 工程结构

```text
apps/desktop/                 React + TypeScript + Tauri 2
crates/storage-domain/        领域类型、能力与错误、逻辑路径
crates/storage-provider-api/  自有 StorageBackend
crates/provider-opendal/      LocalFS / S3 适配、安全检查
crates/storage-repository/    SQLx + SQLite
crates/storage-application/   应用服务，串行写操作
migrations/                  连接、存储空间、传输任务表及 S3 迁移
docs/                        从 init.md 整理的开发指导
```

前端 `App.tsx` 负责查询、操作状态与页面组装；侧栏、顶部工具栏、概览、设置、文件浏览、详情及操作弹窗各自独立。`styles.css` 仅组织 `styles/` 下的分区样式，导入顺序保留层叠关系。

`provider-opendal` 的 `local/` 与 `s3/` 分别封装适配器；本地路径校验、防覆盖重命名、暂存写入和 S3 流式读写独立成模块。`storage-application` 按存储位置管理（`volumes`）、文件操作（`entries`）、传输调度（`transfers`）及传输执行与校验（`transfers/execution`）划分，测试放在对应模块的 `tests.rs`。新增逻辑优先归入对应职责，入口文件只保留组装与必要的共享状态。

OpenDAL 类型只出现在 `provider-opendal` 中。为了防止并发目标覆盖，macOS/Linux 的单文件重命名使用 Provider 内封装的 `renameat_with(NOREPLACE)`；浏览、创建目录与删除使用 OpenDAL；流式传输使用 Provider 内部的文件句柄和独占临时文件，校验后以 no-clobber 方式发布。系统打开和回收站也封装在 Provider 内，前端只提交受约束的 StorageLocator，不安装或调用 FS Plugin。

复制和移动入口在文件工具栏及操作菜单中。目标位置须可写；移动的源位置也须可写。文件按 256 KiB 分块传输，大小与 SHA-256 校验通过后发布目标，同名文件不会被覆盖。本地与 S3 写任务依次执行，支持取消排队、复制及校验中的任务；文件提交开始后会完成操作。连接有传输任务时，需先取消或等待任务完成再编辑、移除。

macOS 配置数据库位于 `~/Library/Application Support/dev.filo.desktop/filo.sqlite`。不会复制或导入所选目录中的文件。当前浏览偏好只在本次会话保留。

## 检查与打包

```bash
make check      # TypeScript、ESLint、Rust fmt / Clippy
make test       # Rust 单元与集成测试
pnpm build     # 前端生产构建
make build     # Tauri app bundle
make demo      # 本机演示包；读取 ~/.config/filo/signing/identity.txt
```

快速生成本机演示包：在 macOS 上运行 `security find-identity -v -p codesigning`，将选定证书的名称或指纹写入 `~/.config/filo/signing/identity.txt`，然后执行 `make demo`，打开 `target/debug/bundle/macos/Filo.app`。也可通过 `.env` 或环境变量中的 `APPLE_SIGNING_IDENTITY` 覆盖身份；环境变量优先于 `.env`，值为空时读取 `identity.txt`。证书不存在或签名失败时构建失败，不退回临时签名。此入口生成 macOS `.app`，不用于其他平台分发。

初次 Rust 构建需要下载并编译桌面依赖。macOS app bundle 位于 `target/release/bundle/macos/Filo.app`；尚未配置发行签名或公证。

### macOS 文件夹授权

下载、桌面、文稿等受保护目录首次访问时由 macOS 请求授权。未配置证书的演示包只有临时签名，代码重建会改变其签名身份，系统可能再次请求授权。日常查看效果使用 `make demo` 并保持同一个签名证书和应用标识；切换签名后的首次访问仍可能需要授权。本地自签证书仅用于本机调试，不代表完成发行签名或公证。依据：[Apple 对签名身份的说明](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、[Tauri 签名配置](https://v2.tauri.app/distribute/sign/macos/)。

前端开发使用 `make dev` 的热更新；该模式的 Rust 重建仍可能改变临时签名。目录列表与复制/移动目标目录不再因切回窗口或网络重连自动读取，外部修改文件后请点击刷新；应用内操作完成后仍会刷新列表。拒绝访问后不会自动重试，可授权后手动重试。

本机签名文件统一保存在项目外的 `~/.config/filo/signing/`，采用与 Dayflow 相同的目录和命名方式：`certificate.p12` 包含加密的证书与私钥，`password.txt` 保存导出密码，`identity.txt` 保存构建使用的证书名称或指纹。目录权限为 `700`，文件权限为 `600`。迁移备份时需保留证书与密码，向他人提供证书文件时不要同时提供密码。

迁移到另一台 Mac 时，将签名目录放到新用户的 `~/.config/filo/signing/`，在「钥匙串访问」中导入 `certificate.p12` 并输入导出密码。`make demo` 读取 `identity.txt` 并使用钥匙串签名，不直接读取 `.p12`；迁移保留同一身份，不删除原钥匙串中的证书。不要重新生成证书代替迁移，否则签名身份会变化，新机器上的文件夹访问权限仍需重新授权。
