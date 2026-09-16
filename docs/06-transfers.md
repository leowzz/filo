# 操作规划与传输引擎

> 来源：`init.md`。保留原任务书章节编号；本轮交付范围见 [实施记录](10-local-demo.md)。

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
