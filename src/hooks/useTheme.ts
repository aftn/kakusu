import { useUIStore } from "@/stores/uiStore";
import { useEffect } from "react";

export function useTheme() {
  const themeMode = useUIStore((s) => s.themeMode);

  useEffect(() => {
    const root = document.documentElement;

    const applyTheme = (dark: boolean) => {
      root.classList.toggle("dark", dark);
    };

    if (themeMode === "dark") {
      applyTheme(true);
      return;
    }
    if (themeMode === "light") {
      applyTheme(false);
      return;
    }

    // system mode
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    applyTheme(mq.matches);

    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [themeMode]);
}
