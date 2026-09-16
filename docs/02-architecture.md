# 技术架构与工程组织

> 来源：`init.md`。保留原任务书章节编号；本轮交付范围见 [实施记录](10-local-demo.md)。

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
