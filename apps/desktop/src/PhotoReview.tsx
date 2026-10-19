import { useEffect, useReducer, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Flag,
  FlagOff,
  Maximize,
  Minimize,
  Star,
  Undo2,
  X,
} from "lucide-react";
import { errorMessage } from "./api";
import {
  reviewApi,
  type Photo,
  type PhotoPosition,
  type PhotoPreview,
  type PhotoSession,
} from "./photoApi";
import {
  PhotoReviewController,
  photoKeyAction,
  type PhotoFeedback as Feedback,
} from "./photoReviewController";
import { PhotoFeedback } from "./PhotoFeedback";
import { photoPreview } from "./photoPreviewCache";

function Thumbnail({ photo }: { photo: Photo }) {
  const [image, setImage] = useState<PhotoPreview | null>(null);
  useEffect(() => {
    let live = true;
    void photoPreview(photo.id, false, true)
      .then((value) => {
        if (live) setImage(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [photo.id]);
  return image ? (
    <img src={`data:${image.mime};base64,${image.content}`} alt="" />
  ) : (
    <span className="photo-thumbnail-placeholder">预览</span>
  );
}

export function PhotoReview({
  session,
  photos,
  onSaved,
  onBack,
  onPositionSaved,
}: {
  session: PhotoSession;
  photos: Photo[];
  onSaved: (photo: Photo) => void;
  onBack: () => void;
  onPositionSaved: () => void;
}) {
  const [, render] = useReducer((n) => n + 1, 0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [failure, setFailure] = useState<{
    message: string;
    retry: (() => void) | null;
  }>({ message: "", retry: null });
  const callbacks = useRef({ onSaved });
  callbacks.current = { onSaved };
  const [controller] = useState(
    () =>
      new PhotoReviewController(
        photos.filter(
          (p) =>
            !p.excluded &&
            p.files.some((f) => f.kind === "jpg" || f.kind === "raw"),
        ),
        session.position.current,
        {
          save: (id, mark) =>
            reviewApi.mark(session.id, id, mark.rating, mark.flag),
          undo: () => reviewApi.undo(session.id),
          changed: render,
          saved: (photo) => callbacks.current.onSaved(photo),
          feedback: (value) => setFeedback(document.hidden ? null : value),
          error: (message, retry) => setFailure({ message, retry }),
        },
      ),
  );
  const [filter, setFilter] = useState(session.position.filter || "all");
  const [minimum, setMinimum] = useState(session.position.minimum_rating);
  const [auto, setAuto] = useState(session.position.auto_advance);
  const [original, setOriginal] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [image, setImage] = useState<{
    id: string;
    preview: PhotoPreview;
    original: boolean;
  } | null>(null);
  const [previewFailure, setPreviewFailure] = useState("");
  const [previewAttempt, retryPreview] = useReducer((n) => n + 1, 0);
  const container = useRef<HTMLElement>(null);
  const positionRef = useRef<PhotoPosition | null>(null);
  const photo = controller.photo;
  const matches = (p: Photo) =>
    p.rating >= minimum &&
    (filter === "all" ||
      (filter === "unreviewed" && !p.reviewed) ||
      (filter === "pick" && p.flag === "pick") ||
      (filter === "reject" && p.flag === "reject"));
  const visible = controller.photos.filter(
    (p) => matches(p) || p.id === controller.current,
  );
  const ids = visible.map((p) => p.id);
  const index = ids.indexOf(controller.current ?? "");
  const step = (delta: number) => controller.step(delta, ids);
  const actions = useRef({ step, photo, ids, original, auto, onBack });
  actions.current = { step, photo, ids, original, auto, onBack };
  const back = async () => {
    await controller.settle();
    if (positionRef.current) {
      try {
        await reviewApi.position(session.id, positionRef.current);
        onPositionSaved();
      } catch (error) {
        setFailure({ message: errorMessage(error), retry: () => void back() });
        return;
      }
    }
    onBack();
  };
  const exit = useRef(back);
  exit.current = back;
  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => {
    const changed = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        (event.target instanceof Element &&
          event.target.closest(
            "input,textarea,select,[contenteditable=true],[role=textbox],dialog",
          )) ||
        document.querySelector("dialog[open]")
      )
        return;
      const action = photoKeyAction(event, actions.current.auto);
      if (!action) return;
      event.preventDefault();
      const current = controller.photo;
      if (action.type === "step") actions.current.step(action.delta);
      if (action.type === "zoom") setOriginal((value) => !value);
      if (action.type === "undo") {
        setFilter("all");
        setMinimum(0);
        controller.undo();
      }
      if (action.type === "escape") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void exit.current();
      }
      if (current && action.type === "rating")
        controller.mark(
          {
            rating: action.relative
              ? current.rating + action.value
              : action.value,
            flag: current.flag,
          },
          action.advance,
          () => actions.current.step(1),
          action.relative,
        );
      if (current && action.type === "flag")
        controller.mark(
          { rating: current.rating, flag: action.value },
          action.advance,
          () => actions.current.step(1),
        );
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [controller]);
  useEffect(() => {
    positionRef.current = {
      current: controller.current,
      filter,
      minimum_rating: minimum,
      auto_advance: auto,
    };
    const timer = setTimeout(() => {
      if (positionRef.current)
        void reviewApi
          .position(session.id, positionRef.current)
          .then(onPositionSaved)
          .catch((error) =>
            setFailure({ message: errorMessage(error), retry: null }),
          );
    }, 500);
    return () => clearTimeout(timer);
  }, [controller.current, filter, minimum, auto, session.id, onPositionSaved]);
  useEffect(() => {
    let live = true;
    setPreviewFailure("");
    if (!photo) return;
    void photoPreview(photo.id, original)
      .then((preview) => {
        if (live) setImage({ id: photo.id, preview, original });
      })
      .catch((error) => {
        if (live) setPreviewFailure(errorMessage(error));
      });
    return () => {
      live = false;
    };
  }, [photo?.id, original, previewAttempt]);
  useEffect(() => {
    const selected = controller.photos.findIndex(
      (p) => p.id === controller.current,
    );
    for (const p of [
      controller.photos[selected - 1],
      controller.photos[selected + 1],
    ])
      if (p) void photoPreview(p.id).catch(() => {});
  }, [controller, controller.current]);
  const shownImage = image?.id === photo?.id ? image : null;
  const mark = (rating: number, flag = photo?.flag ?? "none") =>
    controller.mark({ rating, flag }, auto, () => step(1));
  return (
    <section className="photo-review" ref={container} aria-label="照片审图">
      <div className="photo-review-toolbar">
        <button onClick={() => void back()}>
          <ArrowLeft size={17} />
          审图记录
        </button>
        <span className="photo-review-name">{session.name}</span>
        <select
          aria-label="审图筛选"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            controller.select(
              controller.photos.find(
                (p) =>
                  p.rating >= minimum &&
                  (e.target.value === "all" ||
                    (e.target.value === "unreviewed" && !p.reviewed) ||
                    e.target.value === p.flag),
              )?.id ?? null,
            );
          }}
        >
          <option value="all">全部</option>
          <option value="unreviewed">未审阅</option>
          <option value="pick">保留</option>
          <option value="reject">待删除</option>
        </select>
        <select
          aria-label="星级门槛"
          value={minimum}
          onChange={(e) => {
            const value = Number(e.target.value);
            setMinimum(value);
            controller.select(
              controller.photos.find(
                (p) =>
                  p.rating >= value &&
                  (filter === "all" ||
                    (filter === "unreviewed" && !p.reviewed) ||
                    filter === p.flag),
              )?.id ?? null,
            );
          }}
        >
          <option value={0}>所有星级</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n} 星及以上
            </option>
          ))}
        </select>
        <label className="photo-auto">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          自动前进
        </label>
        <button
          className="icon-button"
          title="全屏"
          aria-label={fullscreen ? "退出全屏" : "全屏审图"}
          onClick={() => {
            const request = document.fullscreenElement
              ? document.exitFullscreen()
              : container.current?.requestFullscreen();
            void request?.catch((error) =>
              setFailure({ message: errorMessage(error), retry: null }),
            );
          }}
        >
          {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      </div>
      {failure.message && (
        <div className="photo-review-error" role="alert">
          {failure.message}
          {failure.retry && <button onClick={failure.retry}>重试保存</button>}
          <button
            aria-label="关闭错误提示"
            onClick={() => setFailure({ message: "", retry: null })}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div
        className={`photo-stage ${original ? "original" : ""}`}
        onDoubleClick={() => setOriginal((value) => !value)}
      >
        {shownImage ? (
          <img
            src={`data:${shownImage.preview.mime};base64,${shownImage.preview.content}`}
            alt={photo?.original_path}
            style={
              original && shownImage.original
                ? {
                    width: shownImage.preview.width,
                    height: shownImage.preview.height,
                  }
                : undefined
            }
          />
        ) : (
          <p>{photo ? "正在读取预览…" : "没有符合筛选条件的照片"}</p>
        )}
        {previewFailure && (
          <div className="photo-preview-error" role="alert">
            {previewFailure}
            <button onClick={retryPreview}>重试预览</button>
          </div>
        )}
        <PhotoFeedback
          feedback={feedback?.photoId === photo?.id ? feedback : null}
        />
      </div>
      <div className="photo-review-controls">
        <button
          aria-label="上一张"
          disabled={index <= 0}
          onClick={() => step(-1)}
        >
          <ChevronLeft />
        </button>
        <span className="photo-counter">
          {index < 0 ? 0 : index + 1} / {visible.length}
        </span>
        <button
          aria-label="下一张"
          disabled={index < 0 || index >= visible.length - 1}
          onClick={() => step(1)}
        >
          <ChevronRight />
        </button>
        <div className="photo-rating" aria-label="星级">
          <button
            title="清除星级 (0)"
            aria-label="清除星级"
            onClick={() => mark(0)}
          >
            0
          </button>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={`${n}:${feedback?.kind === "up" && n > feedback.from && n <= feedback.rating ? feedback.id : "rest"}`}
              aria-label={`${n} 星`}
              aria-pressed={(photo?.rating ?? 0) >= n}
              className={
                (photo?.rating ?? 0) >= n
                  ? `filled ${feedback?.kind === "up" && n > feedback.from && n <= feedback.rating ? "added" : ""}`
                  : ""
              }
              style={{
                animationDelay: `${Math.max(0, n - (feedback?.from ?? n) - 1) * 40}ms`,
              }}
              onClick={() => mark(n)}
            >
              <Star
                size={23}
                fill={(photo?.rating ?? 0) >= n ? "currentColor" : "none"}
              />
            </button>
          ))}
        </div>
        <div className="photo-flags">
          <button
            className={photo?.flag === "pick" ? "pick selected" : ""}
            aria-pressed={photo?.flag === "pick"}
            title="保留 (P)"
            onClick={() => mark(photo?.rating ?? 0, "pick")}
          >
            <Flag size={17} />
            保留
          </button>
          <button
            className={photo?.flag === "reject" ? "reject selected" : ""}
            aria-pressed={photo?.flag === "reject"}
            title="待删除 (X)，只标记文件"
            onClick={() => mark(photo?.rating ?? 0, "reject")}
          >
            <Flag size={17} />
            待删除
          </button>
          <button
            aria-label="清除旗标"
            title="清除旗标 (U)"
            onClick={() => mark(photo?.rating ?? 0, "none")}
          >
            <FlagOff size={17} />
          </button>
        </div>
        <button
          title="撤销 (Cmd/Ctrl+Z)"
          aria-label="撤销标记"
          onClick={() => {
            setFilter("all");
            setMinimum(0);
            controller.undo();
          }}
        >
          <Undo2 size={18} />
        </button>
        <button
          className={original ? "selected" : ""}
          onClick={() => setOriginal((value) => !value)}
        >
          {original ? "适应窗口" : "原尺寸"}
        </button>
        <span className="photo-save-status">
          {controller.pending ? "本机保存中…" : "本机已保存"}
        </span>
      </div>
      <div className="photo-image-info">
        <span>{photo?.original_path}</span>
        <span>
          {shownImage &&
            `${shownImage.preview.width} × ${shownImage.preview.height}${shownImage.preview.embedded ? " · NEF 内嵌预览，完整 RAW 请在 LRC 检查" : original && !shownImage.original ? " · 正在读取原尺寸…" : ""}`}
        </span>
      </div>
      <div className="photo-filmstrip" aria-label="审图胶片带">
        {visible
          .slice(Math.max(0, index - 8), Math.max(17, index + 9))
          .map((p) => (
            <button
              key={p.id}
              aria-label={`查看 ${p.original_path}`}
              aria-current={p.id === photo?.id}
              className={p.id === photo?.id ? "current" : ""}
              onClick={() => controller.select(p.id)}
            >
              <Thumbnail photo={p} />
              <span className="photo-filmstrip-mark">
                {p.flag === "pick" && (
                  <Flag size={12} className={p.flag} fill="currentColor" />
                )}
                {p.flag === "reject" && (
                  <X size={12} className="reject" aria-label="待删除" />
                )}
                {p.rating > 0 && <span>{"★".repeat(p.rating)}</span>}
                {p.reviewed && !p.rating && p.flag === "none" && (
                  <span>已审阅</span>
                )}
              </span>
            </button>
          ))}
      </div>
    </section>
  );
}
