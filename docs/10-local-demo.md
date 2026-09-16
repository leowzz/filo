# 本轮 LocalFS Demo

## 本轮目标

按用户补充要求，先实现能够连接已有目录的 LocalFS 桌面演示。`init.md` 中 LocalFS + S3 + 传输引擎是完整 Demo 的目标，不能将本轮完成等同于全部验收完成。

## 实施顺序与结果

1. 将原任务书 22 节按职责拆成 9 份指导文档，保留章节编号与 `init.md` 原文，增加导航。
2. 创建 Rust workspace、Tauri 2、React、TypeScript、Vite、Tailwind、TanStack Query、Zustand、Lucide 与 `make dev`。
3. 实现 Domain → StorageBackend → LocalFS Provider → Application Service → Tauri Commands 纵向闭环。
4. 使用后端原生 Dialog 选择目录，完成 SQLite migration、去重添加、连接与 Volume 持久化。
5. 完成深色界面、概览、文件浏览、详情、筛选、排序、隐藏文件、基础写操作和错误状态。

当前提供命令：`list_connections`、`list_volumes`、`create_local_storage`、`update_local_storage`、`list_entries`、`stat_entry`、`create_directory`、`rename_entry`、`delete_entry`。

## 安全与行为边界

- `create_local_storage` 只接收 `readOnly`；目录路径由 Rust 内部的系统选择器取得，不接受前端提交的绝对路径。
- 逻辑路径拒绝绝对路径、`..`、反斜杠、NUL、冒号；折叠 `.` 和重复分隔符。
- 访问前逐段检查符号链接并检查 canonical path；根目录被改为符号链接时拒绝继续使用。
- 符号链接显示为独立类型，禁止跟随与写操作。特殊设备文件不展示。
- Provider 执行只读检查、Volume ID 校验与根目录保护，前端隐藏/禁用不是唯一保护。
- 所有应用内写操作串行执行。删除必须收到确认，只删除普通文件或空目录。
- macOS/Linux 重命名使用原子 no-replace 系统调用，避免「检查后外部进程创建目标」导致覆盖。此原生补强封装在 OpenDAL Provider 内，不影响领域接口。
- 浏览/创建/删除仍通过 OpenDAL。现有路径检查不是针对恶意外部进程持续替换祖先目录的 OS 沙箱；后续如需对抗并发路径替换，需要将所有操作改为目录句柄相对访问。当前不应在不可信进程可任意改写的目录上使用写操作。
- SQLite 无任何 S3 凭据；当前不创建 Keychain 记录。传输表已建，但没有生成虚假任务。

## 本轮取舍

| 任务书能力 | 本轮状态 | 下一步 |
| --- | --- | --- |
| 本地已有目录与持久化、编辑名称/只读/目录 | 已实现 | 增加移除连接 |
| 列表、属性、新建目录、单文件重命名、确认删除 | 已实现 | 大目录分页/虚拟列表 |
| 原生目录选择 | 已实现 | 后续上传/下载的临时路径授权 |
| StorageBackend 流式读写接口 | 本轮未接入 | 与 TransferEngine 一起实现，避免空实现 |
| ListPage / cursor | 本轮未接入 | 当前一次加载单层目录 |
| OperationPlanner | 仅有 LocalFS 文件重命名策略，位于应用服务 | 复制/移动接入时单独建 crate |
| S3 / Keychain / MinIO | 未实现 | 按 S3 指导文档继续 |
| 文件复制、移动、上传、下载、取消与进度 | 未实现 | 流式传输、有界缓冲、校验后删源 |
| 目录递归操作、监听、预览、全文搜索 | 不属于本轮 | 继续保持排除 |

原文 LocalFS `native_copy=true` 表示完整 Demo 目标；本轮返回 `false`，避免 UI 暗示尚不可用的能力。`recursive_delete=false`，目录不开放重命名。`range_read` 描述底层能力，UI 尚未开放读取文件内容。

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
