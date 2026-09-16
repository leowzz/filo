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
    <Modal title="上传文件" onClose={onClose}>
      <ConflictPolicyField value={policy} onChange={setPolicy} />
      <div className="modal-footer">
        <button className="secondary" onClick={onClose}>
          取消
        </button>
        <button className="primary" onClick={() => onStart(policy)}>
          选择文件…
        </button>
      </div>
    </Modal>
  );
}
