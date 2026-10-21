import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Flag,
  Maximize,
  Minimize,
  Plus,
  Settings2,
  Star,
  Undo2,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, desktop, errorMessage } from "./api";
import { Modal } from "./components";
import {
  reviewApi,
  type Photo,
  type PhotoPosition,
  type PhotoPreview,
  type PhotoReviewProgress,
  type PhotoSession,
} from "./photoApi";
import {
  PhotoReviewController,
  hasRaw,
  photoKeyAction,
  sortPhotos,
  matchesPhoto,
  isReviewConflict,
  preparePhotoReviewExit,
  type PhotoFeedback as Feedback,
} from "./photoReviewController";
import { PhotoExportButton } from "./PhotoExportButton";
import { PhotoFeedback } from "./PhotoFeedback";
import { observeResize } from "./observeResize";
import { useAppSettings } from "./appSettings";
import { useBrowser } from "./store";
import {
  photoPreview,
  photoPreviews,
  previewAhead,
  previewBehind,
} from "./photoPreviewCache";

const quickFilters = [
  { label: "全部", filter: "all", minimum: 0 },
  { label: "无旗标", filter: "none", minimum: 0 },
  { label: "保留", filter: "pick", minimum: 0 },
  { label: "待删除", filter: "reject", minimum: 0 },
  { label: "≥3 星", filter: "all", minimum: 3 },
];
type ReviewMode = "manual" | "flags" | "rating";

function Thumbnail({ photo, rawOnly }: { photo: Photo; rawOnly: boolean }) {
  const cachedPreview = useSyncExternalStore(photoPreviews.subscribe, () =>
    photoPreviews.peek(photo.id, false, false, rawOnly),
  );
  const [image, setImage] = useState<{
    preview: PhotoPreview;
    rawOnly: boolean;
  } | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    let live = true;
    setFailure("");
    void photoPreview(photo.id, false, true, rawOnly)
      .then((value) => {
        if (live) setImage({ preview: value, rawOnly });
      })
      .catch((error) => {
        if (
          live &&
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "unsupported"
          )
        )
          setFailure(errorMessage(error));
      });
    return () => {
      live = false;
    };
  }, [photo.id, rawOnly]);
  const preview =
    image && image.rawOnly === rawOnly ? image.preview : cachedPreview;
  return preview ? (
    <img src={`data:${preview.mime};base64,${preview.content}`} alt="" />
  ) : (
    <span className="photo-thumbnail-placeholder" title={failure || undefined}>
      {failure ? "加载失败" : "预览"}
    </span>
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
  onReload,
  backLabel = "审图记录",
}: {
  session: PhotoSession;
  photos: Photo[];
  onSaved: (photo: Photo) => void;
  onBack: () => void;
  onPositionSaved: () => void;
  onReload?: () => Promise<void>;
  backLabel?: string;
}) {
  const [, render] = useReducer((n) => n + 1, 0);
  const suspended = useBrowser((state) => state.page === "settings");
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const settingsViewport = useRef<{ left: number; top: number } | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [failure, setFailure] = useState<{
    message: string;
    retry: (() => void) | null;
    kind?: "dates";
    reload?: boolean;
  }>({ message: "", retry: null });
  const [reloading, setReloading] = useState(false);
  const reloadRef = useRef(false);
  const exitAttempt = useRef(0);
  const exitPromptTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [exitPromptVisible, setExitPromptVisible] = useState(false);
  const [exitStatus, setExitStatus] = useState<
    "saving" | "failed" | "pending" | null
  >(null);
  const positionWrites = useRef(new Set<Promise<void>>());
  const writePosition = (position: PhotoPosition) => {
    const write = reviewApi.position(session.id, position);
    positionWrites.current.add(write);
    void write.then(
      () => positionWrites.current.delete(write),
      () => positionWrites.current.delete(write),
    );
    return write;
  };
  const callbacks = useRef({ onSaved });
  callbacks.current = { onSaved };
  const [controller] = useState(
    () =>
      new PhotoReviewController(
        sortPhotos(
          photos.filter(
            (p) =>
              !p.excluded &&
              p.files.some((f) => f.kind === "jpg" || f.kind === "raw"),
          ),
          session.position.sort ?? "name_asc",
        ),
        session.position.current,
        {
          save: (id, mark) =>
            reviewApi.mark(session.id, id, mark.rating, mark.flag),
          undo: () => reviewApi.undo(session.id),
          changed: render,
          saved: (photo) => {
            callbacks.current.onSaved(photo);
          },
          feedback: (value) => setFeedback(document.hidden ? null : value),
          error: (message, retry, reload) =>
            setFailure((previous) =>
              !message && previous.kind === "dates"
                ? previous
                : { message, retry, reload },
            ),
        },
        session.position.raw_only ?? false,
      ),
  );
  const [filter, setFilter] = useState(
    ["none", "pick", "reject"].includes(session.position.filter)
      ? session.position.filter
      : "all",
  );
  const [sort, setSort] = useState(session.position.sort ?? "name_asc");
  const [captureTimes, setCaptureTimes] = useState<
    Record<string, string | null>
  >(() =>
    Object.fromEntries(
      photos
        .filter((p) => p.capture_time_loaded)
        .map((p) => [p.id, p.capture_time ?? null]),
    ),
  );
  const [dateProgress, setDateProgress] = useState<PhotoReviewProgress | null>(
    null,
  );
  const [dateAttempt, retryDates] = useReducer((n) => n + 1, 0);
  const [minimum, setMinimum] = useState(session.position.minimum_rating);
  const [auto, setAuto] = useState(session.position.auto_advance);
  const [mode, setMode] = useState<ReviewMode>("manual");
  const ratingDelay = useAppSettings((state) => state.ratingAdvanceDelay);
  const animationDuration = useAppSettings(
    (state) => state.reviewAnimationDuration,
  );
  const setRatingDelay = useAppSettings((state) => state.setRatingAdvanceDelay);
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
  const stage = useRef<HTMLDivElement>(null);
  const mainImage = useRef<HTMLImageElement>(null);
  const filmstrip = useRef<HTMLDivElement>(null);
  const [filmstripRange, setFilmstripRange] = useState({ start: 0, end: 17 });
  const positionRef = useRef<PhotoPosition | null>(null);
  const photo = controller.photo;
  const { data: focus } = useQuery({
    queryKey: ["photo-focus", photo?.id],
    queryFn: () => reviewApi.focus(photo!.id),
    enabled:
      original &&
      !!photo?.files.some(
        (file) => file.kind === "raw" && /\.nef$/i.test(file.path),
      ),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const photoPath = rawOnly
    ? photo?.files.find((f) => f.kind === "raw")?.path
    : photo?.original_path;
  const { data: volumes = [] } = useQuery({
    queryKey: ["volumes"],
    queryFn: api.volumes,
  });
  const { data: catalog } = useQuery({
    queryKey: ["photo-reviews"],
    queryFn: reviewApi.catalog,
    refetchOnWindowFocus: false,
  });
  const reviewRoot =
    session.directory ??
    catalog?.archives.find((archive) => archive.id === session.archive_id)?.jpg;
  const volume = volumes.find((item) => item.id === reviewRoot?.volume_id);
  const folderName = reviewRoot?.logical_path.split("/").filter(Boolean).at(-1);
  const locationName =
    [volume?.name, folderName].filter(Boolean).join(" / ") || session.name;
  const filename = photoPath?.split("/").at(-1);
  const ordered = sortPhotos(
    controller.photos.map((p) => ({
      ...p,
      capture_time: Object.hasOwn(captureTimes, p.id)
        ? captureTimes[p.id]
        : p.capture_time,
    })),
    sort,
  );
  const activeFilter =
    mode === "rating" ? "pick" : mode === "flags" ? "all" : filter;
  const activeMinimum = mode === "manual" ? minimum : 0;
  const visible = ordered.filter(
    (p) =>
      (!rawOnly || hasRaw(p)) &&
      (matchesPhoto(p, activeFilter, activeMinimum) ||
        (mode === "manual" && p.id === controller.current)),
  );
  const changeMode = (nextMode: ReviewMode) => {
    setMode(nextMode);
    const eligible = ordered.filter(
      (p) =>
        (!rawOnly || hasRaw(p)) &&
        matchesPhoto(
          p,
          nextMode === "rating"
            ? "pick"
            : nextMode === "flags"
              ? "all"
              : filter,
          nextMode === "manual" ? minimum : 0,
        ),
    );
    controller.select(
      eligible.find((p) => p.id === controller.current)?.id ??
        eligible[0]?.id ??
        null,
    );
  };
  const changeFilter = (nextFilter: string, nextMinimum: number) => {
    setFilter(nextFilter);
    setMinimum(nextMinimum);
    controller.select(
      ordered.find(
        (p) =>
          (!rawOnly || hasRaw(p)) && matchesPhoto(p, nextFilter, nextMinimum),
      )?.id ?? null,
    );
  };
  const ids = visible.map((p) => p.id);
  const index = ids.indexOf(controller.current ?? "");
  const updateFilmstrip = useCallback(
    (center = false) => {
      const list = filmstrip.current;
      if (!list) return;
      const style = getComputedStyle(list);
      const width = parseFloat(
        style.getPropertyValue("--photo-thumbnail-width"),
      );
      const stride = width + parseFloat(style.columnGap);
      if (center && index >= 0) {
        list.scrollLeft =
          parseFloat(style.paddingLeft) +
          index * stride -
          (list.clientWidth - width) / 2;
      }
      const start = Math.max(0, Math.floor(list.scrollLeft / stride) - 2);
      const end = Math.min(
        visible.length,
        Math.ceil((list.scrollLeft + list.clientWidth) / stride) + 2,
      );
      setFilmstripRange((previous) =>
        previous.start === start && previous.end === end
          ? previous
          : { start, end },
      );
    },
    [index, visible.length],
  );
  const previewIds = ids
    .slice(Math.max(0, index - previewBehind), index + previewAhead + 1)
    .join("\n");
  const step = (delta: number) => controller.step(delta, ids);
  const markRating = (rating: number, advance = auto) => {
    const current = controller.photo;
    if (!current || mode === "flags") return;
    controller.mark(
      { rating, flag: current.flag },
      mode === "rating" ? rating > 0 : advance,
      () => actions.current.step(1),
      mode === "rating"
        ? {
            delayMs: Math.max(ratingDelay, animationDuration),
            immediateFeedback: true,
          }
        : { delayMs: animationDuration, immediateFeedback: true },
    );
  };
  const markFlag = (flag: Photo["flag"], advance = auto) => {
    const current = controller.photo;
    if (!current || mode === "rating") return;
    const desired = mode !== "flags" && current.flag === flag ? "none" : flag;
    controller.mark(
      { rating: current.rating, flag: desired },
      mode === "flags" ? desired !== "none" : advance,
      () => actions.current.step(1),
      mode === "flags"
        ? {
            delayMs: animationDuration,
            background: true,
            repeatFlagFeedback: true,
          }
        : { delayMs: animationDuration, immediateFeedback: true },
    );
  };
  const undo = () => {
    setMode("manual");
    setFilter("all");
    setMinimum(0);
    controller.setRawOnly(false);
    controller.undo();
  };
  const actions = useRef({ step, auto, markRating, markFlag, undo });
  actions.current = { step, auto, markRating, markFlag, undo };
  const back = async () => {
    if (reloadRef.current) return;
    const attempt = ++exitAttempt.current;
    controller.cancelAdvance();
    clearTimeout(exitPromptTimer.current);
    setExitPromptVisible(false);
    exitPromptTimer.current = setTimeout(() => {
      if (attempt === exitAttempt.current) setExitPromptVisible(true);
    }, 1000);
    setExitStatus("saving");
    try {
      const status = await preparePhotoReviewExit(controller, async () => {
        await Promise.allSettled([...positionWrites.current]);
        if (attempt !== exitAttempt.current) return;
        if (positionRef.current) {
          await writePosition(positionRef.current);
          onPositionSaved();
        }
      });
      if (attempt !== exitAttempt.current) return;
      if (status === "saved") {
        clearTimeout(exitPromptTimer.current);
        onBack();
      } else setExitStatus(status);
    } catch (error) {
      if (attempt === exitAttempt.current) {
        setExitStatus("failed");
        setFailure({
          message: errorMessage(error),
          retry: null,
          reload: isReviewConflict(error),
        });
      }
    }
  };
  const cancelExit = () => {
    exitAttempt.current++;
    clearTimeout(exitPromptTimer.current);
    setExitStatus(null);
  };
  const leave = () => {
    exitAttempt.current++;
    clearTimeout(exitPromptTimer.current);
    controller.dispose();
    onBack();
  };
  const reload = async () => {
    if (!onReload || reloadRef.current) return;
    reloadRef.current = true;
    setReloading(true);
    controller.dispose();
    try {
      await controller.settle();
      await Promise.allSettled([...positionWrites.current]);
      await onReload();
    } catch (error) {
      setFailure({ message: errorMessage(error), retry: null, reload: true });
    } finally {
      controller.activate();
      reloadRef.current = false;
      setReloading(false);
    }
  };
  const exit = useRef(back);
  exit.current = back;
  useEffect(() => {
    controller.activate();
    return () => {
      exitAttempt.current++;
      clearTimeout(exitPromptTimer.current);
      controller.dispose();
    };
  }, [controller]);
  useEffect(() => {
    const cancel = () => controller.cancelAdvance();
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancel);
    };
  }, [controller]);
  useEffect(() => {
    const changed = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (reloadRef.current || suspended) return;
      if (
        (event.target instanceof Element &&
          event.target.closest(
            "input,textarea,select,[contenteditable=true],[role=textbox],dialog",
          )) ||
        document.querySelector("dialog[open]")
      )
        return;
      // Holding Space must not scroll the stage or activate the last clicked
      // flag/mode button, even though repeated zoom actions are ignored.
      if (
        (event.code === "Space" || event.key === " ") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      )
        event.preventDefault();
      const action = photoKeyAction(event, actions.current.auto);
      if (!action) return;
      event.preventDefault();
      if (action.type !== "flag") controller.cancelAdvance();
      const current = controller.photo;
      if (action.type === "step") actions.current.step(action.delta);
      if (action.type === "zoom" && current) {
        setOriginal((value) => !value);
        stage.current?.focus({ preventScroll: true });
      }
      if (action.type === "undo") actions.current.undo();
      if (action.type === "escape") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void exit.current();
      }
      if (current && action.type === "rating")
        actions.current.markRating(
          action.relative ? current.rating + action.value : action.value,
          action.advance,
        );
      if (current && action.type === "flag")
        actions.current.markFlag(action.value, action.advance);
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [controller, suspended]);
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
      if (positionRef.current && !reloadRef.current)
        void writePosition(positionRef.current)
          .then(() => {
            if (!reloadRef.current) onPositionSaved();
          })
          .catch((error) => {
            if (!reloadRef.current)
              setFailure((previous) =>
                controller.hasFailedWrites
                  ? previous
                  : {
                      message: errorMessage(error),
                      retry: null,
                      reload: isReviewConflict(error),
                    },
              );
          });
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
    if (suspended) {
      photoPreviews.clearWindow();
      return;
    }
    photoPreviews.setWindow(
      previewIds ? previewIds.split("\n") : [],
      photo?.id ?? null,
      rawOnly,
    );
  }, [previewIds, photo?.id, rawOnly, suspended]);
  useEffect(() => () => photoPreviews.clearWindow(), []);
  const needsDates =
    sort.startsWith("capture") &&
    controller.photos.some((p) => !Object.hasOwn(captureTimes, p.id));
  useEffect(() => {
    if (!needsDates) {
      setDateProgress(null);
      return;
    }
    let live = true;
    const requestId = crypto.randomUUID();
    setDateProgress({
      stage: "connecting",
      found: 0,
      completed: 0,
      total: null,
      path: "",
    });
    void reviewApi
      .captureTimes(requestId, session.id, (progress) => {
        if (live) setDateProgress(progress);
        else void reviewApi.cancelScan(requestId).catch(() => {});
      })
      .then((times) => {
        if (!live) return;
        setCaptureTimes((previous) => ({
          ...previous,
          ...Object.fromEntries(times.map((p) => [p.id, p.capture_time])),
        }));
        setDateProgress(null);
        setFailure((previous) =>
          previous.kind === "dates" ? { message: "", retry: null } : previous,
        );
      })
      .catch((error) => {
        if (live) {
          setDateProgress(null);
          setFailure({
            message: `读取拍摄日期失败：${errorMessage(error)}`,
            retry: retryDates,
            kind: "dates",
            reload: isReviewConflict(error),
          });
        }
      });
    return () => {
      live = false;
      void reviewApi.cancelScan(requestId).catch(() => {});
    };
  }, [needsDates, session.id, dateAttempt]);
  useLayoutEffect(() => {
    const list = filmstrip.current;
    if (!list) return;
    const center = () => updateFilmstrip(true);
    center();
    let width = list.clientWidth;
    return observeResize([list], () => {
      if (list.clientWidth === width) return;
      width = list.clientWidth;
      center();
    });
  }, [photo?.id, updateFilmstrip]);
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
  const centerZoom = useCallback(() => {
    const viewport = stage.current;
    const img = mainImage.current;
    if (!viewport || suspendedRef.current) return;
    viewport.style.setProperty(
      "--photo-stage-width",
      `${viewport.clientWidth}px`,
    );
    viewport.style.setProperty(
      "--photo-stage-height",
      `${viewport.clientHeight}px`,
    );
    if (settingsViewport.current) {
      viewport.scrollTo({ ...settingsViewport.current, behavior: "instant" });
      viewport.focus({ preventScroll: true });
      settingsViewport.current = null;
      return;
    }
    if (original && img) {
      viewport.scrollLeft = img.offsetWidth * (focus?.x ?? 0.5);
      viewport.scrollTop = img.offsetHeight * (focus?.y ?? 0.5);
    } else {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
  }, [original, focus?.x, focus?.y]);
  useLayoutEffect(() => {
    const viewport = stage.current;
    if (!viewport || suspended) return;
    centerZoom();
    let width = viewport.clientWidth;
    let height = viewport.clientHeight;
    return observeResize([viewport], () => {
      if (suspendedRef.current) return;
      if (viewport.clientWidth === width && viewport.clientHeight === height)
        return;
      width = viewport.clientWidth;
      height = viewport.clientHeight;
      centerZoom();
    });
  }, [
    centerZoom,
    suspended,
    photo?.id,
    shownImage?.original,
    shownImage?.preview.width,
    shownImage?.preview.height,
  ]);
  return (
    <section
      className={`photo-review${desktop && navigator.platform.toLowerCase().includes("mac") ? " photo-review-macos" : ""}`}
      ref={container}
      aria-label="照片审图"
      style={
        {
          "--photo-feedback-duration": `${animationDuration}ms`,
        } as CSSProperties
      }
      onPointerDownCapture={() => controller.cancelAdvance()}
    >
      {exitStatus && exitPromptVisible && (
        <Modal
          title="退出审图"
          onClose={cancelExit}
          className="photo-review-exit-dialog"
        >
          <p role="status">
            {exitStatus === "saving"
              ? "正在保存审图进度…"
              : exitStatus === "pending"
                ? "保存仍未完成，可以返回继续等待，或退出审图。"
                : "部分更改未能保存，可以返回重试，或退出审图。"}
          </p>
          <p>退出时尚未保存的更改可能丢失。</p>
          <div className="modal-actions">
            <button className="secondary" onClick={cancelExit}>
              返回审图
            </button>
            <button className="primary" onClick={leave}>
              退出审图
            </button>
          </div>
        </Modal>
      )}
      <div
        className="photo-review-titlebar"
        title={[locationName, filename].filter(Boolean).join(" / ")}
        data-tauri-drag-region
      >
        <span className="photo-review-location" data-tauri-drag-region>
          {locationName}
        </span>
        {filename && (
          <>
            <span className="photo-review-title-separator" aria-hidden="true">
              /
            </span>
            <span className="photo-review-current-file" data-tauri-drag-region>
              {filename}
            </span>
          </>
        )}
      </div>
      <div className="photo-review-toolbar" data-tauri-drag-region>
        <button className="photo-review-back" onClick={() => void back()}>
          <ArrowLeft size={17} />
          {backLabel}
        </button>
        <div className="photo-quick-filters" role="group" aria-label="审图模式">
          {(
            [
              ["manual", "自由审图"],
              ["flags", "旗标快筛"],
              ["rating", "星级筛选"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              aria-pressed={mode === value}
              onClick={() => changeMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="photo-review-select">
          <select
            aria-label="照片排序"
            value={sort}
            onChange={(event) => {
              controller.cancelAdvance();
              setSort(event.target.value as typeof sort);
            }}
          >
            <option value="name_asc">文件名升序</option>
            <option value="name_desc">文件名降序</option>
            <option value="capture_asc">拍摄日期升序</option>
            <option value="capture_desc">拍摄日期降序</option>
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </span>
        {mode === "manual" && (
          <>
            <div
              className="photo-quick-filters"
              role="group"
              aria-label="快捷筛选"
            >
              {quickFilters.map((preset) => (
                <button
                  key={preset.label}
                  aria-pressed={
                    filter === preset.filter &&
                    (preset.filter !== "all" || minimum === preset.minimum)
                  }
                  onClick={() => changeFilter(preset.filter, preset.minimum)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <span className="photo-review-select">
              <select
                aria-label="星级门槛"
                value={minimum}
                onChange={(e) => changeFilter(filter, Number(e.target.value))}
              >
                <option value={0}>所有星级</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} 星及以上
                  </option>
                ))}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </>
        )}
        {mode === "rating" && (
          <label className="photo-review-delay">
            自动下一张
            <span className="photo-review-select">
              <select
                aria-label="星级等待时间"
                value={ratingDelay}
                onChange={(event) => {
                  controller.cancelAdvance();
                  setRatingDelay(Number(event.target.value));
                }}
              >
                {[200, 500, 800, 1000, 1500, 2000].map((delay) => (
                  <option key={delay} value={delay}>
                    {delay} ms
                  </option>
                ))}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </label>
        )}
        <label className="photo-review-toggle">
          <input
            type="checkbox"
            role="switch"
            checked={rawOnly}
            onChange={(e) => {
              const value = e.target.checked;
              const current = controller.current;
              const eligible = ordered.filter(
                (p) =>
                  (!value || hasRaw(p)) &&
                  matchesPhoto(p, activeFilter, activeMinimum),
              );
              controller.setRawOnly(value);
              controller.select(
                eligible.find((p) => p.id === current)?.id ??
                  eligible[0]?.id ??
                  null,
              );
            }}
          />
          仅查看 RAW
        </label>
        {mode === "manual" && (
          <label className="photo-review-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
            自动前进
          </label>
        )}
        <PhotoExportButton
          session={session}
          disabled={reloading || controller.pending > 0 || !!failure.message}
          beforeExport={async () => {
            await controller.settle();
            if (positionRef.current) await writePosition(positionRef.current);
          }}
        />
        <button
          className="icon-button photo-review-fullscreen"
          title={fullscreen ? "退出全屏" : "全屏审图"}
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
        <button
          className="icon-button photo-review-settings"
          title="设置"
          aria-label="审图设置"
          disabled={reloading || !!exitStatus}
          onClick={async () => {
            controller.cancelAdvance();
            setFeedback(null);
            settingsViewport.current = {
              left: stage.current?.scrollLeft ?? 0,
              top: stage.current?.scrollTop ?? 0,
            };
            try {
              if (document.fullscreenElement) await document.exitFullscreen();
              useBrowser.getState().openReviewSettings();
            } catch (error) {
              settingsViewport.current = null;
              setFailure({ message: errorMessage(error), retry: null });
            }
          }}
        >
          <Settings2 size={18} />
        </button>
      </div>
      {dateProgress && (
        <div className="photo-date-progress" role="status">
          正在读取拍摄日期
          {dateProgress.total != null
            ? ` · ${dateProgress.completed} / ${dateProgress.total}`
            : "…"}
          <button onClick={() => setSort("name_asc")}>取消读取</button>
        </div>
      )}
      {failure.message && (
        <div className="photo-review-error" role="alert">
          {failure.message}
          {failure.reload && onReload ? (
            <button disabled={reloading} onClick={() => void reload()}>
              {reloading ? "正在重新载入…" : "重新载入目录"}
            </button>
          ) : (
            failure.retry && <button onClick={failure.retry}>重试</button>
          )}
          <button
            aria-label="关闭错误提示"
            onClick={() => setFailure({ message: "", retry: null })}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div
        ref={stage}
        tabIndex={-1}
        aria-label="照片预览"
        className={`photo-stage ${original ? "original" : ""}`}
        onDoubleClick={() => setOriginal((value) => !value)}
      >
        {shownImage ? (
          <div className="photo-image-surface">
            <img
              ref={mainImage}
              onLoad={centerZoom}
              src={`data:${shownImage.preview.mime};base64,${shownImage.preview.content}`}
              alt={photoPath}
              style={
                original
                  ? {
                      width: shownImage.preview.width,
                      height: shownImage.preview.height,
                    }
                  : undefined
              }
            />
          </div>
        ) : (
          <p>
            {photo
              ? "正在读取预览…"
              : rawOnly && !controller.photos.some(hasRaw)
                ? "此目录没有 RAW 照片"
                : mode === "rating"
                  ? "还没有留用照片，请先用「旗标快筛」标记留用"
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
        {mode !== "flags" && (
          <div className="photo-rating" aria-label="星级">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={`${n}:${feedback?.kind === "up" && n > feedback.from && n <= feedback.rating ? feedback.id : "rest"}`}
                aria-label={`${n} 星`}
                disabled={!photo}
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
                onClick={() => markRating(photo?.rating === n ? 0 : n)}
              >
                <Star
                  size={23}
                  fill={(photo?.rating ?? 0) >= n ? "currentColor" : "none"}
                />
              </button>
            ))}
          </div>
        )}
        {mode === "rating" && (
          <button
            disabled={!photo || photo.rating >= 5}
            onClick={() => markRating((photo?.rating ?? 0) + 1)}
          >
            <Plus size={16} />
            升一星
          </button>
        )}
        {mode !== "rating" && (
          <div className="photo-flags">
            <button
              disabled={!photo}
              className={photo?.flag === "pick" ? "pick selected" : ""}
              aria-pressed={photo?.flag === "pick"}
              aria-keyshortcuts="C P"
              title={
                mode !== "flags" && photo?.flag === "pick" ? "取消留用" : "留用"
              }
              onClick={() => markFlag("pick")}
            >
              <Flag size={17} />
              留用
              <kbd aria-hidden="true">C</kbd>
            </button>
            <button
              disabled={!photo}
              className={photo?.flag === "reject" ? "reject selected" : ""}
              aria-pressed={photo?.flag === "reject"}
              aria-keyshortcuts="X"
              title={
                mode !== "flags" && photo?.flag === "reject"
                  ? "取消排除"
                  : "排除，只标记文件"
              }
              onClick={() => markFlag("reject")}
            >
              <Flag size={17} />
              排除
              <kbd aria-hidden="true">X</kbd>
            </button>
          </div>
        )}
        <button title="撤销 (Cmd/Ctrl+Z)" aria-label="撤销标记" onClick={undo}>
          <Undo2 size={18} />
        </button>
        <button
          className={original ? "selected" : ""}
          title="放大并居中焦点（空格 / Z）"
          aria-keyshortcuts="Space Z"
          onClick={() => setOriginal((value) => !value)}
        >
          {original ? "适应窗口" : "原尺寸"}
        </button>
        <span className="photo-save-status">
          {controller.hasFailedWrites ||
          (failure.message && failure.kind !== "dates")
            ? "保存失败"
            : controller.pending
              ? "保存中…"
              : session.directory
                ? "已保存到目录"
                : "本机已保存"}
        </span>
      </div>
      <div
        className="photo-filmstrip"
        aria-label="审图胶片带"
        ref={filmstrip}
        style={{
          gridTemplateColumns: visible.length
            ? `repeat(${visible.length}, var(--photo-thumbnail-width))`
            : undefined,
        }}
        onScroll={() => updateFilmstrip()}
      >
        {visible
          .slice(filmstripRange.start, filmstripRange.end)
          .map((p, offset) => (
            <button
              key={p.id}
              style={{ gridColumn: filmstripRange.start + offset + 1 }}
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
