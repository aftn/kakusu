import { MAX_RECURSION_DEPTH } from "@/config/app";
import { FOLDER_MIME } from "@/types";
import { DriveAPIError } from "@/utils/errors";
import { deleteFile, listAllFiles, trashFile } from "./api";
import { deleteFiles, trashFiles } from "./batch";
import { assertSafeId } from "./validation";

export type DeleteProgress = {
  phase: "scan" | "delete";
  found: number;
  deleted: number;
};

type DriveChildRef = {
  id: string;
  mimeType: string;
};

async function listFolderChildren(
  folderId: string,
  trashed: boolean,
): Promise<DriveChildRef[]> {
  assertSafeId(folderId);
  const fields = "files(id,mimeType)";
  const q = `'${folderId}' in parents and trashed=${trashed}`;
  return listAllFiles(q, fields);
}

interface CollectedDescendants {
  fileIds: string[];
  folderIds: string[]; // bottom-up order (deepest first)
}

async function collectDescendantsInner(
  folderId: string,
  trashed: boolean,
  result: CollectedDescendants,
  counter: { value: number },
  depth: number,
  onFound?: (count: number) => void,
): Promise<void> {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error("フォルダ階層が深すぎます（上限: 50階層）");
  }
  const children = await listFolderChildren(folderId, trashed);
  for (const child of children) {
    if (child.mimeType === FOLDER_MIME) {
      await collectDescendantsInner(
        child.id,
        trashed,
        result,
        counter,
        depth + 1,
        onFound,
      );
      result.folderIds.push(child.id);
    } else {
      result.fileIds.push(child.id);
    }
    counter.value++;
    onFound?.(counter.value);
  }
}

async function collectDescendants(
  folderId: string,
  trashed: boolean,
  onFound?: (count: number) => void,
): Promise<CollectedDescendants> {
  const result: CollectedDescendants = { fileIds: [], folderIds: [] };
  const counter = { value: 0 };
  await collectDescendantsInner(folderId, trashed, result, counter, 0, onFound);
  return result;
}

/**
 * フォルダの全子孫IDをボトムアップ順で収集する。
 * drive.file スコープではフォルダ直接 trash/delete が appNotAuthorizedToChild で
 * 失敗するため、先に子→親の順で個別に処理する必要がある。
 * 返却配列は [ファイルID群, フォルダID群(ボトムアップ順)] の順。
 * @param trashed trueの場合、ゴミ箱内の子を検索する（完全削除時用）
 */
export async function collectFolderIdsBottomUp(
  folderId: string,
  trashed = false,
  onFound?: (count: number) => void,
): Promise<string[]> {
  const { fileIds, folderIds } = await collectDescendants(
    folderId,
    trashed,
    onFound,
  );
  return [...fileIds, ...folderIds];
}

/**
 * フォルダのゴミ箱移動を試行。403の場合は永久削除にフォールバック。
 * drive.file スコープでは PATCH(trashed:true) が子孫チェックで失敗するため、
 * DELETE（永久削除）を代替手段として使う。
 */
async function trashOrDeleteFolder(folderId: string): Promise<void> {
  // 1. Try PATCH (trash)
  try {
    await trashFile(folderId);
    return;
  } catch (e) {
    if (!(e instanceof DriveAPIError)) throw e;
    if (e.status === 404) return; // already gone
    if (e.status !== 403) throw e;
    console.warn(`Trash PATCH 403 for folder ${folderId}: reason=${e.reason}`);
  }

  // 2. Fallback: DELETE (permanent removal)
  try {
    await deleteFile(folderId);
    return;
  } catch (e) {
    if (!(e instanceof DriveAPIError)) throw e;
    if (e.status === 404) return; // already gone
    if (e.status !== 403) throw e;
    console.warn(
      `DELETE also 403 for folder ${folderId}: reason=${(e as DriveAPIError).reason}`,
    );
  }
}

/**
 * フォルダの永久削除を試行。403/404は許容する。
 */
async function deleteOrIgnoreFolder(folderId: string): Promise<void> {
  try {
    await deleteFile(folderId);
  } catch (e) {
    if (!(e instanceof DriveAPIError)) throw e;
    if (e.status === 404) return; // already gone
    if (e.status !== 403) throw e;
    console.warn(`DELETE 403 for folder ${folderId}: reason=${e.reason}`);
  }
}

/**
 * フォルダをボトムアップでゴミ箱に移動する。
 * 3段階: (1) 全子孫IDを収集、(2) ファイルをバッチでゴミ箱移動、
 * (3) フォルダを個別に最深→最浅の順でゴミ箱移動（403時は永久削除フォールバック）。
 */
export async function trashFolderBottomUp(
  folderId: string,
  onProgress?: (p: DeleteProgress) => void,
): Promise<void> {
  onProgress?.({ phase: "scan", found: 0, deleted: 0 });
  const { fileIds, folderIds } = await collectDescendants(
    folderId,
    false,
    (count) => {
      onProgress?.({ phase: "scan", found: count, deleted: 0 });
    },
  );

  const total = fileIds.length + folderIds.length + 1;
  let deleted = 0;
  onProgress?.({ phase: "delete", found: total, deleted: 0 });

  // Phase 1: Batch trash all descendant files
  if (fileIds.length > 0) {
    await trashFiles(fileIds, (done) => {
      onProgress?.({ phase: "delete", found: total, deleted: done });
    });
    deleted = fileIds.length;
  }

  // Phase 2: Remove subfolder shells individually (deepest first)
  for (const subFolderId of folderIds) {
    await trashOrDeleteFolder(subFolderId);
    deleted++;
    onProgress?.({ phase: "delete", found: total, deleted });
  }

  // Phase 3: Remove root folder
  await trashOrDeleteFolder(folderId);
  deleted++;
  onProgress?.({ phase: "delete", found: total, deleted });
}

/**
 * フォルダをボトムアップで完全削除する。
 * ゴミ箱内のフォルダを完全削除するため trashed=true で子孫を収集する。
 */
export async function deleteFolderBottomUp(
  folderId: string,
  onProgress?: (p: DeleteProgress) => void,
): Promise<void> {
  onProgress?.({ phase: "scan", found: 0, deleted: 0 });
  const { fileIds, folderIds } = await collectDescendants(
    folderId,
    true,
    (count) => {
      onProgress?.({ phase: "scan", found: count, deleted: 0 });
    },
  );

  const total = fileIds.length + folderIds.length + 1;
  let deleted = 0;
  onProgress?.({ phase: "delete", found: total, deleted: 0 });

  // Phase 1: Batch delete all files permanently
  if (fileIds.length > 0) {
    await deleteFiles(fileIds, (done) => {
      onProgress?.({ phase: "delete", found: total, deleted: done });
    });
    deleted = fileIds.length;
  }

  // Phase 2: Delete subfolder shells individually (deepest first)
  for (const subFolderId of folderIds) {
    await deleteOrIgnoreFolder(subFolderId);
    deleted++;
    onProgress?.({ phase: "delete", found: total, deleted });
  }

  // Phase 3: Delete root folder
  await deleteOrIgnoreFolder(folderId);
  deleted++;
  onProgress?.({ phase: "delete", found: total, deleted });
}
