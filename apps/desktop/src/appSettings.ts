import { create } from "zustand";

const debugModeKey = "filo.debug-mode";
const ratingDelayKey = "filo.review-rating-delay";
const animationDurationKey = "filo.review-animation-duration";
export const reviewAnimationDurations = [
  100, 200, 300, 500, 800, 1000, 1500, 2000,
];

function readAnimationDuration() {
  try {
    const value = Number(localStorage.getItem(animationDurationKey));
    return reviewAnimationDurations.includes(value) ? value : 500;
  } catch {
    return 500;
  }
}

function readRatingDelay() {
  try {
    const value = Number(localStorage.getItem(ratingDelayKey));
    return [200, 500, 800, 1000, 1500, 2000].includes(value) ? value : 500;
  } catch {
    return 500;
  }
}

function readDebugMode() {
  try {
    return localStorage.getItem(debugModeKey) === "true";
  } catch {
    return false;
  }
}

export const useAppSettings = create<{
  debugMode: boolean;
  setDebugMode: (enabled: boolean) => void;
  ratingAdvanceDelay: number;
  setRatingAdvanceDelay: (delay: number) => void;
  reviewAnimationDuration: number;
  setReviewAnimationDuration: (duration: number) => void;
}>((set) => ({
  reviewAnimationDuration: readAnimationDuration(),
  setReviewAnimationDuration: (reviewAnimationDuration) => {
    if (!reviewAnimationDurations.includes(reviewAnimationDuration)) return;
    try {
      localStorage.setItem(
        animationDurationKey,
        String(reviewAnimationDuration),
      );
    } catch {
      // Keep the setting usable when persistent storage is unavailable.
    }
    set({ reviewAnimationDuration });
  },
  ratingAdvanceDelay: readRatingDelay(),
  setRatingAdvanceDelay: (ratingAdvanceDelay) => {
    try {
      localStorage.setItem(ratingDelayKey, String(ratingAdvanceDelay));
    } catch {
      // Keep the setting usable when persistent storage is unavailable.
    }
    set({ ratingAdvanceDelay });
  },
  debugMode: readDebugMode(),
  setDebugMode: (debugMode) => {
    try {
      localStorage.setItem(debugModeKey, String(debugMode));
    } catch {
      // Keep the setting usable when persistent storage is unavailable.
    }
    set({ debugMode });
  },
}));
