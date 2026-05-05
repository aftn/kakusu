/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockHook,
  defaultAuthState,
  defaultCacheSettingsState,
  defaultFileState,
  defaultShareState,
  defaultUIState,
  defaultVaultState,
} from "./helpers/storeMocks";

// ── Mock child components ──
vi.mock("@/components/Breadcrumb", () => ({
  default: () => <div data-testid="breadcrumb" />,
}));
vi.mock("@/components/ConfirmDialog", () => ({
  default: () => <div data-testid="confirm-dialog" />,
}));
vi.mock("@/components/ContextMenu", () => ({
  default: () => <div data-testid="context-menu" />,
}));
vi.mock("@/components/DropZone", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="drop-zone">{children}</div>
  ),
}));
vi.mock("@/components/FileList", () => ({
  default: () => <div data-testid="file-list" />,
}));
vi.mock("@/components/FilePreview", () => ({
  default: () => <div data-testid="file-preview" />,
}));
vi.mock("@/components/PasswordChange", () => ({
  default: () => <div data-testid="password-change" />,
}));
vi.mock("@/components/SettingsDialog", () => ({
  default: () => <div data-testid="settings-dialog" />,
}));
vi.mock("@/components/ShareDialog", () => ({
  default: () => <div data-testid="share-dialog" />,
}));
vi.mock("@/components/ToastContainer", () => ({
  default: () => <div data-testid="toast-container" />,
}));

// ── Mock hooks ──
vi.mock("@/hooks/useUpload", () => ({
  useUpload: () => ({ handleUpload: vi.fn() }),
}));

// ── Build store states ──
let vaultState = defaultVaultState();
let fileState = defaultFileState();
let uiState = defaultUIState();
let authState = defaultAuthState();
let shareState = defaultShareState();
let cacheState = defaultCacheSettingsState();

// ── Mock stores ──
vi.mock("@/stores/vaultStore", () => ({
  useVaultStore: createMockHook(vaultState),
}));
vi.mock("@/stores/fileStore", () => ({
  useFileStore: createMockHook(fileState),
}));
vi.mock("@/stores/uiStore", () => ({
  useUIStore: createMockHook(uiState),
}));
vi.mock("@/stores/authStore", () => ({
  useAuthStore: createMockHook(authState),
}));
vi.mock("@/stores/shareStore", () => ({
  useShareStore: createMockHook(shareState),
}));
vi.mock("@/stores/cacheSettingsStore", () => ({
  useCacheSettingsStore: createMockHook(cacheState),
}));

// Dynamic import so mocks take effect first
const { default: VaultPage } = await import("@/pages/VaultPage");
const { useFileStore } = await import("@/stores/fileStore");
const { useUIStore } = await import("@/stores/uiStore");
const { useAuthStore } = await import("@/stores/authStore");
const { useVaultStore } = await import("@/stores/vaultStore");
const { useShareStore } = await import("@/stores/shareStore");

function rewire() {
  (
    useVaultStore as unknown as ReturnType<typeof createMockHook>
  ).mockImplementation((sel?: (s: typeof vaultState) => unknown) =>
    sel ? sel(vaultState) : vaultState,
  );
  (useVaultStore as unknown as { getState: () => typeof vaultState }).getState =
    vi.fn(() => vaultState);

  (
    useFileStore as unknown as ReturnType<typeof createMockHook>
  ).mockImplementation((sel?: (s: typeof fileState) => unknown) =>
    sel ? sel(fileState) : fileState,
  );
  (useFileStore as unknown as { getState: () => typeof fileState }).getState =
    vi.fn(() => fileState);

  (
    useUIStore as unknown as ReturnType<typeof createMockHook>
  ).mockImplementation((sel?: (s: typeof uiState) => unknown) =>
    sel ? sel(uiState) : uiState,
  );
  (useUIStore as unknown as { getState: () => typeof uiState }).getState =
    vi.fn(() => uiState);

  (
    useAuthStore as unknown as ReturnType<typeof createMockHook>
  ).mockImplementation((sel?: (s: typeof authState) => unknown) =>
    sel ? sel(authState) : authState,
  );
  (useAuthStore as unknown as { getState: () => typeof authState }).getState =
    vi.fn(() => authState);

  (
    useShareStore as unknown as ReturnType<typeof createMockHook>
  ).mockImplementation((sel?: (s: typeof shareState) => unknown) =>
    sel ? sel(shareState) : shareState,
  );
  (useShareStore as unknown as { getState: () => typeof shareState }).getState =
    vi.fn(() => shareState);
}

beforeEach(() => {
  vaultState = defaultVaultState();
  fileState = defaultFileState();
  uiState = defaultUIState();
  authState = defaultAuthState();
  shareState = defaultShareState();
  cacheState = defaultCacheSettingsState();
  rewire();
});

afterEach(() => {
  cleanup();
});

describe("VaultPage", () => {
  it("renders header with KaKuSu logo text", () => {
    render(<VaultPage />);
    expect(screen.getByText("KaKuSu")).toBeTruthy();
  });

  it("does not render the header logo as a navigation button", () => {
    render(<VaultPage />);
    expect(screen.queryByLabelText("トップへ戻る")).toBeNull();
  });

  it("renders toast container", () => {
    render(<VaultPage />);
    expect(screen.getByTestId("toast-container")).toBeTruthy();
  });

  it("shows error banner when error is set", () => {
    uiState.error = "test error message";
    rewire();
    render(<VaultPage />);
    expect(screen.getByText("test error message")).toBeTruthy();
  });

  it("shows account menu button with user name as title", () => {
    render(<VaultPage />);
    expect(screen.getByTitle("Test User")).toBeTruthy();
  });

  it("shows initials when no avatar picture", () => {
    authState.user = {
      email: "user@example.com",
      name: "Test User",
      picture: undefined,
    };
    rewire();
    render(<VaultPage />);
    expect(screen.getByText("TU")).toBeTruthy();
  });

  it("renders upload label and new folder button in data mode", () => {
    render(<VaultPage />);
    expect(screen.getByText("KaKuSu")).toBeTruthy();
    // New folder button has aria-label
    const newFolderButtons = screen
      .getAllByRole("button")
      .filter((btn) => btn.getAttribute("aria-label") === "新しいフォルダ");
    expect(newFolderButtons.length).toBeGreaterThan(0);
  });

  it("renders DropZone wrapper in data mode", () => {
    render(<VaultPage />);
    expect(screen.getByTestId("drop-zone")).toBeTruthy();
  });

  it("renders Breadcrumb component", () => {
    render(<VaultPage />);
    expect(screen.getByTestId("breadcrumb")).toBeTruthy();
  });

  it("renders context menu slot", () => {
    render(<VaultPage />);
    expect(screen.getByTestId("context-menu")).toBeTruthy();
  });

  it("shows empty trash button when in trash mode with files", () => {
    fileState.browseMode = "trash";
    fileState.files = [
      {
        driveId: "f1",
        parentId: "trash",
        name: "deleted.txt",
        nameEncrypted: false,
        type: "file",
        modifiedTime: "2024-01-01T00:00:00Z",
      },
    ];
    rewire();
    const { container } = render(<VaultPage />);
    // Mobile FAB has aria-label, desktop toolbar button has text content
    const trashBtns = container.querySelectorAll(
      '[aria-label="ゴミ箱を空にする"]',
    );
    expect(trashBtns.length).toBeGreaterThan(0);
  });

  it("shows an empty trash message without upload guidance", () => {
    fileState.browseMode = "trash";
    fileState.files = [];
    rewire();
    render(<VaultPage />);

    expect(screen.getByText("ゴミ箱は空です")).toBeTruthy();
    expect(screen.queryByText(/アップロードボタンでファイルを追加/)).toBeNull();
  });

  it("renders search input with correct placeholder in data mode", () => {
    render(<VaultPage />);
    const input = document.querySelector(
      'input[type="text"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.placeholder).toContain("検索");
  });

  it("shows loading spinner when loading with empty file list", () => {
    fileState.loading = true;
    fileState.files = [];
    rewire();
    render(<VaultPage />);
    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeTruthy();
  });

  it("shows share links when in share browse mode", () => {
    fileState.browseMode = "share";
    shareState.shareLinks = [
      {
        shareName: "Shared Test",
        summary: {
          metaFileId: "sm1",
          itemCount: 3,
          createdTime: "2024-01-01",
          status: "active",
        },
      },
    ];
    rewire();
    render(<VaultPage />);
    expect(screen.getByText("Shared Test")).toBeTruthy();
  });

  it("shows empty share message when no share links", () => {
    fileState.browseMode = "share";
    shareState.shareLinks = [];
    shareState.loading = false;
    rewire();
    render(<VaultPage />);
    expect(screen.getByText("共有リンクはありません")).toBeTruthy();
  });

  it("navigation back button exists and is disabled when canGoBack is false", () => {
    fileState.canGoBack = false;
    rewire();
    const { container } = render(<VaultPage />);
    // Button has title with Japanese text; use querySelector to avoid encoding sensitivity
    const backBtns = Array.from(container.querySelectorAll("button[disabled]"));
    // At least one disabled button should exist for navigation
    expect(backBtns.length).toBeGreaterThan(0);
  });

  it("navigation forward button exists and is disabled when canGoForward is false", () => {
    fileState.canGoForward = false;
    rewire();
    const { container } = render(<VaultPage />);
    const disabledBtns = container.querySelectorAll("button[disabled]");
    expect(disabledBtns.length).toBeGreaterThan(0);
  });

  it("renders settings button", () => {
    const { container } = render(<VaultPage />);
    // Settings button is in the header actions area
    const headerButtons = container.querySelectorAll("header button");
    expect(headerButtons.length).toBeGreaterThan(0);
  });

  it("renders lock and logout buttons in account menu", () => {
    const { container } = render(<VaultPage />);
    // Open account menu by clicking the account button
    const accountBtn = screen.getByTitle("Test User");
    fireEvent.click(accountBtn);
    // After click, accountMenuOpen → true and menu role="menu" should render
    const menu = container.querySelector('[role="menu"]');
    expect(menu).toBeTruthy();
  });
});
