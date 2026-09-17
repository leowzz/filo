# Filo

轻量易用的存储管理器，统一浏览和管理本地目录、S3 兼容对象存储及 FTP / FTPS、SFTP、SMB 远程文件。支持文件预览、内容搜索、批量操作、跨存储传输和 S3 对象管理，无需部署 Filo 后端服务。连接信息保存在本机，添加存储空间不会导入或搬移原有文件。

## 启动

开发环境：Rust stable、Node.js 22.12+、pnpm 11，以及 Tauri 2 对应平台的系统依赖。当前在 macOS 验证；macOS 需要 Xcode Command Line Tools。

```bash
pnpm install
cp .env.example .env  # 首次检出；已有 .env 时保留现有配置
make dev
```

macOS 开发启动前需配置可用的固定签名证书，在 `.env` 中填写 `APPLE_SIGNING_IDENTITY`，或保存到 `~/.config/filo/signing/identity.txt`；缺少证书时启动会停止。配置与迁移说明见下方「macOS 文件夹授权」。

在桌面窗口点击「添加存储空间」→「选择本地目录」，选择 Documents、项目目录或其他已有目录即可。可以勾选「以只读方式添加」先看效果。重复添加同一目录会打开原来的连接，保留原有只读配置。

浏览器中的 `pnpm dev:web` 仅用于界面预览，不能访问真实文件。真实文件操作必须使用 Tauri 桌面窗口。

## 当前可用

### 存储连接

| 类型 | 已实现的连接方式 |
| --- | --- |
| 本地目录 | 系统原生目录选择器，支持多个已有目录及只读模式 |
| FTP / FTPS | 用户名、密码和根目录；FTPS 使用显式 TLS，验证服务端证书 |
| SFTP | SSH 密码或私钥认证，自动验证服务器身份，首次连接确认指纹 |
| SMB / Samba | 主机、共享名称、用户名、密码与可选域 |
| 通用 S3 协议 | AWS S3、MinIO 及其他兼容服务；可配置 Endpoint、Region、Bucket、Prefix 和 Path-style |
| RustFS | 独立连接入口，填写自建服务地址 |
| 火山云 TOS / 阿里云 OSS | 按地域生成 S3 公网或内网地址，也可自定义 Endpoint |

点击「添加存储空间」选择对应类型。S3 支持 Access Key / Secret Key 和可选 Session Token，提供连接测试，保存前检查所选 Bucket / Prefix 的访问权限；凭据保存在系统凭据存储中。TOS、OSS 和 RustFS 使用 S3 兼容接口，具体操作能否成功取决于服务实现和账号权限。

侧栏位置的右键菜单支持编辑、移除连接。本地连接可修改名称、只读状态和根目录；S3 和远程协议连接可修改访问配置及凭据，编辑时可保留已有凭据。移除位置保留原始文件或对象；该位置有未完成传输时，需先取消或等待任务完成。

### 文件浏览与预览

- 目录列表、面包屑、前进 / 后退 / 上级、刷新；当前目录名称筛选，按名称、大小、修改时间排序，以及隐藏文件开关。
- 每页 200 项、滚动加载与虚拟列表；支持框选、Cmd / Ctrl 多选、Shift 范围选择、方向键导航和 Cmd / Ctrl+A 选择已加载项目。
- 空格或预览入口查看图片、文本、PDF；多选时显示文件数量与已知大小合计，不递归计算文件夹容量。图片列表支持缩略图，PDF 支持翻页。
- 图片支持 PNG、JPEG、GIF、WebP，图片和 PDF 文件上限为 20 MiB；文本仅预览前 1 MiB。音视频、Office 文档等格式暂不支持预览。
- 从当前目录递归搜索文本内容，可取消并查看命中行号和片段；每个文件返回首个匹配，最多 1,000 条命中或扫描 100,000 个文件，达到上限时提示结果不完整。
- 默认轮询外部目录变化，本地每 5 秒、远程每 15 秒，可关闭自动刷新；读取失败后停止轮询，支持手动重试。
- 详情面板显示文件属性；双击本地普通文件用系统默认应用打开，远程文件可在应用内预览或下载。

界面固定为浅色，提供存储概览、文件浏览、传输任务和设置页面。常用操作可通过工具栏、右键菜单、「更多操作」及桌面系统「操作」菜单访问；未处理异常提供诊断信息查看与复制。

### 文件操作与传输

- 本地、S3、SFTP 和 SMB 支持新建文件夹、重命名、复制、移动、删除；跨存储批量传输保留目录结构。FTP / FTPS 支持浏览、下载、新建文件夹和删除，暂不提供上传及重命名。
- 支持文件复制、剪切、粘贴及 Cmd / Ctrl+C、X、V；切换侧栏位置后可直接粘贴，部分失败可调整冲突策略后重试未完成项目。
- 从 Finder / 文件资源管理器拖入文件或文件夹，复制到当前可写目录；支持写入的远程位置工具栏还支持通过原生选择器批量上传文件、下载单个文件。
- 复制、移动、重命名和上传支持同名冲突策略：拒绝、覆盖、跳过、自动改名。同名文件夹覆盖时合并内容，保留目标独有项目。远程协议不能保证安全替换时拒绝覆盖，可选自动改名；具体边界见[远程存储说明](docs/15-remote-storage-and-file-workflow.md)。
- 最多同时执行 3 个传输任务，涉及重叠读写路径的任务等待执行；任务页显示进度、速度、状态和错误，支持取消及持久化任务记录，上传入口可查看近期上传进度。
- 「设置 → 传输速度」分别设置上传、下载上限，同方向任务共享额度；默认不限速，保存后对运行中任务生效，重启后保留。本地互拷不受限，远程校验读取计入下载额度。
- 只读模式、根目录保护、路径逃逸检查和符号链接禁止跟随。

普通删除在后端支持时优先移入回收站；回收站失败不会自动永久删除，需另行确认。不支持回收站的远程后端会明确提示永久删除。「永久删除」跳过回收站并单独确认，文件夹连同全部内容删除。

任务记录持久化不等于断点续传：应用重启后，未完成任务标记为「已中断」，需检查目标目录并重新发起。文件提交开始后会完成当前提交；取消或失败不会自动撤销已完成的文件操作。

### S3 管理与统计

- Bucket 创建、空桶删除、版本控制开关；Bucket 管理要求连接整个 Bucket，并在连接根目录操作，受限 Prefix 连接不提供这些操作。
- 历史版本分页浏览、恢复和删除，以及带有效期的临时分享链接。
- 查看和修改对象 Content-Type、Metadata、Tags、ACL；写操作受只读配置和服务权限约束。
- 详情面板显示对象数量与容量。通用 S3 统计读取配置 Bucket / Prefix 下最多 1,000 个对象，包含子目录和隐藏对象；结果不完整时标注已统计数量，不展示总容量。
- TOS 优先读取服务端桶级统计，即使配置了 Prefix，统计范围仍为整个桶；数据并非实时。读取失败时提示原因，并回退到配置位置的 S3 列表统计。

使用与实现细节见 [S3 与本机 RustFS](docs/11-s3.md)、[批量与文件夹操作](docs/12-batch-and-folders.md)、[冲突处理与大目录](docs/13-conflicts-and-paging.md)、[传输速度设置](docs/13-transfer-speed.md)、[浏览与 S3 高级管理](docs/14-browsing-and-s3-management.md) 和 [远程存储与文件操作](docs/15-remote-storage-and-file-workflow.md)。[开发指导索引](docs/README.md) 同时保留原始设计与阶段实施记录，当前功能以代码和本 README 为准。

## 工程结构

```text
apps/desktop/                 React + TypeScript + Tauri 2
crates/storage-domain/        领域类型、能力与错误、逻辑路径
crates/storage-provider-api/  自有 StorageBackend
crates/provider-opendal/      LocalFS / S3 / 远程协议适配、安全检查
crates/storage-repository/    SQLx + SQLite
crates/storage-application/   应用服务、操作规划、并行传输、预览与搜索
migrations/                  连接、存储空间、传输任务及限速设置迁移
docs/                        从 init.md 整理的开发指导
```

前端 `App.tsx` 负责查询、操作状态与页面组装；侧栏、顶部工具栏、概览、设置、文件浏览、详情及操作弹窗各自独立。`styles.css` 仅组织 `styles/` 下的分区样式，导入顺序保留层叠关系。

`provider-opendal` 的 `local/` 与 `s3/` 分别封装适配器，`remote/` 封装 FTP / FTPS、SFTP 和 SMB 协议，`s3_admin` 和 `tos_stats` 提供对象管理与 TOS 桶统计。`storage-application` 按存储位置管理（`volumes`）、文件操作（`entries`）、传输调度与执行（`transfers`）、预览与搜索（`browsing`）等职责划分；`storage-provider-api` 提供存储接口与共享限速器。

OpenDAL 类型只出现在 `provider-opendal` 中。为了防止并发目标覆盖，macOS/Linux 的文件及文件夹重命名使用 Provider 内封装的 `renameat_with(NOREPLACE)`，Windows 使用 `MoveFileExW` 且不启用覆盖或跨卷复制；浏览和删除使用 OpenDAL，本地目录以独占方式创建；流式传输使用 Provider 内部的文件句柄和独占临时文件，校验后以 no-clobber 方式发布。系统打开和回收站也封装在 Provider 内，前端只提交受约束的 StorageLocator，不安装或调用 FS Plugin。

复制和移动的目标位置须可写，移动的源位置也须可写。文件以最多 256 KiB 的缓冲块流式传输，低速限制下缩小读取块；大小与 SHA-256 校验通过后发布目标，默认拒绝同名目标，显式覆盖时校验目标状态后替换文件。调度器同时预留源和目标路径，在最多 3 个并行任务之间保护重叠路径，支持取消排队、复制及校验中的任务。

macOS 配置数据库位于 `~/Library/Application Support/dev.filo.desktop/filo.sqlite`，保存连接、传输记录和限速设置；S3 密钥和远程协议密码、私钥不写入 SQLite。隐藏文件、排序和详情面板偏好保存在本机，文件剪贴板仅在本次会话有效。

## 检查与打包

```bash
make check      # TypeScript、ESLint、Rust fmt / Clippy
make test       # Rust 单元与集成测试
pnpm build     # 前端生产构建
make build     # 当前平台安装包与 SHA-256；不修改版本
make dev       # 本地开发；macOS 自动固定签名，保留前端热更新和 Rust 重编译
make version-check # 校验 .env、.env.example 与所有项目版本
make test-release  # 发布脚本回归（临时仓库，不创建真实项目 tag）
make release V=v0.1.7 # 示例：指定新版本，创建本地版本提交和 annotated tag；不推送
```

本地开发统一使用 `make dev`（或 `pnpm dev`）。macOS 启动时从 `APPLE_SIGNING_IDENTITY` 环境变量、项目 `.env` 或 `~/.config/filo/signing/identity.txt` 读取已有证书；显式环境变量优先，值为空时回退到 `identity.txt`。每次 Cargo 编译成功后，将开发可执行文件复制到 `target/debug/dev-bundle/Filo.app`，固定签名并校验后启动；Rust 修改会自动重复这个流程，前端继续连接 Vite 热更新。Cargo 原始编译产物不被签名修改。证书缺失、无效或签名失败时停止，不退回临时签名；其他平台沿用普通 Tauri 开发流程。

初次 Rust 构建需要下载并编译桌面依赖。macOS app bundle 位于 `target/release/bundle/macos/Filo.app`，DMG 位于相邻的 `dmg/`；Windows 安装包位于 `target/release/bundle/nsis/`。

### 版本、自动构建与更新

`.env` 的 `version=vX.Y.Z` 是本机版本来源，允许保留其他配置且不提交；新检出与 CI 从 `.env.example` 重建。`make release` 默认递增 patch，`V` 可显式指定版本，也支持 `-alpha.N`、`-beta.N`、`-rc.N`。发布前要求工作区干净，构建只校验版本。pnpm 锁文件不存储 workspace 自身版本，Cargo 锁文件仅同步本项目 packages。

推送到 `main` 后，GitHub Actions 会验证并预热 Rust 编译缓存；首次预热完成后再推版本 tag 可避免冷编译。tag 发布时，macOS Apple Silicon（arm64）和 Windows x64 的验证与安装包构建并行执行，不构建 Intel Mac 版本。只有两端验证、构建都成功且所有产物完整、SHA-256 匹配时才公开 Release。预发布不进入稳定更新通道。

正式构建启动后自动检查最新正式版；「设置 → 软件更新」可手动检查及安装。安装前须完成或取消传输，安装后重启。开发模式与浏览器预览不请求更新。首次正式 Release 尚未发布时，检查会提示暂时无法检查更新。

更新包使用项目独立密钥签名；这不代表已配置 Apple Developer ID、公证或 Windows Authenticode。macOS 发布必须配置证书签名，缺少配置直接失败；自签证书不代表获得 Apple 信任或完成公证。Windows 未配置发布者签名。版本规则、Secrets、产物列表、发布重试与验证范围见 [发布指南](docs/releasing.md)。

### macOS 文件夹授权

下载、桌面、文稿等受保护目录首次访问时由 macOS 请求授权。`make dev` 保持同一证书、应用标识和开发应用路径，避免临时签名随重编译变化。首次启动或更换证书后仍可能需要授权；权限是否跨重启保留由 macOS 决定，需要在实际使用中验证。本地自签证书仅用于本机调试，不代表完成发行签名或公证。依据：[Apple 对签名身份的说明](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、[Tauri 签名配置](https://v2.tauri.app/distribute/sign/macos/)。

开发入口保留 Tauri 的进程监听和退出行为；Rust 每次重编译后自动重签名，前端热更新无需重新签名。目录列表与复制/移动目标目录不再因切回窗口或网络重连自动读取，文件浏览页默认定期检查外部变化（本地 5 秒、S3 15 秒），可关闭自动刷新；应用内操作完成后仍会刷新列表。拒绝访问后不会自动重试，可授权后手动重试。

本机签名文件统一保存在项目外的 `~/.config/filo/signing/`，采用与 Dayflow 相同的目录和命名方式：`certificate.p12` 包含加密的证书与私钥，`password.txt` 保存导出密码，`identity.txt` 保存构建使用的证书名称或指纹。目录权限为 `700`，文件权限为 `600`。迁移备份时需保留证书与密码，向他人提供证书文件时不要同时提供密码。

迁移到另一台 Mac 时，将签名目录放到新用户的 `~/.config/filo/signing/`，在「钥匙串访问」中导入 `certificate.p12` 并输入导出密码。`make dev` 读取 `identity.txt` 并使用钥匙串签名，不直接读取 `.p12`；迁移保留同一身份，不删除原钥匙串中的证书。不要重新生成证书代替迁移，否则签名身份会变化，新机器上的文件夹访问权限仍需重新授权。

开发签名回归验证：`node scripts/test-dev-signing.mjs`。仅在 macOS 上使用已配置证书，测试在临时 Cargo 项目中运行，不打开 Filo 或访问用户数据；覆盖重新编译后签名身份稳定、失败阻止启动、参数与退出码传递。
