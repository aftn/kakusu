import { useFileStore } from "@/stores/fileStore";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/stores/vaultStore", () => ({
  useVaultStore: {
    getState: () => ({
      mekEnc: null,
      dataFolderId: "data-root",
      nameKey: null,
      vaultKey: null,
    }),
  },
}));

vi.mock("@/stores/uiStore", () => ({
  useUIStore: {
    getState: () => ({
      addToast: vi.fn(),
      updateToast: vi.fn(),
    }),
  },
}));

vi.mock("@/cache/store", () => ({
  clearAllFiles: vi.fn(),
  getCachedFolderListing: vi.fn(() => Promise.resolve(null)),
  setCachedFolderListing: vi.fn(),
}));

vi.mock("@/cache/settings", () => ({
  getCacheMaxAgeMs: vi.fn(() => 0),
}));

vi.mock("@/stores/cacheSettingsStore", () => ({
  useCacheSettingsStore: {
    getState: () => ({ metadataCacheMode: "off" }),
  },
}));

vi.mock("@/drive/api", () => ({
  listDataFiles: vi.fn(() => Promise.resolve([])),
}));

describe("useFileStore navigation", () => {
  beforeEach(() => {
    useFileStore.setState({
      files: [],
      currentFolderId: null,
      folderPath: [],
      loading: false,
      browseMode: "data",
      canGoBack: false,
      canGoForward: false,
      _navHistory: [],
      _navIndex: -1,
      _navigatingFromHistory: false,
    });
  });

  it("initial state has empty nav history", () => {
    const s = useFileStore.getState();
    expect(s._navHistory).toEqual([]);
    expect(s._navIndex).toBe(-1);
    expect(s.canGoBack).toBe(false);
    expect(s.canGoForward).toBe(false);
  });

  it("navigate pushes a nav entry", () => {
    useFileStore.getState().navigate("folder-1", "Folder 1");
    const s = useFileStore.getState();
    expect(s._navHistory.length).toBe(1);
    expect(s._navHistory[0]).toEqual({
      folderId: "folder-1",
      folderPath: [{ id: "folder-1", name: "Folder 1" }],
      browseMode: "data",
    });
    expect(s._navIndex).toBe(0);
    expect(s.canGoBack).toBe(false);
  });

  it("navigate twice then goBack", () => {
    const store = useFileStore.getState();
    store.navigate("folder-1", "Folder 1");
    store.navigate("folder-2", "Folder 2");

    let s = useFileStore.getState();
    expect(s._navIndex).toBe(1);
    expect(s.canGoBack).toBe(true);

    store.goBack();
    s = useFileStore.getState();
    expect(s._navIndex).toBe(0);
    expect(s.canGoForward).toBe(true);
  });

  it("goBack then goForward restores forward history", () => {
    const store = useFileStore.getState();
    store.navigate("a", "A");
    store.navigate("b", "B");
    store.goBack();
    store.goForward();

    const s = useFileStore.getState();
    expect(s._navIndex).toBe(1);
    expect(s.canGoForward).toBe(false);
  });

  it("new navigate trims forward history", () => {
    const store = useFileStore.getState();
    store.navigate("a", "A");
    store.navigate("b", "B");
    store.goBack();
    store.navigate("c", "C");

    const s = useFileStore.getState();
    expect(s._navHistory.length).toBe(2);
    expect(s._navHistory[1]?.folderId).toBe("c");
    expect(s.canGoForward).toBe(false);
  });

  it("setBrowseMode resets nav history", () => {
    const store = useFileStore.getState();
    store.navigate("a", "A");
    store.setBrowseMode("trash");

    const s = useFileStore.getState();
    expect(s.browseMode).toBe("trash");
    expect(s._navHistory.length).toBe(1);
    expect(s._navHistory[0]?.browseMode).toBe("trash");
  });
});
