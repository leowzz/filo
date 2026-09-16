# 浏览与 S3 高级管理

文件浏览工具栏新增「预览」「搜索文件内容」及自动刷新开关；S3 位置另有「对象管理」和「Bucket 管理」。文件右键菜单也提供预览和对象管理。

## 预览、缩略图与内容搜索

- 预览支持 UTF-8 文本、PNG/JPEG/GIF/WebP 图片和 PDF 翻页。HTML、SVG 等文本直接显示源内容，不执行脚本。图片列表显示 80px 缩略图，GIF 使用静态帧。图片/PDF 上限 20 MiB，文本预览显示前 1 MiB；图片解码设有尺寸与内存限制，同时最多处理三个预览请求。其他格式可使用系统应用打开或下载。
- 内容搜索从当前目录递归读取文件，展示每个匹配文件的首个命中行与片段，点击结果打开预览。ASCII 字母不区分大小写，其他字符精确匹配；隐藏文件遵循浏览开关，符号链接和检测为二进制的文件跳过。搜索覆盖文件完整字节流，不限于预览的前 1 MiB；不解析 Office、压缩文件或 PDF 的文本层，也不做 OCR。读取失败单独提示；停止搜索或关闭窗口会取消任务。
- 搜索最多返回 1,000 个匹配文件，最多扫描 100,000 个文件/目录，达到上限明确提示缩小范围。S3 内容搜索会下载内容，可能产生网络流量和请求费用。
- 自动刷新按当前目录条目的名称、类型、大小、修改时间和 ETag 检查变化：本地每 5 秒、S3 每 15 秒（检查耗时另计），页面不可见时暂停。有变化才刷新目录；失败后停止检查并提供重试。该功能为定期检查，并非文件系统事件实时通知。偏好与其他浏览开关一样在当前页面会话内生效。

## S3 管理

- **Bucket**：使用已连接的 S3 凭据创建新 Bucket，随后通过添加存储空间连接。查看、启用或暂停当前 Bucket 的版本控制；输入 Bucket 名称后可删除空 Bucket。服务会拒绝仍有对象、历史版本或删除标记的 Bucket，不自动清空内容。需要连接整个 Bucket，受限 Prefix 连接不能修改 Bucket 设置。
- **历史版本**：每页最多 200 条，支持对象历史以及目录下包含已删除对象的版本列表。可永久删除具体版本或删除标记；删除最新删除标记可能使旧内容重新可见。恢复历史内容要求版本控制为 Enabled，将历史内容复制为新的当前版本；最大支持 5 GiB。大文件可以生成版本下载链接，下载后重新上传。
- **分享链接**：生成 15 分钟、1 小时、1 天或 7 天有效的签名下载链接，也可为历史版本生成一小时链接。链接持有者无需凭据即可下载；临时凭据失效会提前终止链接。地址仍需对接收方可达。
- **Metadata**：编辑 Content-Type 与自定义 Metadata，保留正文、标签、已知标准头和 ACL；通过源 ETag 条件复制，最大支持 5 GiB。版本控制启用时产生新版本。无法保留的 ACL 会阻止修改；只读连接不能保存。
- **Tags**：查看并替换最多 10 个键值标签；保存空集合会清除标签。
- **ACL**：查看所有者/授权，输入完整对象名称后可替换为 private、public-read、authenticated-read 或 bucket-owner-full-control。公开读取允许任何人访问；最终有效权限还受 Bucket 策略、公共访问阻止与服务配置约束。保存后读回确认，不支持或忽略写入的服务明确返回失败，不自动绕过权限。当前本机 RustFS 对公开 ACL 请求返回成功但读回仍为默认权限，因此 Filo 会报告无法确认修改；ACL 写入通过模拟 S3 响应验证，其他服务仍需实测。

修改操作沿用只读、路径和活动传输检查。所有请求只使用当前连接保存的凭据，不读取 SDK 环境凭据。普通文件传输仍不承诺保留全部对象属性；此页面用于单独管理这些属性。SDK 错误不回传凭据、签名请求或原始响应；分享链接仅在用户主动生成时显示。

## 验证

- `make check`、`make test`：编译、格式、lint、Rust 回归；预览边界、缩略图尺寸、跨读取块匹配、行号、隐藏/二进制文件、取消、目录变化。
- `FILO_S3_TEST_CONFIG="$HOME/.config/filo/rustfs.json" cargo test -p storage-application --test s3_integration -- --ignored --nocapture`：普通传输与高级管理。高级测试新建随机 Bucket，验证版本、Metadata、Tags、ACL 和真实签名链接下载，再清理测试版本及 Bucket；不删除既有 Bucket。仅用于显式配置的测试服务。
- Vite 启动后运行 `ego-browser nodejs < scripts/test-advanced-browsing.mjs`：模拟 IPC 验证预览不执行 HTML、缩略图、搜索、属性保存、确认流程、删除标记、自动刷新和窄窗口。

接口依据：[S3 CopyObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html)、[版本删除](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html)、[空 Bucket 删除](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteBucket.html)。各 S3 兼容服务及凭据支持的权限不同，RustFS 实测结果不能替代 TOS、OSS 或 AWS 的实机验收。
