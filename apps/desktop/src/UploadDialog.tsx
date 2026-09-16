import { Upload } from "lucide-react";
import { useState } from "react";
import { Modal } from "./components";
import { ConflictPolicyField } from "./ConflictPolicyField";
import type { ConflictPolicy } from "./types";
export function UploadDialog({
  paths,
  destination,
  onClose,
  onStart,
}: {
  paths?: string[];
  destination?: string;
  onClose: () => void;
  onStart: (policy: ConflictPolicy) => void;
}) {
  const [policy, setPolicy] = useState<ConflictPolicy>("reject");
  return (
    <Modal
      title={paths ? "上传文件或文件夹" : "上传文件"}
      className="upload-dialog"
      onClose={onClose}
    >
      {paths && (
        <>
          <p className="modal-description">
            将 {paths.length} 个项目上传到 {destination}，文件夹将保留目录结构
          </p>
          <ul className="batch-items">
            {paths.map((path, index) => (
              <li key={`${index}:${path}`}>{path.split(/[\\/]/).pop()}</li>
            ))}
          </ul>
        </>
      )}
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
          {paths ? "开始上传" : "选择文件…"}
        </button>
      </div>
    </Modal>
  );
}
