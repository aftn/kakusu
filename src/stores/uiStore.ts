import {
  loadAutoPopupLogin,
  loadBulkUploadBehavior,
  loadParallelFileCount,
  loadThemeMode,
  loadUserIconDisplay,
  saveAutoPopupLogin,
  saveBulkUploadBehavior,
  saveParallelFileCount,
  saveThemeMode,
  saveUserIconDisplay,
} from "@/cache/settings";
import type { KakusuFile, UIState } from "@/types";
import { generateUUID } from "@/utils/uuid";
import { create } from "zustand";

/** Minimum interval (ms) between progress toast state updates to reduce re-renders. */
const PROGRESS_THROTTLE_MS = 60;
const lastUpdateMap = new Map<string, number>();

export const useUIStore = create<UIState>((set) => ({
  loading: false,
  error: null,
  showSettings: false,
  showShareDialog: false,
  showPasswordChange: false,
  showSharedFiles: false,
  shareTargets: [],
  viewMode: "list",
  defaultEncryptName: true,
  autoPopupLogin: loadAutoPopupLogin(),
  bulkUploadBehavior: loadBulkUploadBehavior(),
  parallelFileCount: loadParallelFileCount(),
  themeMode: loadThemeMode(),
  userIconDisplay: loadUserIconDisplay(),
  contextMenu: null,
  selectedIds: new Set<string>(),
  lastSelectedId: null,
  renamingFileId: null,
  multiSelectMode: false,
  confirmDialog: null,
  toasts: new Map(),
  preview: null,
  clipboard: null,
  isDragSelecting: false,

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  openSettings: () => set({ showSettings: true }),
  closeSettings: () => set({ showSettings: false }),
  toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),
  openShareDialog: (files: KakusuFile[]) =>
    set({ showShareDialog: true, shareTargets: files }),
  closeShareDialog: () => set({ showShareDialog: false, shareTargets: [] }),
  openPasswordChange: () => set({ showPasswordChange: true }),
  closePasswordChange: () => set({ showPasswordChange: false }),
  togglePasswordChange: () =>
    set((s) => ({ showPasswordChange: !s.showPasswordChange })),
  toggleSharedFiles: () =>
    set((s) => ({ showSharedFiles: !s.showSharedFiles })),
  setViewMode: (mode) => set({ viewMode: mode }),
  setDefaultEncryptName: (value) => set({ defaultEncryptName: value }),
  setAutoPopupLogin: (value) => {
    saveAutoPopupLogin(value);
    set({ autoPopupLogin: value });
  },
  setBulkUploadBehavior: (value) => {
    saveBulkUploadBehavior(value);
    set({ bulkUploadBehavior: value });
  },
  setParallelFileCount: (value) => {
    saveParallelFileCount(value);
    set({ parallelFileCount: value });
  },
  setThemeMode: (mode) => {
    saveThemeMode(mode);
    set({ themeMode: mode });
  },
  setUserIconDisplay: (display) => {
    saveUserIconDisplay(display);
    set({ userIconDisplay: display });
  },
  openContextMenu: (x, y, file) =>
    set({ contextMenu: { x, y, type: "file", file } }),
  openBackgroundMenu: (x, y) =>
    set({ contextMenu: { x, y, type: "background" } }),
  closeContextMenu: () => set({ contextMenu: null }),
  selectFile: (id, multi) =>
    set((s) => {
      if (multi) {
        const next = new Set(s.selectedIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { selectedIds: next, lastSelectedId: id };
      }
      return { selectedIds: new Set([id]), lastSelectedId: id };
    }),
  toggleSelectFile: (id) =>
    set((s) => {
      const next = new Set(s.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next, lastSelectedId: id };
    }),
  selectRange: (ids, additive) =>
    set((s) => {
      if (additive) {
        const next = new Set(s.selectedIds);
        ids.forEach((id) => next.add(id));
        return { selectedIds: next };
      }
      return { selectedIds: new Set(ids) };
    }),
  selectAll: (ids) => set({ selectedIds: new Set(ids) }),
  setSelectedIds: (ids) => set({ selectedIds: ids }),
  clearSelection: () =>
    set({ selectedIds: new Set<string>(), lastSelectedId: null }),
  setMultiSelectMode: (mode) => set({ multiSelectMode: mode }),
  exitMultiSelectMode: () =>
    set({
      multiSelectMode: false,
      selectedIds: new Set<string>(),
      lastSelectedId: null,
    }),
  startRename: (fileId) => set({ renamingFileId: fileId, contextMenu: null }),
  cancelRename: () => set({ renamingFileId: null }),
  openConfirmDialog: (message, onConfirm, options) =>
    set({ confirmDialog: { message, onConfirm, ...options } }),
  closeConfirmDialog: () => set({ confirmDialog: null }),

  addToast: (toast) => {
    const id = generateUUID();
    set((s) => {
      const next = new Map(s.toasts);
      next.set(id, { ...toast, id });
      return { toasts: next };
    });
    return id;
  },
  updateToast: (id, updates) => {
    // Throttle progress-type updates to avoid excessive re-renders
    const isProgressUpdate =
      updates.percent !== undefined && updates.type === undefined;
    if (isProgressUpdate) {
      const now = Date.now();
      const last = lastUpdateMap.get(id) ?? 0;
      if (now - last < PROGRESS_THROTTLE_MS) return;
      lastUpdateMap.set(id, now);
    } else {
      // Non-progress update: clear throttle entry
      lastUpdateMap.delete(id);
    }
    set((s) => {
      const existing = s.toasts.get(id);
      if (!existing) return s;
      const next = new Map(s.toasts);
      next.set(id, { ...existing, ...updates });
      return { toasts: next };
    });
  },
  removeToast: (id) => {
    lastUpdateMap.delete(id);
    set((s) => {
      const next = new Map(s.toasts);
      next.delete(id);
      return { toasts: next };
    });
  },
  setPreview: (preview) => set({ preview }),
  setClipboard: (clipboard) => set({ clipboard }),
  setDragSelecting: (active) => set({ isDragSelecting: active }),
}));
