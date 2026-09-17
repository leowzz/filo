import { Upload } from "lucide-react";
import { useState } from "react";
import { Modal } from "./components";
import { ConflictPolicyField } from "./ConflictPolicyField";
import type { ConflictPolicy } from "./types";
export function UploadDialog({
  paths,
  total,
  destination,
  onClose,
  onStart,
}: {
  paths: string[];
  total: number;
  destination?: string;
  onClose: () => void;
  onStart: (policy: ConflictPolicy) => void;
}) {
  const [policy, setPolicy] = useState<ConflictPolicy>("reject");
  return (
    <Modal
      title="发现同名文件或文件夹"
      className="upload-dialog"
      onClose={onClose}
    >
      <p className="modal-description">
        将 {total} 个项目上传到 {destination}，以下 {paths.length}{" "}
        个项目存在同名，请选择处理方式。
      </p>
      <ul className="batch-items">
        {paths.map((path, index) => (
          <li key={`${index}:${path}`}>{path.split(/[\\/]/).pop()}</li>
        ))}
      </ul>
      <ConflictPolicyField
        presentation="choices"
        value={policy}
        onChange={setPolicy}
      />
      <div className="modal-footer">
        <button className="secondary" onClick={onClose}>
          取消
        </button>
        <button className="primary" onClick={() => onStart(policy)}>
          <Upload size={15} aria-hidden="true" />
          继续上传
        </button>
      </div>
    </Modal>
  );
}
