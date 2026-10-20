import { create } from "zustand";

const debugModeKey = "filo.debug-mode";

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
}>((set) => ({
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
