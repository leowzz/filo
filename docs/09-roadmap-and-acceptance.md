# 实施顺序与验收

> 来源：`init.md`。保留原任务书章节编号；本轮交付范围见 [实施记录](10-local-demo.md)。

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
