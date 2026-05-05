import {
  loadMetadataCacheMode,
  loadPreviewCacheMode,
  saveMetadataCacheMode,
  savePreviewCacheMode,
} from "@/cache/settings";
import type { CacheMetadataMode, PreviewCacheMode } from "@/types";
import { create } from "zustand";

interface CacheSettingsState {
  metadataCacheMode: CacheMetadataMode;
  previewCacheMode: PreviewCacheMode;
  setMetadataCacheMode: (mode: CacheMetadataMode) => void;
  setPreviewCacheMode: (mode: PreviewCacheMode) => void;
}

export const useCacheSettingsStore = create<CacheSettingsState>((set) => ({
  metadataCacheMode: loadMetadataCacheMode(),
  previewCacheMode: loadPreviewCacheMode(),

  setMetadataCacheMode: (mode) => {
    saveMetadataCacheMode(mode);
    set({ metadataCacheMode: mode });
  },

  setPreviewCacheMode: (mode) => {
    savePreviewCacheMode(mode);
    set({ previewCacheMode: mode });
  },
}));
