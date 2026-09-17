# 文本预览语法高亮

调研日期：2026-09-17。文本预览采用 `highlight.js`，保持只读源码展示。

| 候选 | 官方能力 | 本项目取舍 |
| --- | --- | --- |
| [highlight.js](https://highlightjs.org/) | 提供 core、common 与完整语言包，可明确指定语言，支持 CSS 主题 | 选用 common 加 Dockerfile、PowerShell；覆盖常见源码与配置文件，接入简单 |
| [Prism](https://prismjs.com/) | 轻量核心、语言扩展、CSS 主题与 Worker 支持 | 同样可用；本次选择已有常用语言集合与类型声明的 highlight.js |
| [Shiki](https://shiki.style/guide/bundles) | TextMate 语法、编辑器主题、细粒度打包；可选择正则引擎 | 适合要求编辑器级配色的场景；当前只读预览无需额外引擎与主题配置 |

实现使用 [highlight.js 的 highlight API](https://highlightjs.readthedocs.io/en/latest/api.html)，根据扩展名或特殊文件名识别语言，不对普通文本自动猜测语言。支持 TSX/JSX、Rust、Python、JSON、TOML、YAML、Shell、HTML 等常用格式，以及 Dockerfile、Makefile、`.env` 等文件名。未知语言保持原文。

引擎在打开非空、适中大小的文本时通过独立 Web Worker 加载；所有资源随应用打包，无 CDN 请求。高亮输出中的源码已转义，HTML 作为代码展示，不执行其中的标签或脚本。加载、失败及超时时显示原文。关闭预览或内容变化时终止 Worker，避免过期结果覆盖新内容。

为限制高亮生成的 DOM 数量，超过 200,000 个 UTF-16 代码单元的预览保持纯文本；Worker 超过 3 秒则终止。沿用后端前 1 MiB 预览限制及截断提示。使用 GitHub 浅色语法主题，保留现有换行、滚动和文本选择行为。

验证：`pnpm check`、`pnpm lint`、`pnpm build`；启动 Vite 后运行 `ego-browser nodejs < scripts/test-syntax-preview.mjs`，覆盖常用格式、源码完整性、HTML 转义、纯文本回退和窗口布局。浏览器测试使用模拟 IPC，不读取真实文件；不等同于 Tauri 原生 WebView 验证。
