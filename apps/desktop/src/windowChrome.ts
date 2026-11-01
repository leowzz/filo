import type { Submenu } from "@tauri-apps/api/menu";
import { create } from "zustand";
import { desktop } from "./api";

export const windowsDesktop =
  desktop && navigator.platform.toLowerCase().includes("win");

export const useWindowMenu = create<{
  items: { label: string; menu: Submenu }[];
}>(() => ({ items: [] }));
