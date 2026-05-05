import { DATABASE_NAMES } from "@/config/app";
import type { CachedFile } from "@/types";
import { type DBSchema, type IDBPDatabase, openDB } from "idb";

interface FolderListing {
  folderId: string;
  files: string; // AES-GCM encrypted JSON-serialized KakusuFile[]
  iv: string;
  cachedAt: number;
}

interface KakusuDB extends DBSchema {
  files: {
    key: string;
    value: CachedFile;
    indexes: {
      "by-parent": string;
      "by-synced": number;
    };
  };
  meta: {
    key: string;
    value: string;
  };
  folderListings: {
    key: string;
    value: FolderListing;
  };
}

const DB_NAME = DATABASE_NAMES.current;
const DB_VERSION = 3;

let dbPromise: Promise<IDBPDatabase<KakusuDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<KakusuDB>> {
  if (!dbPromise) {
    dbPromise = openDB<KakusuDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          const fileStore = db.createObjectStore("files", {
            keyPath: "driveId",
          });
          fileStore.createIndex("by-parent", "parentId");
          fileStore.createIndex("by-synced", "syncedAt");
          db.createObjectStore("meta");
        }
        if (oldVersion < 2) {
          db.createObjectStore("folderListings", { keyPath: "folderId" });
        }
        if (oldVersion < 3) {
          transaction.objectStore("folderListings").clear();
        }
      },
    });
  }
  return dbPromise;
}

export async function clearDatabase(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["files", "meta", "folderListings"], "readwrite");
  await Promise.all([
    tx.objectStore("files").clear(),
    tx.objectStore("meta").clear(),
    tx.objectStore("folderListings").clear(),
    tx.done,
  ]);
}
