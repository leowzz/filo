# 远程存储与文件操作

本轮补充远程协议连接和文件管理器日常操作。协议能力以实际后端实现及验收结果为准，不能仅凭表单或编译通过判断服务兼容性。

## 验收范围

### 远程连接

- FTP、SFTP、SMB（Samba）提供独立入口；FTP 可通过“启用 SSL”开关启用加密，填写服务地址、认证信息及浏览根目录。
- 测试连接与保存分别反馈成功、失败和等待状态；编辑可保留已有凭据。
- 配置在重启后恢复，密码、私钥等凭据不进入普通连接配置或 SQLite。
- 浏览、创建目录、重命名、删除及跨存储传输遵循能力声明；不支持的操作不伪装成成功。
- 只读位置拒绝写操作，根目录和符号链接保护适用于远程位置。
- 传输沿用内容校验、同名冲突策略、取消与任务记录；不可安全提供的语义明确说明。

### 文件操作

- 选择文件或文件夹后复制、剪切，在另一个目录或存储位置粘贴。
- Cmd / Ctrl+C、X、V 与菜单入口行为一致，输入框保留原有文本编辑快捷键。
- 剪切项目可辨识，目标只读时禁止粘贴；失败和部分提交保留可重试信息。
- 浏览偏好持久化，普通及窄窗口下主要操作与弹窗均可访问。

## SFTP 私钥输入

选择「SSH 私钥」认证后，默认依次查找当前用户 `~/.ssh/id_ed25519`、`~/.ssh/id_ecdsa`、`~/.ssh/id_rsa`，使用首个可读取且格式有效的私钥。未找到时可直接「选择私钥文件」或「粘贴私钥」；加密私钥在下方填写口令。

从文件读取时仅展示路径，不展开私钥正文。取消文件选择保留先前私钥；保留已保存凭据的编辑操作不读取本机 SSH 文件。私钥内容沿用系统凭据存储，后续更换本地文件不会自动替换已保存的连接凭据，需要编辑连接并重新选择。

本项验证：`cargo test -p filo-desktop ssh_keys --locked` 的 8 个临时文件测试通过；`scripts/test-sftp-private-key.mjs` 覆盖默认读取、文件选择/取消、粘贴、保留凭据、迟到响应、失败恢复及 1100px / 390px 布局。浏览器使用模拟 IPC，不读取用户真实私钥。

## SFTP 服务器身份验证

点击「测试连接」或「保存连接」时，先获取服务器主机公钥，检查过程不发送用户名、密码或私钥。已保存的连接优先使用原有公钥；新连接自动查找当前用户 `~/.ssh/known_hosts`。支持哈希主机名、非默认端口及同一主机的多种公钥，拒绝匹配到的已撤销公钥。

未知服务器显示地址与 SHA256 指纹，点击「信任并继续」后恢复原来的测试或保存操作。取消、修改地址或端口会清除待确认结果，迟到的检查结果不会继续登录。已有信任记录与当前服务器不一致时阻止连接；实际登录再次校验确认过的公钥。确认结果随连接保存，不写入系统 SSH 文件。

后端验证：主机身份模块 11 个单元测试、桌面端 17 个测试通过；一次性回环 SFTP 服务的公钥检查和原有文件操作集成测试通过。普通连接依然使用严格公钥匹配。

浏览器验收：`scripts/test-sftp-host-trust.mjs` 覆盖自动信任、首次确认后继续测试/保存、取消、检查失败重试、密钥变化阻断、保留凭据和公钥、地址变化、迟到响应，以及 1100px / 390px 下的操作可达性。私钥与远程协议两套表单回归同时通过，浏览器验证使用模拟 IPC。

## 协议边界

- FTP 的“启用 SSL”开关使用显式 TLS（AUTH TLS），控制与数据连接都加密，服务端证书必须受系统信任；没有跳过证书检查的选项。
- SFTP 自动验证服务器身份，无需填写主机公钥。优先校验当前连接保存的主机公钥；新连接读取本机 `~/.ssh/known_hosts`（包含哈希主机名）。首次连接未知服务器时显示主机、端口和 SHA256 指纹，确认信任后继续测试或保存。已信任主机的密钥不匹配时拒绝连接，不提供跳过校验。确认结果随连接保存，不修改系统 SSH 信任文件。
- FTP / FTPS、SFTP、SMB 均可浏览、读取、下载、上传、重命名、创建目录及删除。只读模式关闭写操作。FTP 服务端必须支持保留符号链接信息的 LIST 目录列表，不使用可能解引用链接的 MLSD 作为安全检查后备。
- 远程上传先写同目录隐藏临时文件，校验后再发布。新文件使用不覆盖已有目标的重命名；覆盖同名文件时先把原文件移到备份名，再用同样的不覆盖重命名发布，成功后删除备份，失败则尽量恢复原文件。FTP 的 RNTO 在部分服务端会替换已有文件，因此发布前会再次确认目标状态。SMB 不支持 DFS 转发。
- 远程协议没有回收站。删除前明确确认永久删除；不跟随符号链接或 SMB reparse point。

## 验证记录

运行隔离的本机协议服务：

```sh
uv run scripts/remote-test-servers.py /tmp/filo-remote-fixture.json
```

服务只监听回环地址，使用随机端口、生成的临时密码和临时目录。私有 manifest 保存端口、凭据、SSH 主机公钥与 FTPS 测试 CA 的路径；不要提交或公开该文件。FTPS 使用显式 AUTH TLS，控制和数据连接均要求 TLS。按 Ctrl+C 停止并删除测试数据与 manifest。

真实服务验证已通过：

- FTP / FTPS、SFTP、SMB 的连接测试、保存、编辑保留凭据和重启恢复。
- FTP / FTPS 下载、上传、重命名、覆盖、创建及删除目录；FTPS 校验测试 CA。真实 Provider 测试拒绝符号链接根目录、链接子项及其下级路径。
- SFTP / SMB 与本地之间复制、移动、覆盖及内容校验；只读、错误认证、路径逃逸和活动传输期间禁止编辑。
- SFTP RSA 私钥已在仅允许 RSA SHA-2 的一次性 asyncssh 服务中验证认证与读取。
- SFTP / SMB / FTP Provider 的流式临时写入、同名目标保护、覆盖替换和重命名；SFTP 另外验证取消清理、符号链接根目录与错误主机公钥。
- SQLite / WAL 不保存密码，凭据保存失败回滚，移除连接清理凭据。

应用层真实集成测试：

```sh
FILO_TEST_REMOTE_FIXTURE=/tmp/filo-remote-fixture.json \
  cargo test -p storage-application --test remote_integration -- --ignored
```

结果为 2 个测试通过。Provider 的 FTP/FTPS、SFTP、SMB 共 3 个真实服务测试可一起运行：

```sh
FILO_TEST_REMOTE_FIXTURE=/tmp/filo-remote-fixture.json \
  cargo test -p provider-opendal fixture_operations -- --ignored
```

普通 `cargo test` 不会启动或连接这些服务。RSA 私钥测试单独使用 `FILO_TEST_SFTP_KEY_FIXTURE`，与密码认证服务隔离。

Rust 工作区 `cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings` 与 `cargo test --workspace --locked` 通过；常规测试 98 个通过。需要外部服务或系统交互的测试默认忽略，远程协议测试已按上述命令单独执行。

前端已完成：

- TypeScript、ESLint 与生产构建通过。
- `node --test scripts/file-browser-interaction.test.mjs`：5 个边界测试通过。
- `scripts/test-remote-providers.mjs`：四协议表单、测试超时和迟到响应、凭据保留/替换、SFTP 认证切换、FTP 上传能力限制，以及 1100px / 390px 弹窗边界、控件对齐和返回焦点通过。
- `scripts/test-file-selection.mjs`：键盘导航、虚拟列表滚动、范围选择、拖选及菜单选择行为通过。
- `scripts/test-external-upload.mjs`：原生拖放事件、HiDPI 定位、多文件上传、冲突、取消、部分失败及只读保护通过。
- `scripts/test-batch-operations.mjs`：批量操作、逐项失败重试、递归删除确认与回收站失败后的二次确认通过。
- `scripts/test-s3-providers.mjs`：原有 S3、本地只读、供应商配置和连接表单回归通过。
- `scripts/test-file-browser-workflow.mjs`：复制/剪切/粘贴快捷键、输入框隔离、侧栏切换目标后粘贴、异步部分失败及冲突重试、剪切完成状态、自身目录保护、偏好重载、760px 布局与远程上传/下载能力检查通过。

浏览器脚本通过模拟 Tauri IPC 验证界面行为；真实协议传输由上面的 Provider 和应用层集成测试验证。运行前先启动 Vite；这些脚本使用 `ego-browser nodejs` 执行。文件剪贴板仅在当前应用会话有效，隐藏文件、排序及详情面板偏好会保存到本机。
