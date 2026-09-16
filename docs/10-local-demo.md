# 本轮 LocalFS Demo

> 本文保留 LocalFS 阶段的实施历史；后续 S3 / Keychain / 跨存储传输已实现，见 [S3 与本机 RustFS](11-s3.md) 和 [批量与文件夹操作](12-batch-and-folders.md)。

## 本轮目标

按用户补充要求，先实现能够连接已有目录的 LocalFS 桌面演示。`init.md` 中 LocalFS + S3 + 传输引擎是完整 Demo 的目标，不能将本轮完成等同于全部验收完成。

## 实施顺序与结果

1. 将原任务书 22 节按职责拆成 9 份指导文档，保留章节编号与 `init.md` 原文，增加导航。
2. 创建 Rust workspace、Tauri 2、React、TypeScript、Vite、Tailwind、TanStack Query、Zustand、Lucide 与 `make dev`。
3. 实现 Domain → StorageBackend → LocalFS Provider → Application Service → Tauri Commands 纵向闭环。
4. 使用后端原生 Dialog 选择目录，完成 SQLite migration、去重添加、连接与 Volume 持久化。
5. 完成深色界面、概览、文件浏览、详情、筛选、排序、隐藏文件、基础写操作和错误状态。

当前提供命令：`list_connections`、`list_volumes`、`create_local_storage`、`update_local_storage`、`remove_local_storage`、`start_transfer`、`list_transfers`、`cancel_transfer`、`list_entries`、`stat_entry`、`open_entry`、`create_directory`、`rename_entry`、`delete_entry`。

## 安全与行为边界

- `create_local_storage` 只接收 `readOnly`；目录路径由 Rust 内部的系统选择器取得，不接受前端提交的绝对路径。
- 逻辑路径拒绝绝对路径、`..`、反斜杠、NUL、冒号；折叠 `.` 和重复分隔符。
- 访问前逐段检查符号链接并检查 canonical path；根目录被改为符号链接时拒绝继续使用。
- 符号链接显示为独立类型，禁止跟随与写操作。特殊设备文件不展示。
- Provider 执行只读检查、Volume ID 校验与根目录保护，前端隐藏/禁用不是唯一保护。
- 所有应用内写操作串行执行。删除必须收到确认；普通删除优先回收站，强制删除显式跳过回收站。永久删除仅支持普通文件或空目录。
- macOS/Linux 重命名使用原子 no-replace 系统调用，避免「检查后外部进程创建目标」导致覆盖。此原生补强封装在 OpenDAL Provider 内，不影响领域接口。
- 浏览/创建/删除仍通过 OpenDAL。现有路径检查不是针对恶意外部进程持续替换祖先目录的 OS 沙箱；后续如需对抗并发路径替换，需要将所有操作改为目录句柄相对访问。当前不应在不可信进程可任意改写的目录上使用写操作。
- SQLite 无任何 S3 凭据；当前不创建 Keychain 记录。传输表记录真实的本地单文件任务。

## 本轮取舍

| 任务书能力 | 本轮状态 | 下一步 |
| --- | --- | --- |
| 本地已有目录与持久化、编辑/移除连接 | 已实现 | S3 连接 |
| 列表、属性、新建目录、单文件重命名、确认删除 | 已实现 | 大目录分页/虚拟列表 |
| 原生目录选择 | 已实现 | 后续上传/下载的临时路径授权 |
| StorageBackend 流式读写接口 | 已接入读取与暂存写入契约 | 扩展 S3 Provider |
| ListPage / cursor | 本轮未接入 | 当前一次加载单层目录 |
| OperationPlanner | 应用服务独立模块，集中规划本地复制和移动 | 接入 S3 策略时扩展 |
| S3 / Keychain / MinIO | 未实现 | 按 S3 指导文档继续 |
| 本地文件复制、移动、取消与进度 | 已实现 | S3 上传下载、多任务并行 |
| 目录递归操作、监听、预览、全文搜索 | 不属于本轮 | 继续保持排除 |

原文 LocalFS `native_copy=true` 表示完整 Demo 目标；本轮返回 `false`，避免 UI 暗示尚不可用的能力。`recursive_delete=false`，目录不开放重命名。`range_read` 描述底层能力，读取接口目前用于文件传输，UI 尚未提供内容预览。

## 验证

自动化覆盖：逻辑路径标准化和拒绝逃逸、只读能力、浏览已有文件、创建目录、重命名保持内容、已有目标冲突、空目录删除、拒绝非空目录删除、符号链接逃逸，以及 SQLite 重启持久化。

手工验收流程：启动桌面 → 添加已有目录 → 浏览实际文件 → 进入子目录 → 面包屑回退 → 筛选/显示隐藏文件 → 选中文件看属性 → 在测试目录创建文件夹 → 关闭并重新启动确认连接仍在。

2026-09-16 验证结果：

- `cargo test --workspace`：8 项测试通过，包含额外的原子防覆盖和应用服务确认/Volume 授权测试。
- `cargo fmt --all --check`、`cargo clippy --workspace --all-targets -- -D warnings` 通过。
- `pnpm check`、`pnpm lint`、`pnpm build` 通过。
- `pnpm --filter @filo/desktop tauri build --debug --bundles app` 成功生成 macOS app，已在本机启动。
- 原生窗口中实际选择 `/Users/leo/work/filo`，以只读方式添加；显示现有文件与真实大小/修改时间。
- 实际操作验证：双击进入 `docs`、上级导航、按 `local` 筛选出 2 项、清除筛选、显示隐藏文件、属性面板和只读按钮禁用。
- 重启持久化由 SQLite 关闭/重开测试覆盖。用户开始操作应用后，保留其当前窗口，未再执行手工重启。
- 文件写操作通过临时目录集成测试验证，未对用户已有文件进行改名或删除。

演示应用：`target/debug/bundle/macos/Filo.app`。这是开发构建，尚未进行发行签名、公证或 Windows/Linux 实机验收。

## Finder 浅色界面调整

按用户后续提供的 Finder 参考图调整当前界面：固定浅色，灰色侧栏、白色列表、蓝色选中项、交替行底色和系统字体；合并顶部导航与文件操作，路径栏移至底部，详情默认收起。概览去除宣传性大标题与装饰区，保留真实连接与目录信息。原生窗口也固定浅色，使用融合式标题栏和系统窗口按钮。后端文件能力不变，主题切换暂不实现。

验证：TypeScript、ESLint、前端生产构建、macOS 开发应用打包通过。在原生窗口实测已有连接恢复、文件列表、蓝色选中态、详情开关、双击目录、底部路径返回和浅色添加目录弹窗；保留新版窗口供体验。

## 位置连接编辑

右键侧栏位置 →「编辑连接…」，支持修改显示名称、切换只读，以及勾选更换本地目录。更换目录在保存时调用 Rust 原生选择器，不接受前端绝对路径，也不移动文件；取消选择不保存任何配置。连接与 Volume 在同一 SQLite 事务中更新，目录冲突或校验失败时整体回滚。配置更新和文件写操作共用串行锁，后续操作重新读取只读权限；更换目录后清理列表缓存并将该位置的导航记录重置到根目录。

验证：11 项 Rust 测试、fmt、Clippy、TypeScript、ESLint、前端构建及 macOS app 打包通过。新增测试覆盖编辑后重开数据库持久化、重复目录事务回滚、只读开关立即阻止写操作、根目录切换且不移动文件。原生窗口实测右键菜单、名称保存、只读开关与工具栏即时更新、系统目录选择器取消且数据库配置不变；测试后恢复原来的名称和只读设置。


## 本地单文件传输与移除位置

- 右键位置 →「移除位置…」，确认后事务移除本地配置，清理前端导航历史和缓存；磁盘文件保留，可重新添加。
- 文件工具栏和操作菜单增加「复制到…」「移动到…」，选择已连接的可写位置及子目录，并可修改目标文件名。
- 应用服务 `operation_planner` 模块集中选择策略：同 Volume 移动使用原生防覆盖重命名，其余复制/移动使用流式传输。目录、符号链接暂不参与传输。
- 读取和暂存写入通过 `StorageBackend` / `StagedWrite` 契约封装。Local Provider 使用文件句柄和独占临时文件，256 KiB 有界缓冲；写入后读回计算 SHA-256，与源流摘要及大小比较，成功后 `persist_noclobber` 发布。普通失败与取消自动清理临时文件。
- 跨 Volume 移动仅在校验和发布目标后删除源文件；期间发现源文件大小或修改时间变化会失败并保留源文件。发布后删除源失败，错误会注明目标已经保存。
- 本轮沿用应用内串行写策略，一次执行一个本地传输，最多 100 个待完成任务。`CancellationToken` 支持排队、复制和校验阶段取消；发布或原生重命名开始后不回滚，返回实际完成结果。
- 活跃任务登记期间禁止编辑或移除相关位置，避免排队中的任务因配置变更访问另一个根目录。任务执行时再次检查权限和文件种类。
- 任务及进度写入现有 SQLite `transfer_jobs` 表，通过 Tauri Channel 推送，列表轮询兜底；界面显示最近 200 项任务。重启将排队、执行和校验中的遗留任务标记为 Interrupted，不自动恢复。

当前限制：只传输文件内容，不保留 ACL、扩展属性和原修改时间；无目录递归、覆盖同名文件、断点续传或 S3。强制结束进程可能遗留目标目录中的隐藏 `.filo-transfer-*` 临时文件；Interrupted 任务可能已发布目标，应检查后重新操作。外部进程恶意替换路径的边界仍与上文一致。

自动化验证：20 项 Rust 测试通过，覆盖真实文件复制内容一致、跨位置移动、同位置原生移动、空文件、目标冲突与暂存清理、校验阶段取消、排队取消、源文件变化、只读/连接变更限制、重启中断恢复，以及移除位置保留文件。TypeScript、ESLint、前端构建和 Clippy 通过。

桌面验收：用隔离临时位置，在原生窗口选择 `sample.txt`，打开复制弹窗、进入 `destination` 子目录并执行复制；任务页显示已完成，落盘文件 32,000 字节且与源文件 SHA-256 一致。验证右键「移除位置…」及取消。测试目录、测试连接和测试任务已清理，保留用户原有两个只读位置。系统目录选择器的自动化路径输入不稳定，本次传输界面验收使用隔离测试配置；系统选择器自身沿用已验收的实现。


## 文件打开、回收站与强制删除

- 双击、Enter、工具栏「打开」及文件右键「打开」使用系统默认应用打开普通文件；文件夹仍在 Filo 内导航。显示简介保留为独立入口。
- 新增 `native_open`、`trash` 能力，以及 `DeleteMode::{Default, Permanent}` / `DeleteOutcome`。应用层根据能力选择删除策略：Default 优先 trash，不支持时永久删除；Permanent 始终跳过回收站。回收站失败直接返回错误，绝不静默永久删除。
- Local Provider 使用 `open` 调用系统默认应用，`trash` 调用系统回收站。macOS 显式使用 NSFileManager 原生 API，避免 Finder 自动化授权；可从系统回收站拖出文件恢复，部分系统不提供「放回原处」。
- 右键文件菜单与省略号共用定位到视口内的菜单，支持方向键、Escape、点击外部关闭。复制、移动继续使用现有校验传输流程；目录递归复制/移动仍未接入。
- 普通删除可将非空本地文件夹整体移入回收站；强制删除文件夹仍只允许空目录。删除确认弹窗清楚区分移入回收站与不可恢复的永久删除。
- 打开、回收站和永久删除均在后端验证 Locator、根目录和符号链接。只读禁止两种删除，允许打开；只读约束 Filo 内的写操作，外部应用仍按操作系统权限运行。
- 移动完成后的源文件清理继续使用底层永久删除接口，避免每次移动都制造回收站副本。

验证：23 项自动测试通过；额外显式运行 macOS 原生回收站集成测试，验证测试文件进入真实回收站且内容完整，并清理该 UUID 测试文件。策略测试覆盖优先回收站、无回收站后端、显式永久删除、回收站失败不降级和只读拒绝；路径测试覆盖打开的授权范围及符号链接限制。前端 TypeScript、ESLint、生产构建通过。

依赖依据：[trash API](https://docs.rs/trash/5.2.9/trash/)、[open API](https://docs.rs/open/5.4.4/open/fn.that.html)。

桌面实测：文件右键完整菜单、普通删除回收站确认、强制删除永久删除确认和取消；双击隔离测试文件后，TextEdit 打开同一路径并显示预期内容。测试文件与文件夹在取消后保持完整，临时连接及文件已清理。macOS 应用打包、fmt、Clippy 与 diff 检查通过。

普通删除补充：后端以 `trash_unavailable` 区分系统回收站不可用与权限/路径校验失败。无法移入时弹窗显示「继续删除将永久删除，无法找回」，用户可取消或点击「仍然永久删除」发起独立的 Permanent 请求。权限或路径错误不显示此选项。无回收站能力的后端在第一次确认时使用相同的无法找回提示。新增策略测试验证回收站失败后不会删除，只有新的永久删除请求才执行删除。

## macOS 文件夹授权重复提示

用户反馈访问下载目录频繁出现系统授权弹窗。检查此前演示包发现只有 linker ad-hoc 签名，签名标识为 Rust 可执行文件名称，designated requirement 直接绑定 `cdhash`。这意味着代码重建会改变 macOS 用于识别该版本的签名要求，与连续重新打包后再次授权的现象一致；未读取或改写系统 TCC 授权数据库。

- 当时新增本机演示打包入口，从本机 `.env` 或显式环境变量读取 `APPLE_SIGNING_IDENTITY`，调用 Tauri 生成固定证书签名的 macOS 演示包。拒绝空身份或 `-` 临时签名；`.env` 已忽略，仓库仅提供 `.env.example`。不自动创建、导入或调整证书信任。发行构建与公证仍是独立工作。
- 本机复用已有签名证书，包身份变为 `dev.filo.desktop`，designated requirement 绑定应用标识与证书，避免每次构建绑定新的代码哈希。切换签名后第一次访问仍可能需要用户授权。
- 所有 `entries` 查询（文件列表和传输目标浏览）关闭窗口重新获得焦点、网络重连时的自动读取；保留导航、手动刷新、文件操作后的失效刷新。外部文件变动需要点击刷新。传输任务轮询不受影响。

验证：TypeScript、ESLint、前端生产构建与签名演示包构建通过；`codesign --verify --deep --strict` 通过。在临时副本修改 Info.plist 并重新签名后，代码哈希发生变化，designated requirement 保持一致，严格签名验证通过；副本已清理。系统实际授权是否跨后续构建保留仍需用户授权后的使用验证，没有替用户点击系统授权按钮。

依据：[Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、[Tauri macOS 签名](https://v2.tauri.app/distribute/sign/macos/)。

签名文件后续统一迁移至 `~/.config/filo/signing/`，沿用 Dayflow 命名：`certificate.p12`、`password.txt`、`identity.txt`。迁移前后证书与密码文件内容一致，旧项目目录中的副本已移走。本机开发入口在 `APPLE_SIGNING_IDENTITY` 未设置或为空时读取该目录的 `identity.txt`；签名仍使用钥匙串中的原证书。


## 本地开发统一入口

本地开发现统一为 `make dev`，已移除独立的 demo Make 目标和 `scripts/build-demo.mjs`。`scripts/dev.mjs` 在 macOS 上读取现有证书，给 Tauri 的 Cargo 调用注入目标 runner。`scripts/dev-runner.sh` 在每次编译成功后生成并固定签名 `target/debug/dev-bundle/Filo.app`，严格验证后用 `exec` 启动，保留 Rust 重编译、应用退出码和进程清理行为。前端继续使用 Vite 热更新。Cargo 的原始可执行文件保持不变，签名失败不会启动旧包或临时签名程序。`make build` 继续用于 Release 打包。
