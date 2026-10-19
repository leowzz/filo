import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "./api";
import { PhotoReview } from "./PhotoReview";
import { reviewApi, type PhotoCatalog } from "./photoApi";

export function DirectoryPhotoReview({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["photo-reviews"],
    queryFn: reviewApi.catalog,
    refetchOnWindowFocus: false,
  });
  const session = query.data?.sessions.find((s) => s.id === sessionId);
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
      <div className="photo-review-syncbar">进度保存在此目录的 .filo 中</div>
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
