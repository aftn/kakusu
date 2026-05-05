import { FOLDER_MIME } from "@/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---
const listAllFilesMock =
  vi.fn<
    (
      q: string,
      fields: string,
    ) => Promise<Array<{ id: string; mimeType: string }>>
  >();
const trashFileMock = vi.fn<(id: string) => Promise<void>>();
const deleteFileMock = vi.fn<(id: string) => Promise<void>>();
const trashFilesMock =
  vi.fn<(ids: string[], onChunkDone?: (n: number) => void) => Promise<void>>();
const deleteFilesMock =
  vi.fn<(ids: string[], onChunkDone?: (n: number) => void) => Promise<void>>();

vi.mock("@/drive/api", () => ({
  listAllFiles: (...args: Parameters<typeof listAllFilesMock>) =>
    listAllFilesMock(...args),
  trashFile: (...args: Parameters<typeof trashFileMock>) =>
    trashFileMock(...args),
  deleteFile: (...args: Parameters<typeof deleteFileMock>) =>
    deleteFileMock(...args),
}));

vi.mock("@/drive/batch", () => ({
  trashFiles: (...args: Parameters<typeof trashFilesMock>) =>
    trashFilesMock(...args),
  deleteFiles: (...args: Parameters<typeof deleteFilesMock>) =>
    deleteFilesMock(...args),
}));

vi.mock("@/utils/errors", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual };
});

import {
  collectFolderIdsBottomUp,
  deleteFolderBottomUp,
  trashFolderBottomUp,
} from "@/drive/recursiveOps";
import { DriveAPIError } from "@/utils/errors";

beforeEach(() => {
  vi.clearAllMocks();
  listAllFilesMock.mockResolvedValue([]);
  trashFileMock.mockResolvedValue(undefined);
  deleteFileMock.mockResolvedValue(undefined);
  trashFilesMock.mockResolvedValue(undefined);
  deleteFilesMock.mockResolvedValue(undefined);
});

describe("collectFolderIdsBottomUp", () => {
  it("returns empty array for empty folder", async () => {
    listAllFilesMock.mockResolvedValueOnce([]);
    const result = await collectFolderIdsBottomUp("folder-root");
    expect(result).toEqual([]);
    expect(listAllFilesMock).toHaveBeenCalledWith(
      "'folder-root' in parents and trashed=false",
      "files(id,mimeType)",
    );
  });

  it("returns file IDs for folder with only files", async () => {
    listAllFilesMock.mockResolvedValueOnce([
      { id: "file-1", mimeType: "application/octet-stream" },
      { id: "file-2", mimeType: "text/plain" },
    ]);
    const result = await collectFolderIdsBottomUp("folder-root");
    expect(result).toEqual(["file-1", "file-2"]);
  });

  it("returns IDs in bottom-up order for nested folders", async () => {
    // Root folder contains: subfolder-A, file-1
    listAllFilesMock.mockImplementation(async (q: string) => {
      if (q.includes("'folder-root'")) {
        return [
          { id: "subfolder-A", mimeType: FOLDER_MIME },
          { id: "file-1", mimeType: "application/octet-stream" },
        ];
      }
      if (q.includes("'subfolder-A'")) {
        return [
          { id: "file-A1", mimeType: "application/octet-stream" },
          { id: "file-A2", mimeType: "application/octet-stream" },
        ];
      }
      return [];
    });

    const result = await collectFolderIdsBottomUp("folder-root");
    // Bottom-up: files in subfolder-A come first, then subfolder-A, then file-1
    // Actually: file-A1, file-A2 (subfolder children), file-1 (root file), subfolder-A (root subfolder)
    expect(result).toEqual(["file-A1", "file-A2", "file-1", "subfolder-A"]);
  });

  it("handles deeply nested folders (3 levels)", async () => {
    // Root -> subA -> subB -> file-deep
    // Root also has file-root
    listAllFilesMock.mockImplementation(async (q: string) => {
      if (q.includes("'root'")) {
        return [
          { id: "subA", mimeType: FOLDER_MIME },
          { id: "file-root", mimeType: "text/plain" },
        ];
      }
      if (q.includes("'subA'")) {
        return [
          { id: "subB", mimeType: FOLDER_MIME },
          { id: "file-A", mimeType: "text/plain" },
        ];
      }
      if (q.includes("'subB'")) {
        return [{ id: "file-deep", mimeType: "text/plain" }];
      }
      return [];
    });

    const result = await collectFolderIdsBottomUp("root");
    // Expected order: files first (bottom-up), then folders (bottom-up)
    // 1. file-deep (deepest file in subB)
    // 2. file-A (file in subA)
    // 3. file-root (file in root)
    // 4. subB (subfolder of subA)
    // 5. subA (subfolder of root)
    expect(result).toEqual([
      "file-deep",
      "file-A",
      "file-root",
      "subB",
      "subA",
    ]);
  });

  it("uses trashed=true when trashed flag is set", async () => {
    listAllFilesMock.mockResolvedValueOnce([]);
    await collectFolderIdsBottomUp("folder-trashed", true);
    expect(listAllFilesMock).toHaveBeenCalledWith(
      "'folder-trashed' in parents and trashed=true",
      "files(id,mimeType)",
    );
  });

  it("handles multiple sibling subfolders", async () => {
    listAllFilesMock.mockImplementation(async (q: string) => {
      if (q.includes("'root'")) {
        return [
          { id: "subA", mimeType: FOLDER_MIME },
          { id: "subB", mimeType: FOLDER_MIME },
        ];
      }
      if (q.includes("'subA'")) {
        return [{ id: "file-A1", mimeType: "text/plain" }];
      }
      if (q.includes("'subB'")) {
        return [{ id: "file-B1", mimeType: "text/plain" }];
      }
      return [];
    });

    const result = await collectFolderIdsBottomUp("root");
    // file-A1 (subA children), file-B1 (subB children), then subA, subB (root subfolders)
    expect(result).toEqual(["file-A1", "file-B1", "subA", "subB"]);
  });

  it("rejects unsafe folder IDs", async () => {
    await expect(collectFolderIdsBottomUp("'; DROP TABLE --")).rejects.toThrow(
      /Invalid Drive ID/,
    );
  });
});

describe("trashFolderBottomUp", () => {
  it("trashes empty folder directly", async () => {
    listAllFilesMock.mockResolvedValueOnce([]);
    await trashFolderBottomUp("empty-folder");
    expect(trashFilesMock).not.toHaveBeenCalled();
    // Root folder trashed individually via trashOrDeleteFolder
    expect(trashFileMock).toHaveBeenCalledWith("empty-folder");
  });

  it("batch-trashes files then trashes root folder individually", async () => {
    listAllFilesMock.mockImplementation(async (q: string) => {
      if (q.includes("'parent-folder'")) {
        return [
          { id: "child-1", mimeType: "text/plain" },
          { id: "child-2", mimeType: "text/plain" },
        ];
      }
      return [];
    });

    await trashFolderBottomUp("parent-folder");
    expect(trashFilesMock).toHaveBeenCalledWith(
      ["child-1", "child-2"],
      expect.any(Function),
    );
    expect(trashFileMock).toHaveBeenCalledWith("parent-folder");

    const batchOrder = trashFilesMock.mock.invocationCallOrder[0]!;
    const singleOrder = trashFileMock.mock.invocationCallOrder[0]!;
    expect(batchOrder).toBeLessThan(singleOrder);
  });

  it("handles nested folders: files batch, then subfolders individually, then root", async () => {
    listAllFilesMock.mockImplementation(async (q: string) => {
      if (q.includes("'root'")) {
        return [
          { id: "sub", mimeType: FOLDER_MIME },
          { id: "file-root", mimeType: "text/plain" },
        ];
      }
      if (q.includes("'sub'")) {
        return [{ id: "file-sub", mimeType: "text/plain" }];
      }
      return [];
    });

    await trashFolderBottomUp("root");
    // All files collected and batch-trashed together
    expect(trashFilesMock).toHaveBeenCalledWith(
      ["file-sub", "file-root"],
      expect.any(Function),
    );
    // Subfolder trashed individually, then root
    expect(trashFileMock.mock.calls).toEqual([["sub"], ["root"]]);

    const filesBatchOrder = trashFilesMock.mock.invocationCallOrder[0]!;
    const subFolderOrder = trashFileMock.mock.invocationCallOrder[0]!;
    const rootOrder = trashFileMock.mock.invocationCallOrder[1]!;
    expect(filesBatchOrder).toBeLessThan(subFolderOrder);
    expect(subFolderOrder).toBeLessThan(rootOrder);
  });

  it("falls back to DELETE when PATCH gives 403", async () => {
    listAllFilesMock.mockResolvedValueOnce([]);
    trashFileMock.mockRejectedValueOnce(new DriveAPIError("forbidden", 403));
    await trashFolderBottomUp("stubborn-folder");
    expect(trashFileMock).toHaveBeenCalledWith("stubborn-folder");
    // Fell back to deleteFile
    expect(deleteFileMock).toHaveBeenCalledWith("stubborn-folder");
  });

  it("silently handles 403 on both PATCH and DELETE for folder", async () => {
    listAllFilesMock.mockResolvedValueOnce([]);
    trashFileMock.mockRejectedValueOnce(new DriveAPIError("forbidden", 403));
    deleteFileMock.mockRejectedValueOnce(new DriveAPIError("forbidden", 403));
    // Should not throw — silently gives up on the folder
    await expect(trashFolderBottomUp("stuck-folder")).resolves.toBeUndefined();
  });

  it("calls progress callback with scan and delete phases", async () => {
    listAllFilesMock.mockImplementation(async (q: string) => {
      if (q.includes("'folder'")) {
        return [
          { id: "f1", mimeType: "text/plain" },
          { id: "f2", mimeType: "text/plain" },
        ];
      }
      return [];
    });

    const progress: Array<{ phase: string; found: number; deleted: number }> =
      [];
    await trashFolderBottomUp("folder", (p) => progress.push({ ...p }));

    expect(progress.some((p) => p.phase === "scan")).toBe(true);
    expect(progress.some((p) => p.phase === "delete")).toBe(true);
    const last = progress[progress.length - 1]!;
    expect(last.phase).toBe("delete");
    expect(last.found).toBe(3);
    expect(last.deleted).toBe(3);
  });

  it("uses trashed=false for listing (active files)", async () => {
    listAllFilesMock.mockResolvedValueOnce([]);
    await trashFolderBottomUp("folder-x");
    expect(listAllFilesMock).toHaveBeenCalledWith(
      "'folder-x' in parents and trashed=false",
      expect.any(String),
    );
  });
});

describe("deleteFolderBottomUp", () => {
  it("deletes empty folder directly", async () => {
    listAllFilesMock.mockResolvedValueOnce([]);
    await deleteFolderBottomUp("empty-folder");
    expect(deleteFilesMock).not.toHaveBeenCalled();
    expect(deleteFileMock).toHaveBeenCalledWith("empty-folder");
  });

  it("batch-deletes files then deletes root folder individually", async () => {
    listAllFilesMock.mockImplementation(async (q: string) => {
      if (q.includes("'parent-folder'")) {
        return [
          { id: "child-1", mimeType: "text/plain" },
          { id: "child-2", mimeType: "text/plain" },
        ];
      }
      return [];
    });

    await deleteFolderBottomUp("parent-folder");
    expect(deleteFilesMock).toHaveBeenCalledWith(
      ["child-1", "child-2"],
      expect.any(Function),
    );
    expect(deleteFileMock).toHaveBeenCalledWith("parent-folder");
  });

  it("uses trashed=true for listing (trashed files)", async () => {
    listAllFilesMock.mockResolvedValueOnce([]);
    await deleteFolderBottomUp("folder-x");
    expect(listAllFilesMock).toHaveBeenCalledWith(
      "'folder-x' in parents and trashed=true",
      expect.any(String),
    );
  });

  it("handles nested trashed folders bottom-up", async () => {
    listAllFilesMock.mockImplementation(async (q: string) => {
      if (q.includes("'root'")) {
        return [
          { id: "sub", mimeType: FOLDER_MIME },
          { id: "file-root", mimeType: "text/plain" },
        ];
      }
      if (q.includes("'sub'")) {
        return [{ id: "file-sub", mimeType: "text/plain" }];
      }
      return [];
    });

    await deleteFolderBottomUp("root");
    expect(deleteFilesMock).toHaveBeenCalledWith(
      ["file-sub", "file-root"],
      expect.any(Function),
    );
    // Subfolders and root deleted individually
    expect(deleteFileMock.mock.calls).toEqual([["sub"], ["root"]]);

    const filesBatchOrder = deleteFilesMock.mock.invocationCallOrder[0]!;
    const subFolderOrder = deleteFileMock.mock.invocationCallOrder[0]!;
    const rootOrder = deleteFileMock.mock.invocationCallOrder[1]!;
    expect(filesBatchOrder).toBeLessThan(subFolderOrder);
    expect(subFolderOrder).toBeLessThan(rootOrder);
  });

  it("silently handles 403 on folder DELETE", async () => {
    listAllFilesMock.mockResolvedValueOnce([]);
    deleteFileMock.mockRejectedValueOnce(new DriveAPIError("forbidden", 403));
    await expect(deleteFolderBottomUp("stuck-folder")).resolves.toBeUndefined();
  });
});
