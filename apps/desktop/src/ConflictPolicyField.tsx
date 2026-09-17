import { useId } from "react";
import type { ConflictPolicy } from "./types";
export function ConflictPolicyField({
  value,
  onChange,
  presentation = "select",
  sourceLabel = "上传的文件",
}: {
  presentation?: "select" | "choices";
  value: ConflictPolicy;
  onChange: (value: ConflictPolicy) => void;
  sourceLabel?: string;
}) {
  const groupId = useId();
  if (presentation === "choices") {
    const options: {
      value: ConflictPolicy;
      title: string;
      description: string;
    }[] = [
      {
        value: "overwrite",
        title: "覆盖同名文件",
        description: `用${sourceLabel}替换已有文件，文件夹合并。`,
      },
      {
        value: "rename",
        title: "自动改名",
        description: "为新文件添加编号，保留两份内容。",
      },
    ];
    return (
      <fieldset className="conflict-choices">
        <legend>遇到同名项目时</legend>
        <div className="conflict-choices-list">
          {options.map((option) => (
            <label key={option.value} className="conflict-choice">
              <input
                type="radio"
                name={groupId}
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                aria-describedby={`${groupId}-${option.value}`}
              />
              <span className="conflict-choice-copy">
                <span className="conflict-choice-title">{option.title}</span>
                <span
                  className="conflict-choice-description"
                  id={`${groupId}-${option.value}`}
                >
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </div>
        {value === "overwrite" && (
          <p className="conflict-overwrite-note">
            旧内容无法在 Filo
            中撤销。文件夹合并时保留目标独有的内容；文件和文件夹不能互相覆盖。
          </p>
        )}
      </fieldset>
    );
  }
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
        <option value="reject">停止同名项目，不覆盖</option>
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
