import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";

hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("powershell", powershell);

const filenames: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  ".bashrc": "bash",
  ".bash_profile": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".env": "ini",
};
const extensions: Record<string, string> = {
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  vue: "xml",
  svelte: "xml",
  svg: "xml",
  xhtml: "xml",
  zsh: "bash",
  bash: "bash",
  env: "ini",
  cfg: "ini",
  ps1: "powershell",
  psm1: "powershell",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  mdx: "markdown",
  patch: "diff",
  pyw: "python",
  pyi: "python",
};

self.onmessage = ({
  data,
}: MessageEvent<{ name: string; content: string }>) => {
  const name = data.name.toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop()! : "";
  const language =
    filenames[name] ??
    (name.startsWith(".env.") ? "ini" : undefined) ??
    (name.startsWith("dockerfile.") ? "dockerfile" : undefined) ??
    extensions[extension] ??
    extension;
  try {
    self.postMessage(
      language && hljs.getLanguage(language)
        ? hljs.highlight(data.content, { language, ignoreIllegals: true }).value
        : null,
    );
  } catch {
    self.postMessage(null);
  }
};
