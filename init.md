# Filo Demo 实现任务书

## 1. 项目定位

项目名称：**Filo**

中文名称：**菲洛**

命名含义：`File + I/O`，短、顺口、有开发者工具感，适合做桌面应用和 CLI。

Filo 是一个本地优先的桌面存储管理器，用统一的文件管理器界面管理不同类型的存储空间。

Demo 初版只实现两种 Provider：

1. 本地文件系统 LocalFS
2. S3 Compatible Object Storage

典型使用场景：

* 添加一个本地目录，例如 `/Users/leo/Documents`
* 添加一个 S3 Bucket，例如 MinIO、AWS S3、Cloudflare R2、阿里云 OSS 的 S3 兼容端点
* 浏览目录或对象
* 创建目录
* 上传、下载、复制、移动、重命名、删除文件
* 在本地和 S3 之间传输文件
* 查看传输进度和错误信息

这是桌面应用，不依赖服务端。

---

## 2. 技术栈

前端：

```text
Tauri 2
React
TypeScript
Vite
Tailwind CSS
TanStack Query
Zustand
Lucide Icons
```

Rust 后端：

```text
Rust stable
Tokio
OpenDAL
SQLx + SQLite
Serde
UUID
async-trait
thiserror
tracing
keyring
tokio-util CancellationToken
```

实现策略：

* LocalFS 和 S3 初版都使用 OpenDAL。
* 业务层不能直接依赖 OpenDAL 类型。
* 必须在 OpenDAL 外包装自己的 `StorageBackend`。
* 后续允许将 LocalFS 替换为原生实现。
* 敏感凭据存储到系统 Keychain，不允许写入 SQLite。
* Tauri Command 用于普通请求。
* 文件传输进度使用 Tauri Channel，不要用高频全局 Event。

---

## 3. 核心架构

```text
React UI
    │
    │ Tauri Commands / Channels
    ▼
Application Services
    ├── ConnectionService
    ├── BrowserService
    ├── TransferService
    └── OperationPlanner
    │
    ▼
Storage Domain
    ├── StorageConnection
    ├── StorageVolume
    ├── StorageLocator
    ├── StorageEntry
    ├── StorageCapabilities
    └── StorageBackend
    │
    ▼
Providers
    ├── OpenDalLocalBackend
    └── OpenDalS3Backend
    │
    ▼
Infrastructure
    ├── SQLite
    ├── System Keychain
    └── Local Logs
```

必须遵循以下原则：

1. Connection 和 Volume 是两个不同概念。
2. UI 不直接操作 OpenDAL。
3. UI 不根据 `provider == "s3"` 判断操作是否可用。
4. 操作是否可用由 `StorageCapabilities` 决定。
5. 跨存储移动必须先复制、校验成功，再删除源文件。
6. S3 的目录是虚拟 Prefix，不是真实目录。
7. S3 重命名通常是 Copy + Delete，不是原子 Rename。

---

## 4. Connection 与 Volume

### StorageConnection

表示一个 Provider 的连接信息。

例如：

```text
S3 Endpoint
Region
Access Key
Secret Key
Force Path Style
```

### StorageVolume

表示一个可浏览的根目录。

例如：

```text
本地：
/Users/leo/Documents

S3：
bucket = assets
prefix = production/
```

一个 S3 Connection 可以对应多个 Volume：

```text
S3 Connection: Production Storage
├── assets/
├── backups/
└── logs/2026/
```

建议数据结构：

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    LocalFs,
    S3,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StorageConnection {
    pub id: uuid::Uuid,
    pub name: String,
    pub provider: ProviderKind,

    /// 非敏感配置，例如 endpoint、region、force_path_style。
    pub config: serde_json::Value,

    /// 指向系统 Keychain。
    pub credential_ref: Option<String>,

    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StorageVolume {
    pub id: uuid::Uuid,
    pub connection_id: uuid::Uuid,
    pub name: String,
    pub root: VolumeRoot,
    pub read_only: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VolumeRoot {
    Local {
        root_path: std::path::PathBuf,
    },
    S3 {
        bucket: String,
        prefix: String,
    },
}
```

---

## 5. 统一路径模型

业务层统一使用逻辑路径 `/`，不直接暴露操作系统路径或 S3 Key。

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StorageLocator {
    pub volume_id: uuid::Uuid,

    /// 相对于 Volume Root 的路径。
    ///
    /// 根目录使用空字符串。
    /// 示例：images/avatar.png
    pub logical_path: String,

    /// S3 Version ID 等可选信息。
    pub version_id: Option<String>,
}
```

路径规则：

* 禁止绝对路径。
* 禁止 `..`。
* 禁止路径逃逸 Volume Root。
* LocalFS 访问必须限制在配置的根目录内。
* 路径标准形式不以 `/` 开头。
* 目录路径在业务层不强制以 `/` 结尾。
* Provider Adapter 负责将逻辑路径转换为本地路径或 S3 Key。

---

## 6. StorageEntry

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageEntryKind {
    File,
    Directory,
    VirtualPrefix,
    Symlink,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StorageEntry {
    pub locator: StorageLocator,
    pub name: String,
    pub kind: StorageEntryKind,

    pub size: Option<u64>,
    pub modified_at: Option<String>,

    pub etag: Option<String>,
    pub content_type: Option<String>,

    pub metadata: serde_json::Value,
}
```

S3 中：

```text
File          对应真实对象
VirtualPrefix 对应通过 Prefix 推导出的虚拟目录
```

本地文件系统中：

```text
File
Directory
Symlink
```

---

## 7. 能力模型

不要假设所有 Provider 都支持相同操作。

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HierarchySemantics {
    NativeDirectory,
    VirtualPrefix,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenameSemantics {
    Atomic,
    CopyThenDelete,
    Unsupported,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StorageCapabilities {
    pub hierarchy: HierarchySemantics,
    pub rename: RenameSemantics,

    pub create_directory: bool,
    pub range_read: bool,
    pub multipart_write: bool,
    pub native_copy: bool,
    pub server_side_copy: bool,
    pub recursive_delete: bool,

    pub presigned_url: bool,
    pub versioning: bool,
    pub custom_metadata: bool,
    pub tags: bool,
    pub watch_changes: bool,
}
```

Demo 中至少返回：

### LocalFS

```text
hierarchy          = NativeDirectory
rename             = Atomic
create_directory   = true
range_read         = true
native_copy        = true
watch_changes      = false，初版不做文件监听
presigned_url      = false
versioning         = false
```

### S3

```text
hierarchy          = VirtualPrefix
rename             = CopyThenDelete
create_directory   = true，通过零字节目录标记实现
range_read         = true
multipart_write    = true
server_side_copy   = true
presigned_url      = 暂不实现
versioning         = 暂不实现
```

---

## 8. StorageBackend 接口

接口语义如下，具体类型可根据 OpenDAL 最新 API 调整。

```rust
#[async_trait::async_trait]
pub trait StorageBackend: Send + Sync {
    fn volume_id(&self) -> uuid::Uuid;

    fn capabilities(&self) -> StorageCapabilities;

    async fn list(
        &self,
        request: ListRequest,
    ) -> StorageResult<ListPage>;

    async fn stat(
        &self,
        locator: &StorageLocator,
    ) -> StorageResult<StorageEntry>;

    async fn create_dir(
        &self,
        locator: &StorageLocator,
    ) -> StorageResult<()>;

    async fn delete(
        &self,
        locator: &StorageLocator,
        recursive: bool,
    ) -> StorageResult<()>;

    async fn rename(
        &self,
        source: &StorageLocator,
        target: &StorageLocator,
    ) -> StorageResult<()>;

    async fn copy_native(
        &self,
        source: &StorageLocator,
        target: &StorageLocator,
    ) -> StorageResult<()>;

    async fn open_reader(
        &self,
        locator: &StorageLocator,
    ) -> StorageResult<BoxAsyncReader>;

    async fn open_writer(
        &self,
        locator: &StorageLocator,
        expected_size: Option<u64>,
    ) -> StorageResult<BoxAsyncWriter>;
}
```

还需要：

```rust
pub struct ListRequest {
    pub parent: StorageLocator,
    pub cursor: Option<String>,
    pub limit: usize,
}

pub struct ListPage {
    pub entries: Vec<StorageEntry>,
    pub next_cursor: Option<String>,
}
```

所有 OpenDAL 类型必须限制在 Provider crate 内部，不能进入 Domain、Application 或 UI DTO。

---

## 9. OperationPlanner

所有复制、移动和重命名策略必须集中在 `OperationPlanner`，不能散落在 UI 或 Tauri Command 中。

```rust
pub enum OperationPlan {
    NativeRename,

    NativeCopy {
        delete_source_after_copy: bool,
    },

    StreamCopy {
        delete_source_after_copy: bool,
        verify_target: bool,
    },
}
```

基本规则：

```text
同一个 Local Volume 内移动
    → NativeRename

同一个 S3 Volume 内重命名
    → Server-side Copy
    → 校验目标
    → Delete Source

Local → S3
    → Stream Copy

S3 → Local
    → Stream Copy

不同 S3 Connection
    → Stream Copy

跨 Volume Move
    → Stream Copy
    → 校验目标
    → Delete Source
```

禁止在目标文件成功写入并验证前删除源文件。

Demo 初版只要求文件级复制和移动。

暂不实现：

* 非空目录递归复制
* 非空目录递归移动
* S3 Prefix 批量 Rename

对应按钮可以禁用，并展示“Demo 初版暂不支持目录递归操作”。

---

## 10. TransferEngine

传输任务状态：

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferState {
    Queued,
    Running,
    Verifying,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}
```

任务模型：

```rust
pub struct TransferJob {
    pub id: uuid::Uuid,
    pub kind: TransferKind,

    pub source: TransferEndpoint,
    pub destination: TransferEndpoint,

    pub state: TransferState,

    pub bytes_total: Option<u64>,
    pub bytes_transferred: u64,

    pub error_code: Option<String>,
    pub error_message: Option<String>,

    pub created_at: String,
    pub updated_at: String,
}
```

传输要求：

* 流式读取和写入，禁止把整个文件加载到内存。
* 使用有界缓冲区。
* 支持进度回调。
* 支持取消。
* 使用 `CancellationToken`。
* 同时最多执行 3 个任务。
* 任务状态写入 SQLite。
* 应用启动时，将遗留的 `Running` 状态改成 `Interrupted`。
* Demo 初版不要求断点续传。
* Demo 初版不要求暂停和恢复。
* 失败时保留清晰错误信息。
* Move 任务只有在目标验证成功后才删除源文件。

验证规则：

```text
优先比较明确的 checksum
否则比较 size
如果两者都不可用，则只确认目标 stat 成功
```

进度通过 Tauri Channel 推送：

```typescript
type TransferProgress = {
  jobId: string;
  state: TransferState;
  bytesTransferred: number;
  bytesTotal?: number;
  speedBytesPerSecond?: number;
  error?: {
    code: string;
    message: string;
  };
};
```

---

## 11. S3 配置

Connection 配置：

```rust
pub struct S3ConnectionConfig {
    pub endpoint: Option<String>,
    pub region: String,
    pub force_path_style: bool,
}
```

凭据单独存储：

```rust
pub struct S3Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}
```

Volume 配置：

```rust
pub struct S3VolumeConfig {
    pub bucket: String,
    pub prefix: String,
}
```

新增 S3 表单字段：

```text
连接名称
Endpoint
Region
Access Key ID
Secret Access Key
Session Token，可选
Force Path Style
Bucket
Prefix，可选
```

连接测试不能依赖 `ListBuckets`，因为 Bucket 级凭据可能没有列举 Bucket 的权限。

测试方式：

```text
构建 Operator
    ↓
对 Bucket Root 或 Prefix 执行 stat/list
    ↓
返回成功或结构化错误
```

---

## 12. LocalFS 安全要求

本地 Volume 只能访问被选择的根目录。

必须实现：

* 拒绝绝对逻辑路径。
* 拒绝 `..`。
* 规范化路径。
* 检查最终路径仍在根目录下。
* 默认禁止通过符号链接逃逸根目录。
* 支持 `read_only`。
* 所有删除操作必须二次确认。

前端不能直接使用 Tauri FS Plugin 读写任意文件。

所有存储操作必须经过 Rust Backend。

---

## 13. 错误模型

统一错误类型：

```rust
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageErrorCode {
    InvalidConfiguration,
    InvalidPath,
    AuthenticationFailed,
    AccessDenied,
    NotFound,
    AlreadyExists,
    Conflict,
    Unsupported,
    Network,
    Timeout,
    Io,
    Cancelled,
    Internal,
}

#[derive(Debug, serde::Serialize)]
pub struct StorageErrorDto {
    pub code: StorageErrorCode,
    pub message: String,
    pub retryable: bool,
    pub details: Option<serde_json::Value>,
}
```

要求：

* 不允许直接把 OpenDAL 原始错误暴露给前端。
* 日志中不能打印 Secret Key、Session Token 或 Authorization Header。
* 用户界面展示友好错误。
* 日志保留底层错误链，但必须脱敏。

---

## 14. SQLite 表

至少创建以下表。

### connections

```sql
CREATE TABLE connections (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    provider        TEXT NOT NULL,
    config_json     TEXT NOT NULL,
    credential_ref  TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
```

### volumes

```sql
CREATE TABLE volumes (
    id              TEXT PRIMARY KEY,
    connection_id   TEXT NOT NULL,
    name            TEXT NOT NULL,
    root_json       TEXT NOT NULL,
    read_only       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,

    FOREIGN KEY(connection_id)
        REFERENCES connections(id)
        ON DELETE CASCADE
);
```

### transfer_jobs

```sql
CREATE TABLE transfer_jobs (
    id                  TEXT PRIMARY KEY,
    kind                TEXT NOT NULL,
    source_json         TEXT NOT NULL,
    destination_json    TEXT NOT NULL,
    state               TEXT NOT NULL,
    bytes_total         INTEGER,
    bytes_transferred   INTEGER NOT NULL DEFAULT 0,
    error_code          TEXT,
    error_message       TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
```

初版不实现本地全文索引，因此暂时不创建 `storage_entry_index`。

---

## 15. Tauri Commands

至少提供：

```text
list_connections
create_local_storage
create_s3_storage
update_connection
delete_connection
test_s3_connection

list_volumes
list_entries
stat_entry
create_directory
rename_entry
delete_entry

start_copy
start_move
cancel_transfer
list_transfer_jobs
```

本地文件选择使用 Tauri Dialog。

上传按钮允许用户选择本地文件，然后将本地路径作为临时传输源。

下载按钮允许用户选择目标目录，然后将目标路径作为临时传输目标。

可以定义：

```rust
pub enum TransferEndpoint {
    Storage(StorageLocator),

    /// 仅用于文件选择器选择的临时本地路径。
    ExternalLocalPath {
        path: std::path::PathBuf,
    },
}
```

`ExternalLocalPath` 只能由后端根据文件选择器结果构造，不能直接信任前端传入任意路径。

---

## 16. UI 结构

整体风格参考 macOS 深色文件管理器。

页面：

```text
Overview
Storage Browser
Transfers
Settings
```

左侧栏：

```text
Overview
Transfers

Locations
├── Documents
├── Backup Disk
├── Production S3
└── Local MinIO
```

浏览页面：

```text
┌─────────────────────────────────────────────────┐
│ Back / Forward / Breadcrumb / Refresh           │
│ New Folder / Upload / Download / Copy / Delete  │
├─────────────────────────────────────────────────┤
│ Name              Size       Modified     Type  │
│ photo.jpg          3.2 MB     ...          File │
│ images             —          ...          Dir  │
├─────────────────────────────────────────────────┤
│ Transfer Drawer                                 │
└─────────────────────────────────────────────────┘
```

必须实现：

* Breadcrumb。
* 表格文件列表。
* 双击进入目录。
* 返回上级目录。
* 刷新。
* 创建目录。
* 上传文件。
* 下载文件。
* 重命名文件。
* 删除文件。
* 文件复制和移动。
* 传输任务抽屉。
* Loading、Empty、Error 状态。
* 右键菜单或操作菜单。
* 根据 Capability 控制菜单是否显示。

Overview 页面展示：

```text
连接数量
Volume 数量
运行中的任务数量
失败任务数量
最近使用的 Volume
```

对于 Local Volume 可以展示真实磁盘容量。

对于 S3 不能伪造“总容量”和“剩余空间”，只展示：

```text
Endpoint
Bucket
Prefix
连接状态
```

---

## 17. 建议目录结构

```text
filo/
├── Cargo.toml
├── package.json
├── pnpm-workspace.yaml
│
├── apps/
│   └── desktop/
│       ├── package.json
│       ├── src/
│       │   ├── components/
│       │   ├── pages/
│       │   ├── hooks/
│       │   ├── stores/
│       │   ├── api/
│       │   └── types/
│       │
│       └── src-tauri/
│           ├── Cargo.toml
│           ├── capabilities/
│           └── src/
│               ├── commands/
│               ├── state.rs
│               └── main.rs
│
├── crates/
│   ├── storage-domain/
│   │   └── src/
│   │       ├── connection.rs
│   │       ├── volume.rs
│   │       ├── locator.rs
│   │       ├── entry.rs
│   │       ├── capability.rs
│   │       └── error.rs
│   │
│   ├── storage-provider-api/
│   │   └── src/
│   │       ├── backend.rs
│   │       └── registry.rs
│   │
│   ├── provider-opendal/
│   │   └── src/
│   │       ├── local.rs
│   │       ├── s3.rs
│   │       └── mapper.rs
│   │
│   ├── operation-planner/
│   ├── transfer-engine/
│   ├── storage-repository/
│   └── credential-store/
│
├── migrations/
│   └── 0001_initial.sql
│
├── infra/
│   └── docker-compose.minio.yml
│
└── README.md
```

---

## 18. MinIO 开发环境

提供一个 `docker-compose.minio.yml`：

```text
MinIO Server
MinIO Console
默认测试 Bucket：filo-demo
```

README 中写明：

```bash
docker compose -f infra/docker-compose.minio.yml up -d
```

测试配置示例：

```text
Endpoint: http://127.0.0.1:9000
Region: us-east-1
Access Key: minioadmin
Secret Key: minioadmin
Force Path Style: true
Bucket: filo-demo
```

---

## 19. 实现顺序

### 阶段一：工程初始化

完成：

```text
Tauri 2 + React + TypeScript
Rust Workspace
Tailwind
SQLite Migration
tracing
基础 AppShell
```

### 阶段二：领域模型

完成：

```text
StorageConnection
StorageVolume
StorageLocator
StorageEntry
StorageCapabilities
StorageBackend
StorageError
```

为路径标准化和能力模型编写单元测试。

### 阶段三：LocalFS

完成：

```text
添加本地目录
浏览目录
stat
创建目录
重命名
删除
流式读取
流式写入
根目录逃逸检查
```

### 阶段四：S3

完成：

```text
添加 S3 连接
Keychain 保存凭据
测试连接
浏览 Bucket 和 Prefix
创建目录标记
上传
下载
删除对象
单文件 Copy + Delete Rename
```

### 阶段五：TransferEngine

完成：

```text
Local → S3
S3 → Local
Local → Local
S3 → S3
进度
取消
失败状态
任务记录
Copy → Verify → Delete Move 流程
```

### 阶段六：UI

完成：

```text
Overview
Add Storage Dialog
Storage Browser
Breadcrumb
Entry Table
Toolbar
Transfer Drawer
Error Toast
Delete Confirmation
```

### 阶段七：测试和文档

完成：

```text
LocalFS 集成测试
OperationPlanner 单元测试
MinIO 集成测试
Local → MinIO → Local 内容一致性测试
README
```

---

## 20. Demo 验收标准

Demo 完成后必须可以执行以下流程：

1. 启动 Filo。
2. 添加一个本地目录。
3. 浏览本地目录内容。
4. 创建本地目录。
5. 添加 MinIO S3 存储。
6. 浏览 MinIO Bucket。
7. 从本地上传文件到 MinIO。
8. 查看实时上传进度。
9. 从 MinIO 下载文件到本地。
10. 下载后的文件内容与原文件一致。
11. 在 S3 中重命名单个文件。
12. 在本地重命名单个文件。
13. 删除文件时进行二次确认。
14. 取消运行中的传输任务。
15. 重启应用后，连接和 Volume 仍然存在。
16. SQLite 中不能出现明文 Access Key Secret。
17. 前端不能直接访问任意本地路径。
18. LocalFS 路径无法通过 `../` 逃逸根目录。
19. `cargo fmt`、`cargo clippy`、`cargo test` 通过。
20. 前端 TypeScript 检查和 ESLint 通过。

---

## 21. Demo 初版明确不做

以下能力不要在第一版实现：

```text
全文搜索
本地对象索引
缩略图
文件预览
S3 版本管理
Presigned URL
S3 Bucket Policy
对象 Tags
对象 Metadata 编辑
文件同步
定时任务
断点续传
暂停和恢复
非空目录递归移动
非空目录递归复制
系统文件监听
系统回收站
WebDAV
SFTP
GCS
Azure Blob
OSS/COS 原生 SDK
自动更新
多窗口
团队配置同步
```

代码结构需要允许后续增加这些功能，但不要提前实现。

---

## 22. 编码要求

* 不要在非测试代码中随意使用 `unwrap()`。
* 使用明确的错误类型。
* Provider 错误必须映射成统一错误。
* Secret 字段禁止实现未脱敏的 `Debug`。
* 所有文件读写使用流式处理。
* 不允许将整个文件读入内存。
* Domain 层不能依赖 Tauri、OpenDAL 或 SQLx。
* UI 中不要散落 Provider 判断。
* 复杂操作放到 Application Service。
* Tauri Commands 只负责参数校验和调用 Service。
* 每完成一个阶段，先运行测试再进入下一阶段。
* 优先完成可运行的纵向功能，不要只创建大量空接口。

首先输出：

1. 工程实现计划。
2. 将创建的目录和 crate。
3. 关键技术风险。
4. 第一阶段准备修改或创建的文件。

确认计划后直接开始实现，不需要再次询问。

---

初版最重要的取舍是：**只实现 LocalFS + S3、使用 OpenDAL 快速打通，但通过自有 `StorageBackend` 隔离；优先完成浏览和文件传输的完整闭环，不要先做搜索、同步、预览和高级 S3 管理。**
