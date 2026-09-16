const hidden = "[已隐藏]";

function redact(text: string) {
  return text
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, hidden)
    .replace(/\b(?:https?|s3):\/\/[^\s<>"']+/gi, "[地址已隐藏]")
    .replace(
      /(["']?(?:access[_ -]?key(?:[_ -]?id)?|secret(?:[_ -]?access)?[_ -]?key|session[_ -]?token|token|authorization|password|signature|credential)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}&]+)/gi,
      `$1${hidden}`,
    );
}

// Whitelist error fields rather than serializing arbitrary IPC/request objects.
// Keep diagnostic text bounded, and never retain the original rejection value.
export function describeError(reason: unknown): string {
  try {
    if (typeof reason === "string") return redact(reason).slice(0, 2000);
    if (reason == null) return "";
    if (typeof reason !== "object") return String(reason).slice(0, 100);
    const error = reason as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      stack?: unknown;
    };
    const fields = [error.name, error.code, error.message].filter(
      (value): value is string => typeof value === "string" && !!value,
    );
    const message = redact(fields.join(": ")).slice(0, 2000);
    const frames =
      typeof error.stack === "string"
        ? error.stack
            .split("\n")
            .slice(1, 9)
            .map((frame) => {
              // Keep source filenames/line numbers, without URL credentials or query data.
              const source = frame.replace(
                /(?:https?|file):\/\/[^\s)]+/gi,
                (url) => {
                  const position = url.match(/:\d+(?::\d+)?$/)?.[0] ?? "";
                  try {
                    const path = new URL(url).pathname;
                    return (
                      (path.split("/").pop() ?? "source").replace(
                        /:\d+(?::\d+)?$/,
                        "",
                      ) + position
                    );
                  } catch {
                    return "source" + position;
                  }
                },
              );
              return redact(source).slice(0, 300);
            })
            .join("\n")
        : "";
    return [message || "异常未提供错误消息", frames].filter(Boolean).join("\n");
  } catch {
    return "无法读取异常详情";
  }
}
