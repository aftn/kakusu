import { SESSION_STORAGE_KEYS } from "@/config/app";
import { loadToken, saveToken } from "@/drive/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Node 環境には localStorage/sessionStorage がないため stub を用意する
const storageStub = (): Storage => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
};

beforeEach(() => {
  vi.stubGlobal("localStorage", storageStub());
  vi.stubGlobal("sessionStorage", storageStub());
});

describe("saveToken / loadToken", () => {
  it("saveToken does not persist to localStorage", () => {
    saveToken("token123", 3600, "scope");
    expect(localStorage.getItem(SESSION_STORAGE_KEYS.accessToken)).toBeNull();
  });

  it("loadToken returns null when sessionStorage is empty", () => {
    // sessionStorage にトークンがない場合は null を返す
    const result = loadToken();
    expect(result).toBeNull();
  });
});
