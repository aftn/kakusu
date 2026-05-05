import type { KakusuFile } from "@/types";
/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockHook,
  defaultFileState,
  defaultShareState,
  defaultUIState,
  defaultVaultState,
} from "./helpers/storeMocks";

// ── Mock hooks ──
vi.mock("@/hooks/useDownload", () => ({
  useDownload: () => ({ handleDownload: vi.fn() }),
}));

// ── Mock preview utils ──
vi.mock("@/utils/preview", () => ({
  getMimeType: () => "application/octet-stream",
  isPreviewable: () => false,
  MAX_PREVIEW_FILE_BYTES: 50_000_000,
}));
vi.mock("@/utils/previewCache", () => ({
  getCachedPreview: () => null,
  setCachedPreview: vi.fn(),
}));

// ── Store states ──
let uiState = defaultUIState();
let fileState = defaultFileState();
let shareState = defaultShareState();
let vaultState = defaultVaultState();

vi.mock("@/stores/uiStore", () => ({
  useUIStore: createMockHook(uiState),
}));
vi.mock("@/stores/fileStore", () => ({
  useFileStore: createMockHook(fileState),
}));
vi.mock("@/stores/shareStore", () => ({
  useShareStore: createMockHook(shareState),
}));
vi.mock("@/stores/vaultStore", () => ({
  useVaultStore: createMockHook(vaultState),
}));

const { default: ContextMenu } = await import("@/components/ContextMenu");
const { useUIStore } = await import("@/stores/uiStore");
const { useFileStore } = await import("@/stores/fileStore");
const { useShareStore } = await import("@/stores/shareStore");
const { useVaultStore } = await import("@/stores/vaultStore");

function rewire() {
  (
    useUIStore as unknown as ReturnType<typeof createMockHook>
  ).mockImplementation((sel?: (s: typeof uiState) => unknown) =>
    sel ? sel(uiState) : uiState,
  );
  (useUIStore as unknown as { getState: () => unknown }).getState = vi.fn(
    () => uiState,
  );

  (
    useFileStore as unknown as ReturnType<typeof createMockHook>
  ).mockImplementation((sel?: (s: typeof fileState) => unknown) =>
    sel ? sel(fileState) : fileState,
  );
  (useFileStore as unknown as { getState: () => unknown }).getState = vi.fn(
    () => fileState,
  );

  (
    useShareStore as unknown as ReturnType<typeof createMockHook>
  ).mockImplementation((sel?: (s: typeof shareState) => unknown) =>
    sel ? sel(shareState) : shareState,
  );
  (useShareStore as unknown as { getState: () => unknown }).getState = vi.fn(
    () => shareState,
  );

  (
    useVaultStore as unknown as ReturnType<typeof createMockHook>
  ).mockImplementation((sel?: (s: typeof vaultState) => unknown) =>
    sel ? sel(vaultState) : vaultState,
  );
  (useVaultStore as unknown as { getState: () => unknown }).getState = vi.fn(
    () => vaultState,
  );
}

const testFile: KakusuFile = {
  driveId: "file-1",
  parentId: "data-folder-id",
  name: "test.txt",
  nameEncrypted: false,
  type: "file",
  modifiedTime: "2024-01-01T00:00:00Z",
  size: 1024,
};

const testFolder: KakusuFile = {
  driveId: "folder-1",
  parentId: "data-folder-id",
  name: "test-folder",
  nameEncrypted: false,
  type: "folder",
  modifiedTime: "2024-01-01T00:00:00Z",
};

beforeEach(() => {
  uiState = defaultUIState();
  fileState = defaultFileState();
  shareState = defaultShareState();
  vaultState = defaultVaultState();
  rewire();
});

afterEach(() => {
  cleanup();
});

describe("ContextMenu", () => {
  it("returns null when contextMenu is null", () => {
    uiState.contextMenu = null;
    rewire();
    const { container } = render(<ContextMenu />);
    expect(container.innerHTML).toBe("");
  });

  it("renders background menu with new folder and refresh buttons in data mode", () => {
    uiState.contextMenu = { x: 100, y: 100, type: "background" };
    fileState.browseMode = "data";
    rewire();
    const { container } = render(<ContextMenu />);
    const buttons = container.querySelectorAll("button");
    // At least: new folder + refresh
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it("renders background menu with file upload labels in data mode", () => {
    uiState.contextMenu = { x: 100, y: 100, type: "background" };
    fileState.browseMode = "data";
    rewire();
    const { container } = render(<ContextMenu />);
    const labels = container.querySelectorAll("label");
    // File upload + folder upload labels
    expect(labels.length).toBe(2);
  });

  it("renders background menu with only refresh button in trash mode", () => {
    uiState.contextMenu = { x: 100, y: 100, type: "background" };
    fileState.browseMode = "trash";
    rewire();
    const { container } = render(<ContextMenu />);
    // Only refresh button, no upload/new folder/paste
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    const labels = container.querySelectorAll("label");
    expect(labels.length).toBe(0);
  });

  it("renders trash file context menu with restore and permanent delete", () => {
    uiState.contextMenu = { x: 100, y: 100, type: "file", file: testFile };
    uiState.selectedIds = new Set(["file-1"]);
    fileState.browseMode = "trash";
    fileState.files = [testFile];
    rewire();
    const { container } = render(<ContextMenu />);
    const buttons = container.querySelectorAll("button");
    // Restore + permanent delete
    expect(buttons.length).toBe(2);
  });

  it("renders file context menu with download, rename, share, etc. in data mode", () => {
    uiState.contextMenu = { x: 100, y: 100, type: "file", file: testFile };
    uiState.selectedIds = new Set(["file-1"]);
    fileState.browseMode = "data";
    fileState.files = [testFile];
    rewire();
    const { container } = render(<ContextMenu />);
    const buttons = container.querySelectorAll("button");
    // Single file menu: download, rename, share, copy, cut, delete (≥6)
    expect(buttons.length).toBeGreaterThanOrEqual(6);
  });

  it("renders folder context menu with open folder option", () => {
    uiState.contextMenu = { x: 100, y: 100, type: "file", file: testFolder };
    uiState.selectedIds = new Set(["folder-1"]);
    fileState.browseMode = "data";
    fileState.files = [testFolder];
    rewire();
    const { container } = render(<ContextMenu />);
    const buttons = container.querySelectorAll("button");
    // Folder menu: open, download folder, rename, copy, cut, delete (≥6)
    expect(buttons.length).toBeGreaterThanOrEqual(6);
  });

  it("renders multi-select file menu when multiple selected", () => {
    const file2: KakusuFile = {
      ...testFile,
      driveId: "file-2",
      name: "other.txt",
    };
    uiState.contextMenu = { x: 100, y: 100, type: "file", file: testFile };
    uiState.selectedIds = new Set(["file-1", "file-2"]);
    fileState.browseMode = "data";
    fileState.files = [testFile, file2];
    rewire();
    const { container } = render(<ContextMenu />);
    const buttons = container.querySelectorAll("button");
    // Multi-select: download all, share all, copy, cut, delete (≥5)
    expect(buttons.length).toBeGreaterThanOrEqual(5);
  });

  it("renders paste button when clipboard has items in data mode", () => {
    uiState.contextMenu = { x: 100, y: 100, type: "background" };
    uiState.clipboard = {
      action: "copy",
      files: [testFile],
      sourceFolderId: "data-folder-id",
    };
    fileState.browseMode = "data";
    rewire();
    const { container } = render(<ContextMenu />);
    // Should have paste button in addition to new folder, uploads, refresh
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(3);
  });

  it("calls closeContextMenu when menu rendered and escape key pressed", () => {
    uiState.contextMenu = { x: 100, y: 100, type: "background" };
    fileState.browseMode = "data";
    const closeContextMenu = vi.fn();
    uiState.closeContextMenu = closeContextMenu;
    rewire();
    render(<ContextMenu />);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closeContextMenu).toHaveBeenCalled();
  });

  it("positions menu using fixed positioning", () => {
    uiState.contextMenu = { x: 200, y: 300, type: "background" };
    fileState.browseMode = "data";
    rewire();
    const { container } = render(<ContextMenu />);
    const menu = container.firstElementChild as HTMLElement;
    expect(menu.style.left).toBe("200px");
    expect(menu.style.top).toBe("300px");
  });
});
