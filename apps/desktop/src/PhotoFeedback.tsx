import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Flag, FlagOff, Star, Undo2 } from "lucide-react";
import {
  photoFeedbackDuration,
  type PhotoFeedback as Feedback,
} from "./photoReviewController";
import { observeResize } from "./observeResize";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  rotation: number;
  spin: number;
  color: string;
  star: boolean;
  size: number;
};
export function PhotoFeedback({ feedback }: { feedback: Feedback | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const particles = useRef<Particle[]>([]);
  const bursts = useRef<
    { time: number; x: number; count: number; flag: Feedback["flag"] }[]
  >([]);
  const frame = useRef(0);
  const reduced = useRef(false);
  const [visible, setVisible] = useState<Feedback | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    const layer = canvas.current?.parentElement;
    const stage = layer?.parentElement;
    const image = stage?.querySelector(":scope > img");
    if (!layer || !stage || !image) return;
    const update = () => {
      const a = image.getBoundingClientRect();
      const b = stage.getBoundingClientRect();
      const left = Math.max(a.left, b.left);
      const top = Math.max(a.top, b.top);
      Object.assign(layer.style, {
        inset: "auto",
        left: `${left - b.left + stage.scrollLeft}px`,
        top: `${top - b.top + stage.scrollTop}px`,
        width: `${Math.max(0, Math.min(a.right, b.right) - left)}px`,
        height: `${Math.max(0, Math.min(a.bottom, b.bottom) - top)}px`,
      });
    };
    update();
    const stopObserving = observeResize([stage, image], update);
    stage.addEventListener("scroll", update);
    return () => {
      stopObserving();
      stage.removeEventListener("scroll", update);
    };
  }, [feedback]);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const clear = () => {
      particles.current = [];
      bursts.current = [];
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      const element = canvas.current;
      const context = element?.getContext("2d");
      if (element && context) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, element.width, element.height);
      }
    };
    const changed = () => {
      reduced.current = media.matches;
      clear();
    };
    const hidden = () => {
      if (document.hidden) {
        clear();
        setVisible(null);
        clearTimeout(timer.current);
      }
    };
    changed();
    media.addEventListener("change", changed);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clear();
      clearTimeout(timer.current);
      media.removeEventListener("change", changed);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    clearTimeout(timer.current);
    setVisible(feedback);
    if (!feedback) {
      particles.current = [];
      bursts.current = [];
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      canvas.current
        ?.getContext("2d")
        ?.clearRect(0, 0, canvas.current.width, canvas.current.height);
      return;
    }
    timer.current = setTimeout(() => setVisible(null), photoFeedbackDuration);
    if (feedback.kind !== "up") {
      particles.current = [];
      bursts.current = [];
    }
    if (
      reduced.current ||
      document.hidden ||
      !["up", "flag"].includes(feedback.kind) ||
      (feedback.kind === "flag" && feedback.flag === "none")
    )
      return;
    const now = performance.now();
    bursts.current.push({
      time: now,
      x: 0.5,
      count: feedback.kind === "flag" ? 65 : 30 + feedback.rating * 20,
      flag: feedback.kind === "flag" ? feedback.flag : "none",
    });
    if (feedback.kind === "up" && feedback.rating === 5) {
      bursts.current.push(
        {
          time: now + photoFeedbackDuration * 0.1,
          x: 0.1,
          count: 40,
          flag: "none",
        },
        {
          time: now + photoFeedbackDuration * 0.1,
          x: 0.9,
          count: 40,
          flag: "none",
        },
        {
          time: now + photoFeedbackDuration * 0.2,
          x: 0.5,
          count: 50,
          flag: "none",
        },
      );
    }
    const draw = (time: number) => {
      const element = canvas.current;
      const context = element?.getContext("2d");
      if (!element || !context) {
        frame.current = 0;
        return;
      }
      const rect = element.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio, 2);
      if (
        element.width !== Math.round(rect.width * dpr) ||
        element.height !== Math.round(rect.height * dpr)
      ) {
        element.width = Math.round(rect.width * dpr);
        element.height = Math.round(rect.height * dpr);
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      for (const burst of bursts.current.filter((b) => b.time <= time)) {
        const colors =
          burst.flag === "pick"
            ? ["#70e4b0", "#b1f9db", "#fff"]
            : burst.flag === "reject"
              ? ["#ff817b", "#ffc3b8", "#fff"]
              : ["#ffd66b", "#fff1b1", "#e698ff", "#86d8ff", "#ffa586"];
        for (let i = 0; i < burst.count; i++) {
          const angle = Math.PI * (0.95 + Math.random() * 1.1);
          const speed = 80 + Math.random() * (130 + feedback.rating * 35);
          particles.current.push({
            x: rect.width * burst.x,
            y: rect.height * 0.72,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            born: burst.time,
            life: photoFeedbackDuration * (0.45 + Math.random() * 0.35),
            rotation: Math.random() * 6,
            spin: (Math.random() - 0.5) * 8,
            color: colors[i % colors.length],
            star: i % 5 === 0,
            size: 3 + Math.random() * 5,
          });
        }
      }
      bursts.current = bursts.current.filter((b) => b.time > time);
      particles.current = particles.current
        .filter((p) => time - p.born < p.life)
        .slice(-220);
      for (const p of particles.current) {
        const age = ((time - p.born) / photoFeedbackDuration) * 1.8;
        context.save();
        context.globalAlpha = Math.max(0, 1 - (time - p.born) / p.life);
        context.translate(p.x + p.vx * age, p.y + p.vy * age + 180 * age * age);
        context.rotate(p.rotation + p.spin * age);
        context.fillStyle = p.color;
        if (p.star) {
          context.beginPath();
          for (let i = 0; i < 10; i++) {
            const radius = i % 2 ? p.size / 2 : p.size;
            const angle = (i * Math.PI) / 5;
            context.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
          }
          context.closePath();
          context.fill();
        } else context.fillRect(-p.size / 2, -p.size / 3, p.size, p.size / 2);
        context.restore();
      }
      frame.current =
        particles.current.length || bursts.current.length
          ? requestAnimationFrame(draw)
          : 0;
    };
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [feedback]);
  const label =
    visible?.kind === "undo"
      ? "撤销"
      : visible?.kind === "flag"
        ? visible.flag === "pick"
          ? "保留"
          : visible.flag === "reject"
            ? "待删除"
            : "无旗标"
        : visible?.rating
          ? `${visible.rating} 星`
          : "无星级";
  return (
    <div
      className="photo-feedback"
      aria-live="polite"
      aria-atomic="true"
      style={
        {
          "--photo-feedback-duration": `${photoFeedbackDuration}ms`,
        } as CSSProperties
      }
    >
      <canvas ref={canvas} aria-hidden="true" />
      {visible && (
        <div
          key={visible.id}
          className={`photo-feedback-result ${visible.kind} ${visible.flag}`}
        >
          {visible.kind === "undo" ? (
            <Undo2 />
          ) : visible.kind === "flag" ? (
            visible.flag === "none" ? (
              <FlagOff />
            ) : (
              <Flag fill="currentColor" />
            )
          ) : (
            <div className="photo-feedback-stars">
              {Array.from({ length: visible.rating || 1 }, (_, i) => (
                <Star key={i} fill={visible.rating ? "currentColor" : "none"} />
              ))}
            </div>
          )}
          <strong>{label}</strong>
          {visible.kind === "up" ||
          (visible.kind === "flag" && visible.flag !== "none") ? (
            <span className="photo-feedback-ring" aria-hidden="true" />
          ) : null}
        </div>
      )}
    </div>
  );
}
