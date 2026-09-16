# Filo · 菲洛

本地优先的桌面存储管理器。当前为 **LocalFS 初版 Demo**，可以选择已有、带文件的目录；没有模拟文件数据，也不需要后端服务器。

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
- 文件属性、新建文件夹、单文件重命名、确认后删除文件或空目录。
- 只读模式、根目录保护、路径逃逸检查、符号链接禁止跟随。
- Finder 风格浅色界面、原生窗口按钮、紧凑文件列表、概览与详情面板、加载/空列表/错误状态。当前固定浅色，主题切换留待后续。

删除为永久删除，不进入系统回收站。重命名不会覆盖同名目标；不支持目录重命名和递归删除。双击普通文件显示属性，不启动外部应用。

S3、Keychain、复制/移动、上传/下载与传输进度属于下一阶段，本轮没有实现。参见 [本轮实施记录](docs/10-local-demo.md) 与 [完整指导文档](docs/README.md)。

## 工程结构

```text
apps/desktop/                 React + TypeScript + Tauri 2
crates/storage-domain/        领域类型、能力与错误、逻辑路径
crates/storage-provider-api/  自有 StorageBackend
crates/provider-opendal/      LocalFS 适配、安全检查
crates/storage-repository/    SQLx + SQLite
crates/storage-application/   应用服务，串行写操作
migrations/                  连接、存储空间、预留传输任务表
docs/                        从 init.md 整理的开发指导
```

OpenDAL 类型只出现在 `provider-opendal` 中。为了防止并发目标覆盖，macOS/Linux 的单文件重命名使用 Provider 内封装的 `renameat_with(NOREPLACE)`；浏览、创建目录与删除仍使用 OpenDAL。前端不安装或调用 FS Plugin。

macOS 配置数据库位于 `~/Library/Application Support/dev.filo.desktop/filo.sqlite`。不会复制或导入所选目录中的文件。当前浏览偏好只在本次会话保留。

## 检查与打包

```bash
make check      # TypeScript、ESLint、Rust fmt / Clippy
make test       # Rust 单元与集成测试
pnpm build     # 前端生产构建
make build     # Tauri app bundle
```

快速生成本机演示包：`pnpm --filter @filo/desktop tauri build --debug --bundles app`，随后打开 `target/debug/bundle/macos/Filo.app`。

初次 Rust 构建需要下载并编译桌面依赖。macOS app bundle 位于 `target/release/bundle/macos/Filo.app`；尚未配置发行签名或公证。
