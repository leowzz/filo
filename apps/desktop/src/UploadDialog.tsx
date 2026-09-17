import { Copy, MoveRight, Upload } from "lucide-react";
import { useState } from "react";
import { Modal } from "./components";
import { ConflictPolicyField } from "./ConflictPolicyField";
import type { ConflictPolicy } from "./types";
export function UploadDialog({
  paths,
  sources,
  total,
  destination,
  operation = "upload",
  onClose,
  onStart,
}: {
  paths: string[];
  sources: string[];
  total: number;
  destination?: string;
  operation?: "upload" | "copy" | "move";
  onClose: () => void;
  onStart: (policy: ConflictPolicy) => void;
}) {
  const [policy, setPolicy] = useState<ConflictPolicy>("overwrite");
  const action =
    operation === "upload" ? "上传" : operation === "copy" ? "复制" : "移动";
  const ActionIcon =
    operation === "upload" ? Upload : operation === "copy" ? Copy : MoveRight;
  return (
    <Modal
      title="发现同名文件或文件夹"
      className="upload-dialog"
      onClose={onClose}
    >
      <p className="modal-description">
        将 {total} 个项目{action}到 {destination}，以下 {paths.length}{" "}
        个项目存在同名，请选择处理方式。
      </p>
      <ul className="batch-items">
        {paths.map((path, index) => (
          <li key={`${index}:${path}`}>
            {(() => {
              const normalized = path.replaceAll("\\", "/");
              const root = sources
                .map((source) => source.replaceAll("\\", "/"))
                .find(
                  (source) =>
                    normalized === source ||
                    normalized.startsWith(`${source}/`),
                );
              return root
                ? normalized.slice(root.lastIndexOf("/") + 1)
                : normalized.split("/").pop();
            })()}
          </li>
        ))}
      </ul>
      <ConflictPolicyField
        presentation="choices"
        value={policy}
        onChange={setPolicy}
        sourceLabel={`${action}的项目`}
      />
      <div className="modal-footer">
        <button className="secondary" onClick={onClose}>
          取消
        </button>
        <button className="primary" onClick={() => onStart(policy)}>
          <ActionIcon size={15} aria-hidden="true" />
          继续{action}
        </button>
      </div>
    </Modal>
  );
}
