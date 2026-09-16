# 持久化与桌面命令

> 来源：`init.md`。保留原任务书章节编号；本轮交付范围见 [实施记录](10-local-demo.md)。

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
