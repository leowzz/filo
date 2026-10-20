import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Flag,
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
  hasRaw,
  photoKeyAction,
  type PhotoFeedback as Feedback,
} from "./photoReviewController";
import { PhotoFeedback } from "./PhotoFeedback";
import { useAppSettings } from "./appSettings";
import {
  photoPreview,
  photoPreviews,
  previewAhead,
  previewBehind,
} from "./photoPreviewCache";

const photoNameOrder = new Intl.Collator(undefined, { numeric: true }).compare;

function Thumbnail({ photo, rawOnly }: { photo: Photo; rawOnly: boolean }) {
  const [image, setImage] = useState<{
    preview: PhotoPreview;
    rawOnly: boolean;
  } | null>(null);
  useEffect(() => {
    let live = true;
    void photoPreview(photo.id, false, true, rawOnly)
      .then((value) => {
        if (live) setImage({ preview: value, rawOnly });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [photo.id, rawOnly]);
  return image && image.rawOnly === rawOnly ? (
    <img
      src={`data:${image.preview.mime};base64,${image.preview.content}`}
      alt=""
    />
  ) : (
    <span className="photo-thumbnail-placeholder">预览</span>
  );
}

function CacheCover({ id, rawOnly }: { id: string; rawOnly: boolean }) {
  const state = useSyncExternalStore(photoPreviews.subscribe, () =>
    photoPreviews.state(id, rawOnly),
  );
  return (
    <span className={`photo-cache-cover ${state}`} data-cache-state={state}>
      <span>
        {{ ready: "已缓存", pending: "加载中", empty: "未缓存" }[state]}
      </span>
    </span>
  );
}

export function PhotoReview({
  session,
  photos,
  onSaved,
  onBack,
  onPositionSaved,
  backLabel = "审图记录",
}: {
  session: PhotoSession;
  photos: Photo[];
  onSaved: (photo: Photo) => void;
  onBack: () => void;
  onPositionSaved: () => void;
  backLabel?: string;
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
        photos
          .filter(
            (p) =>
              !p.excluded &&
              p.files.some((f) => f.kind === "jpg" || f.kind === "raw"),
          )
          .sort(
            (a, b) =>
              photoNameOrder(a.original_path, b.original_path) *
              (session.position.sort === "name_desc" ? -1 : 1),
          ),
        session.position.current,
        {
          save: (id, mark) =>
            reviewApi.mark(session.id, id, mark.rating, mark.flag),
          undo: () => reviewApi.undo(session.id),
          changed: render,
          saved: (photo) => {
            setFailure({ message: "", retry: null });
            callbacks.current.onSaved(photo);
          },
          feedback: (value) => setFeedback(document.hidden ? null : value),
          error: (message, retry) => setFailure({ message, retry }),
        },
        session.position.raw_only ?? false,
      ),
  );
  const [filter, setFilter] = useState(
    ["pick", "reject"].includes(session.position.filter)
      ? session.position.filter
      : "all",
  );
  const [sort, setSort] = useState(session.position.sort ?? "name_asc");
  const [minimum, setMinimum] = useState(session.position.minimum_rating);
  const [auto, setAuto] = useState(session.position.auto_advance);
  const [original, setOriginal] = useState(false);
  const cacheDebug = useAppSettings((state) => state.debugMode);
  const rawOnly = controller.rawOnly;
  const [fullscreen, setFullscreen] = useState(false);
  const [image, setImage] = useState<{
    id: string;
    preview: PhotoPreview;
    original: boolean;
    rawOnly: boolean;
  } | null>(null);
  const [previewFailure, setPreviewFailure] = useState("");
  const [previewAttempt, retryPreview] = useReducer((n) => n + 1, 0);
  const container = useRef<HTMLElement>(null);
  const filmstrip = useRef<HTMLDivElement>(null);
  const positionRef = useRef<PhotoPosition | null>(null);
  const photo = controller.photo;
  const photoPath = rawOnly
    ? photo?.files.find((f) => f.kind === "raw")?.path
    : photo?.original_path;
  const matches = (p: Photo) =>
    p.rating >= minimum &&
    (filter === "all" ||
      (filter === "pick" && p.flag === "pick") ||
      (filter === "reject" && p.flag === "reject"));
  const ordered = [...controller.photos].sort(
    (a, b) =>
      photoNameOrder(a.original_path, b.original_path) *
      (sort === "name_desc" ? -1 : 1),
  );
  const visible = ordered.filter(
    (p) =>
      (!rawOnly || hasRaw(p)) && (matches(p) || p.id === controller.current),
  );
  const ids = visible.map((p) => p.id);
  const index = ids.indexOf(controller.current ?? "");
  const previewIds = ids
    .slice(Math.max(0, index - previewBehind), index + previewAhead + 1)
    .join("\n");
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
        controller.setRawOnly(false);
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
      sort,
      filter,
      minimum_rating: minimum,
      auto_advance: auto,
      raw_only: rawOnly,
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
  }, [
    controller.current,
    filter,
    sort,
    minimum,
    auto,
    rawOnly,
    session.id,
    onPositionSaved,
  ]);
  useEffect(() => {
    photoPreviews.setWindow(
      previewIds ? previewIds.split("\n") : [],
      photo?.id ?? null,
      rawOnly,
    );
  }, [previewIds, photo?.id, rawOnly]);
  useEffect(() => () => photoPreviews.clearWindow(), []);
  useEffect(() => {
    if (!cacheDebug) return;
    const list = filmstrip.current;
    const selected = list?.querySelector<HTMLElement>(
      'button[aria-current="true"]',
    );
    if (!list || !selected) return;
    const center = () => {
      list.scrollLeft +=
        selected.getBoundingClientRect().left -
        list.getBoundingClientRect().left -
        (list.clientWidth - selected.offsetWidth) / 2;
    };
    center();
    const observer = new ResizeObserver(center);
    observer.observe(list);
    return () => observer.disconnect();
  }, [cacheDebug, photo?.id, rawOnly, previewIds]);
  useEffect(() => {
    let live = true;
    setPreviewFailure("");
    if (!photo) return;
    void photoPreview(photo.id, original, false, rawOnly)
      .then((preview) => {
        if (live) setImage({ id: photo.id, preview, original, rawOnly });
      })
      .catch((error) => {
        if (live) setPreviewFailure(errorMessage(error));
      });
    return () => {
      live = false;
    };
  }, [photo?.id, original, rawOnly, previewAttempt]);
  const cachedPreview = photo
    ? photoPreviews.peek(photo.id, original, false, rawOnly)
    : undefined;
  const readyPreview =
    cachedPreview ??
    (original && photo
      ? photoPreviews.peek(photo.id, false, false, rawOnly)
      : undefined);
  const shownImage =
    image?.id === photo?.id &&
    image?.rawOnly === rawOnly &&
    (original || !image.original)
      ? image
      : readyPreview
        ? { preview: readyPreview, original: original && !!cachedPreview }
        : null;
  const mark = (rating: number, flag = photo?.flag ?? "none") =>
    controller.mark({ rating, flag }, auto, () => step(1));
  return (
    <section className="photo-review" ref={container} aria-label="照片审图">
      <div className="photo-review-toolbar">
        <button onClick={() => void back()}>
          <ArrowLeft size={17} />
          {backLabel}
        </button>
        <span className="photo-review-name">{session.name}</span>
        <select
          aria-label="照片排序"
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
        >
          <option value="name_asc">文件名升序</option>
          <option value="name_desc">文件名降序</option>
        </select>
        <select
          aria-label="审图筛选"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            controller.select(
              ordered.find(
                (p) =>
                  (!rawOnly || hasRaw(p)) &&
                  p.rating >= minimum &&
                  (e.target.value === "all" || e.target.value === p.flag),
              )?.id ?? null,
            );
          }}
        >
          <option value="all">全部</option>
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
              ordered.find(
                (p) =>
                  (!rawOnly || hasRaw(p)) &&
                  p.rating >= value &&
                  (filter === "all" || filter === p.flag),
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
            checked={rawOnly}
            onChange={(e) => controller.setRawOnly(e.target.checked)}
          />
          仅查看 RAW
        </label>
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
            alt={photoPath}
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
          <p>
            {photo
              ? "正在读取预览…"
              : rawOnly && !controller.photos.some(hasRaw)
                ? "此目录没有 RAW 照片"
                : "没有符合筛选条件的照片"}
          </p>
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
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={`${n}:${feedback?.kind === "up" && n > feedback.from && n <= feedback.rating ? feedback.id : "rest"}`}
              aria-label={`${n} 星`}
              title={photo?.rating === n ? "再次点击清除星级 (0)" : `${n} 星`}
              aria-pressed={photo?.rating === n}
              className={
                (photo?.rating ?? 0) >= n
                  ? `filled ${feedback?.kind === "up" && n > feedback.from && n <= feedback.rating ? "added" : ""}`
                  : ""
              }
              style={{
                animationDelay: `${Math.max(0, n - (feedback?.from ?? n) - 1) * 40}ms`,
              }}
              onClick={() => mark(photo?.rating === n ? 0 : n)}
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
            title={photo?.flag === "pick" ? "取消保留 (U)" : "保留 (P)"}
            onClick={() =>
              mark(photo?.rating ?? 0, photo?.flag === "pick" ? "none" : "pick")
            }
          >
            <Flag size={17} />
            保留
          </button>
          <button
            className={photo?.flag === "reject" ? "reject selected" : ""}
            aria-pressed={photo?.flag === "reject"}
            title={
              photo?.flag === "reject"
                ? "取消待删除 (U)"
                : "待删除 (X)，只标记文件"
            }
            onClick={() =>
              mark(
                photo?.rating ?? 0,
                photo?.flag === "reject" ? "none" : "reject",
              )
            }
          >
            <Flag size={17} />
            待删除
          </button>
        </div>
        <button
          title="撤销 (Cmd/Ctrl+Z)"
          aria-label="撤销标记"
          onClick={() => {
            setFilter("all");
            setMinimum(0);
            controller.setRawOnly(false);
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
          {failure.message
            ? "保存失败"
            : controller.pending
              ? "保存中…"
              : session.directory
                ? "已保存到目录"
                : "本机已保存"}
        </span>
      </div>
      <div className="photo-image-info">
        <span>{photoPath}</span>
        <span>
          {shownImage &&
            `${shownImage.preview.width} × ${shownImage.preview.height}${shownImage.preview.embedded ? " · NEF 内嵌预览，完整 RAW 请在 LRC 检查" : original && !shownImage.original ? " · 正在读取原尺寸…" : ""}`}
        </span>
      </div>
      <div className="photo-filmstrip" aria-label="审图胶片带" ref={filmstrip}>
        {visible
          .slice(Math.max(0, index - 8), Math.max(17, index + 9))
          .map((p) => (
            <button
              key={p.id}
              aria-label={`查看 ${rawOnly ? p.files.find((f) => f.kind === "raw")?.path : p.original_path}`}
              aria-current={p.id === photo?.id}
              className={p.id === photo?.id ? "current" : ""}
              onClick={() => controller.select(p.id)}
            >
              <Thumbnail photo={p} rawOnly={rawOnly} />
              {cacheDebug && <CacheCover id={p.id} rawOnly={rawOnly} />}
              <span className="photo-filmstrip-mark">
                {p.flag === "pick" && (
                  <Flag size={12} className={p.flag} fill="currentColor" />
                )}
                {p.flag === "reject" && (
                  <X size={12} className="reject" aria-label="待删除" />
                )}
                {p.rating > 0 && <span>{"★".repeat(p.rating)}</span>}
              </span>
            </button>
          ))}
      </div>
    </section>
  );
}
