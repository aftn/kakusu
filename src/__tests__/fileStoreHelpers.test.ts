import { buildRestorePlan } from "@/stores/fileStoreHelpers";
import type { KakusuFile } from "@/types";
import { describe, expect, it } from "vitest";

function makeFile(
  partial: Partial<KakusuFile> &
    Pick<KakusuFile, "driveId" | "parentId" | "name" | "type">,
): KakusuFile {
  return {
    nameEncrypted: false,
    modifiedTime: "2024-01-01T00:00:00Z",
    ...partial,
  };
}

describe("buildRestorePlan", () => {
  it("restores trashed ancestors before a selected file", () => {
    const root = makeFile({
      driveId: "root",
      parentId: "vault",
      name: "root",
      type: "folder",
    });
    const childFolder = makeFile({
      driveId: "child",
      parentId: "root",
      name: "child",
      type: "folder",
    });
    const file = makeFile({
      driveId: "file",
      parentId: "child",
      name: "file.txt",
      type: "file",
    });

    const plan = buildRestorePlan([file, childFolder, root], [file]);

    expect(plan.map((entry) => entry.driveId)).toEqual([
      "root",
      "child",
      "file",
    ]);
  });

  it("deduplicates shared ancestors across multiple selected files", () => {
    const folder = makeFile({
      driveId: "folder",
      parentId: "vault",
      name: "folder",
      type: "folder",
    });
    const fileA = makeFile({
      driveId: "a",
      parentId: "folder",
      name: "a.txt",
      type: "file",
    });
    const fileB = makeFile({
      driveId: "b",
      parentId: "folder",
      name: "b.txt",
      type: "file",
    });

    const plan = buildRestorePlan([folder, fileA, fileB], [fileA, fileB]);

    expect(plan.map((entry) => entry.driveId)).toEqual(["folder", "a", "b"]);
  });

  it("handles already top-level files without adding extra entries", () => {
    const file = makeFile({
      driveId: "file",
      parentId: "vault",
      name: "file.txt",
      type: "file",
    });

    const plan = buildRestorePlan([file], [file]);

    expect(plan.map((entry) => entry.driveId)).toEqual(["file"]);
  });
});
