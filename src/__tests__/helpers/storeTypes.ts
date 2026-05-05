/**
 * Lightweight type-only re-exports used by storeMocks so tests don't
 * pull in actual store implementations and their side-effects.
 */
export type {
  KakusuFile,
  ContextMenuState,
  ClipboardState,
  PreviewState,
  Toast,
} from "@/types";

/** Minimal ShareLink shape used in mock store. */
export interface ShareLink {
  shareName: string;
  summary: {
    metaFileId: string;
    itemCount: number;
    createdTime: string;
    status: string;
  };
}
