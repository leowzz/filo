# 产品定位与版本范围

> 来源：`init.md`。保留原任务书章节编号；本轮交付范围见 [实施记录](10-local-demo.md)。

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
