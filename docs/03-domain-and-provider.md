# 领域模型与 Provider 契约

> 来源：`init.md`。保留原任务书章节编号；本轮交付范围见 [实施记录](10-local-demo.md)。

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
