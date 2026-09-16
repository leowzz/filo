import { Upload } from "lucide-react";
import { useState } from "react";
import { Modal } from "./components";
import { ConflictPolicyField } from "./ConflictPolicyField";
import type { ConflictPolicy } from "./types";
export function UploadDialog({
  onClose,
  onStart,
}: {
  onClose: () => void;
  onStart: (policy: ConflictPolicy) => void;
}) {
  const [policy, setPolicy] = useState<ConflictPolicy>("reject");
  return (
    <Modal title="上传文件" className="upload-dialog" onClose={onClose}>
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
          选择文件…
        </button>
      </div>
    </Modal>
  );
}
