# Filo 开发指导

`init.md` 保留为原始需求。以下文档按职责拆分，完整覆盖原文 22 节。原始任务书描述 LocalFS + S3 的完整 Demo；LocalFS 与 S3 现已接通，当前实现与限制以最新实施记录为准。

- [产品定位与版本范围](01-product-scope.md)
- [技术架构与工程组织](02-architecture.md)
- [领域模型与 Provider 契约](03-domain-and-provider.md)
- [LocalFS 与安全边界](04-local-filesystem.md)
- [S3 与 MinIO 接入](05-s3.md)
- [操作规划与传输引擎](06-transfers.md)
- [持久化与桌面命令](07-persistence-and-commands.md)
- [交互与界面](08-interface.md)
- [实施顺序与验收](09-roadmap-and-acceptance.md)
- [本轮 LocalFS Demo：范围、实现与验证](10-local-demo.md)

- [S3 与本机 RustFS：配置、实现与验证](11-s3.md)
- [批量与文件夹操作：行为、边界与验证](12-batch-and-folders.md)
- [上传和下载速度设置](13-transfer-speed.md)

- [冲突处理与大目录](13-conflicts-and-paging.md)：覆盖/跳过/自动改名、分页、虚拟列表与验证入口。
