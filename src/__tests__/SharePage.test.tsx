/**
 * @vitest-environment jsdom
 */
import { SESSION_STORAGE_KEYS } from "@/config/app";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockHook,
  defaultAuthState,
  defaultUIState,
} from "./helpers/storeMocks";

// ── Mock all crypto/drive modules ──
vi.mock("@/crypto/share", () => ({
  decodeShareKey: vi.fn(() => new Uint8Array(32)),
  encodeShareKey: vi.fn(() => "mock-key"),
  parseShareFragment: vi.fn(() => null),
}));
vi.mock("@/crypto/shareKey", () => ({
  decryptNameWithShareKey: vi.fn(),
  unwrapCEKWithShareKey: vi.fn(),
}));
vi.mock("@/crypto/chunk", () => ({
  decryptFile: vi.fn(),
  decryptFileStreaming: vi.fn(),
  decryptFileFromStream: vi.fn(),
}));
vi.mock("@/drive/shareMeta", () => ({
  fetchShareMetaFile: vi.fn(),
}));
vi.mock("@/drive/api", () => ({
  getFileContent: vi.fn(),
  getFileContentWithProgress: vi.fn(),
  getFileContentAsStream: vi.fn(),
}));
vi.mock("@/drive/auth", () => ({
  clearSilentAuthFailed: vi.fn(),
  hasSilentAuthFailed: vi.fn(() => true),
  silentRefresh: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/utils/preview", () => ({
  getMimeType: () => "application/octet-stream",
  getPreviewType: () => null,
  isHtmlFile: () => false,
  isMarkdownFile: () => false,
  isPreviewable: () => false,
  renderMarkdownPreview: vi.fn(),
  sanitizeFileName: (n: string) => n,
  MAX_PREVIEW_FILE_BYTES: 50_000_000,
  MAX_TEXT_PREVIEW_BYTES: 1_000_000,
  TEXT_PREVIEW_LIMIT_MESSAGE: "...",
}));
vi.mock("@/utils/download", () => ({
  downloadBlob: vi.fn(),
}));
vi.mock("@/utils/zip", () => ({
  ZipWriter: { forBlob: vi.fn() },
}));
vi.mock("@/components/ToastContainer", () => ({
  default: () => <div data-testid="toast-container" />,
}));

// ── Mock hooks ──
const mockLogin = vi.fn();
const mockUseAuth = vi.fn(() => ({ isAuthenticated: false, login: mockLogin }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => mockUseAuth(),
}));

// ── Store states ──
let authState = defaultAuthState();
let uiState = defaultUIState();

vi.mock("@/stores/authStore", () => ({
  useAuthStore: createMockHook(authState),
}));
vi.mock("@/stores/uiStore", () => ({
  useUIStore: createMockHook(uiState),
}));

const { default: SharePage } = await import("@/pages/SharePage");
const { useAuthStore } = await import("@/stores/authStore");
const { useUIStore } = await import("@/stores/uiStore");
const { parseShareFragment } = await import("@/crypto/share");
const { hasSilentAuthFailed, silentRefresh } = await import("@/drive/auth");

function rewire() {
  (
    useAuthStore as unknown as ReturnType<typeof createMockHook>
  ).mockImplementation((sel?: (s: typeof authState) => unknown) =>
    sel ? sel(authState) : authState,
  );
  (useAuthStore as unknown as { getState: () => typeof authState }).getState =
    vi.fn(() => authState);

  (
    useUIStore as unknown as ReturnType<typeof createMockHook>
  ).mockImplementation((sel?: (s: typeof uiState) => unknown) =>
    sel ? sel(uiState) : uiState,
  );
  (useUIStore as unknown as { getState: () => typeof uiState }).getState =
    vi.fn(() => uiState);
}

beforeEach(() => {
  authState = defaultAuthState();
  uiState = defaultUIState();
  rewire();
  vi.mocked(parseShareFragment).mockReturnValue(null);
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("SharePage", () => {
  it("shows error state when share fragment is invalid", () => {
    vi.mocked(parseShareFragment).mockReturnValue(null);
    const { container } = render(<SharePage />);
    // Error page should render with error icon and link to home
    const link = container.querySelector('a[href="/"]');
    expect(link).toBeTruthy();
  });

  it("renders toast container on error state", () => {
    const { container } = render(<SharePage />);
    expect(
      container.querySelector('[data-testid="toast-container"]'),
    ).toBeTruthy();
  });

  it("shows needLogin state when share key is valid but not authenticated", async () => {
    vi.mocked(parseShareFragment).mockReturnValue({
      metaFileId: "test-meta-id",
      shareKey: new Uint8Array(32),
    });
    mockUseAuth.mockReturnValue({ isAuthenticated: false, login: mockLogin });
    vi.mocked(hasSilentAuthFailed).mockReturnValue(true);

    const { container } = render(<SharePage />);

    // Wait for useEffect to run - needLogin state shows login button
    await vi.waitFor(() => {
      const buttons = container.querySelectorAll("button");
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  it("shows loading spinner when status is loading", () => {
    vi.mocked(parseShareFragment).mockReturnValue({
      metaFileId: "test-meta-id",
      shareKey: new Uint8Array(32),
    });
    // silentRefresh returns a pending promise → stays in "loading"
    vi.mocked(silentRefresh).mockReturnValue(new Promise(() => {}));
    vi.mocked(hasSilentAuthFailed).mockReturnValue(false);
    mockUseAuth.mockReturnValue({ isAuthenticated: false, login: mockLogin });

    const { container } = render(<SharePage />);
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeTruthy();
  });

  it("stores share link data in sessionStorage when fragment is valid", () => {
    vi.mocked(parseShareFragment).mockReturnValue({
      metaFileId: "test-meta-id",
      shareKey: new Uint8Array(32),
    });
    render(<SharePage />);
    expect(sessionStorage.getItem(SESSION_STORAGE_KEYS.shareMetaId)).toBe(
      "test-meta-id",
    );
  });

  it("clears session on error", () => {
    sessionStorage.setItem(SESSION_STORAGE_KEYS.shareMetaId, "old-id");
    sessionStorage.setItem(SESSION_STORAGE_KEYS.shareKey, "old-key");
    vi.mocked(parseShareFragment).mockReturnValue(null);
    render(<SharePage />);
    expect(sessionStorage.getItem(SESSION_STORAGE_KEYS.shareMetaId)).toBeNull();
  });
});
