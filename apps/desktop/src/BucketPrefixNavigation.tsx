import { useState } from "react";

export function BucketPrefixNavigation({
  volumeId,
  rootPrefix,
  path,
  navigate,
}: {
  volumeId: string;
  rootPrefix: string;
  path: string;
  navigate: (volumeId: string, path: string) => void;
}) {
  const currentPrefix = [rootPrefix, path].filter(Boolean).join("/");
  const [draft, setDraft] = useState(currentPrefix ? `${currentPrefix}/` : "");
  const [error, setError] = useState("");

  return (
    <form
      className="bucket-prefix-navigation"
      onSubmit={(event) => {
        event.preventDefault();
        const input = draft.trim().replace(/^\/+/, "");
        const parts = input.split("/");
        if (/[\\:\0]/.test(input) || parts.includes("..")) {
          setError("请输入桶内目录前缀，不能包含上级路径、反斜杠或完整网址。");
          return;
        }
        const prefix = parts.filter((part) => part && part !== ".").join("/");
        let target = prefix;
        if (rootPrefix) {
          if (!prefix || prefix === rootPrefix) target = "";
          else if (prefix.startsWith(`${rootPrefix}/`))
            target = prefix.slice(rootPrefix.length + 1);
          else {
            setError(`此连接只能访问 ${rootPrefix}/ 内的目录。`);
            return;
          }
        }
        setError("");
        const destinationPrefix = [rootPrefix, target].filter(Boolean).join("/");
        setDraft(destinationPrefix ? `${destinationPrefix}/` : "");
        if (target !== path) navigate(volumeId, target);
      }}
    >
      <div className="bucket-prefix-controls">
        <input
          aria-label="桶内目录前缀"
          aria-invalid={!!error}
          aria-describedby={error ? "bucket-prefix-error" : undefined}
          placeholder="输入目录前缀，例如 ugc/character/20260930/"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
          }}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(currentPrefix ? `${currentPrefix}/` : "");
              setError("");
              event.currentTarget.blur();
            }
          }}
        />
        <button type="submit">跳转</button>
      </div>
      {error && (
        <span
          id="bucket-prefix-error"
          className="bucket-prefix-error"
          role="alert"
        >
          {error}
        </span>
      )}
    </form>
  );
}
