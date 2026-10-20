import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { errorMessage } from "./api";
import { PhotoReview } from "./PhotoReview";
import { reviewApi, type PhotoCatalog } from "./photoApi";
import { useReviewScan } from "./useReviewScan";
import { ReviewScanStatus } from "./ReviewScanStatus";

export function DirectoryPhotoReview({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
}) {
  const client = useQueryClient();
  const scan = useReviewScan();
  const [reopening, setReopening] = useState(false);
  const [reloadError, setReloadError] = useState("");
  const [activeSessionId, setActiveSessionId] = useState(sessionId);
  useEffect(() => setActiveSessionId(sessionId), [sessionId]);
  const query = useQuery({
    queryKey: ["photo-reviews"],
    queryFn: reviewApi.catalog,
    refetchOnWindowFocus: false,
  });
  const session = query.data?.sessions.find((s) => s.id === activeSessionId);
  const reload = async () => {
    if (!session?.directory || reopening) return;
    setReopening(true);
    setReloadError("");
    try {
      const reopened = await scan.open({
        name: session.name,
        jpg: session.directory,
        raw: null,
        directory: true,
        raw_only: session.position.raw_only,
      });
      if (!reopened) {
        onBack();
        return;
      }
      await client.invalidateQueries({ queryKey: ["photo-reviews"] });
      setActiveSessionId(reopened.id);
    } catch (error) {
      setReloadError(errorMessage(error));
    } finally {
      setReopening(false);
    }
  };
  if (reopening)
    return (
      <section className="photo-workspace-body">
        <ReviewScanStatus scan={scan} />
      </section>
    );
  if (reloadError)
    return (
      <div className="empty-state">
        <p role="alert">{reloadError}</p>
        <button onClick={() => void reload()}>重试读取目录</button>
        <button className="secondary" onClick={onBack}>
          返回文件夹
        </button>
      </div>
    );
  if (!session)
    return (
      <div className="empty-state">
        <p role={query.isError ? "alert" : "status"}>
          {query.isError
            ? errorMessage(query.error)
            : query.isPending || query.isFetching
              ? "正在读取审图进度…"
              : "未找到审图记录，请重新进入"}
        </p>
        <button className="secondary" onClick={onBack}>
          返回文件夹
        </button>
        {query.isError && (
          <button onClick={() => void query.refetch()}>重试</button>
        )}
      </div>
    );
  return (
    <div className="photo-review-shell">
      <PhotoReview
        key={session.id}
        session={session}
        photos={
          query.data?.photos.filter((p) => session.photo_ids.includes(p.id)) ??
          []
        }
        backLabel="返回文件夹"
        onBack={onBack}
        onPositionSaved={() => {}}
        onReload={reload}
        onSaved={(photo) =>
          client.setQueryData<PhotoCatalog>(["photo-reviews"], (old) =>
            old
              ? {
                  ...old,
                  photos: old.photos.map((p) =>
                    p.id === photo.id ? photo : p,
                  ),
                }
              : old,
          )
        }
      />
    </div>
  );
}
