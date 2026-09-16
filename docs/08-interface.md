# 交互与界面

> 来源：`init.md`。保留原任务书章节编号；本轮交付范围见 [实施记录](10-local-demo.md)。

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
