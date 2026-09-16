import type { ConflictPolicy } from "./types";
export function ConflictPolicyField({
  value,
  onChange,
}: {
  value: ConflictPolicy;
  onChange: (value: ConflictPolicy) => void;
}) {
  return (
    <>
      <label className="field-label" htmlFor="conflict-policy">
        遇到同名项目
      </label>
      <select
        id="conflict-policy"
        className="text-input"
        value={value}
        onChange={(event) => onChange(event.target.value as ConflictPolicy)}
      >
        <option value="reject">提示冲突，保留两边内容</option>
        <option value="overwrite">覆盖同名文件</option>
        <option value="skip">跳过已有项目</option>
        <option value="rename">自动改名，保留两份</option>
      </select>
      <p className={value === "overwrite" ? "delete-warning" : "field-help"}>
        {value === "overwrite"
          ? "同名文件将被替换，旧内容无法在 Filo 中撤销。文件夹会合并，目标独有的内容保留；文件和文件夹不能互相覆盖。"
          : value === "skip"
            ? "目标已存在时跳过整个项目；移动时也保留源内容。"
            : value === "rename"
              ? "自动使用“名称 (1)”“名称 (2)”等可用名称，文件扩展名保留。"
              : "同名时停止该项，其他项目继续处理。"}
      </p>
    </>
  );
}
