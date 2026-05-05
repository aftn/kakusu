import { clearAllFiles } from "@/cache/store";
import {
  APP_GITHUB_URL,
  PRIVACY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
} from "@/config/app";
import { sanitizeTextInput, validateDriveFolderName } from "@/drive/validation";
import { useCacheSettingsStore } from "@/stores/cacheSettingsStore";
import { useFileStore } from "@/stores/fileStore";
import { useUIStore } from "@/stores/uiStore";
import { syncSettingToMeta } from "@/stores/vaultStore";
import { useVaultStore } from "@/stores/vaultStore";
import type {
  BulkUploadBehavior,
  CacheMetadataMode,
  ParallelFileCount,
  PreviewCacheMode,
  ThemeMode,
  UserIconDisplay,
} from "@/types";
import { clearPreviewCache } from "@/utils/previewCache";
import { useEffect, useMemo, useState } from "react";

interface SettingsDialogProps {
  onClose: () => void;
}

type SettingsSectionId =
  | "security"
  | "performance"
  | "display"
  | "app"
  | "project";

interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  description: string;
}

function SettingsIcon({
  title,
  className,
  children,
}: {
  title: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      focusable="false"
    >
      <title>{title}</title>
      {children}
    </svg>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h3>
        {description && (
          <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
            {description}
          </p>
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onToggle,
}: {
  title: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-4 dark:border-gray-700 dark:bg-gray-900">
      <div>
        <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
          {title}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          {description}
        </p>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className={`relative h-7 w-12 shrink-0 rounded-full transition ${
          checked ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600"
        }`}
        aria-pressed={checked}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition ${
            checked ? "translate-x-5" : ""
          }`}
        />
      </button>
    </div>
  );
}

function RadioCard({
  title,
  description,
  checked,
  onSelect,
}: {
  title: string;
  description: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-xl border px-4 py-4 text-left transition ${
        checked
          ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/20"
          : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-600 dark:hover:bg-gray-700"
      }`}
    >
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
          checked
            ? "border-blue-600 dark:border-blue-400"
            : "border-gray-300 dark:border-gray-600"
        }`}
      >
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            checked ? "bg-blue-600 dark:bg-blue-400" : "bg-transparent"
          }`}
        />
      </span>
      <span>
        <span className="block text-sm font-medium text-gray-800 dark:text-gray-200">
          {title}
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          {description}
        </span>
      </span>
    </button>
  );
}

export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const {
    defaultEncryptName,
    setDefaultEncryptName,
    openPasswordChange,
    themeMode,
    setThemeMode,
    userIconDisplay,
    setUserIconDisplay,
    autoPopupLogin,
    setAutoPopupLogin,
    bulkUploadBehavior,
    setBulkUploadBehavior,
    parallelFileCount,
    setParallelFileCount,
  } = useUIStore();
  const githubUrl = (import.meta.env.VITE_GITHUB_URL as string | undefined)
    ?.trim()
    .replace(/\/$/, "");
  const projectGithubUrl = githubUrl || APP_GITHUB_URL;
  const applyNameEncryptionToAll = useFileStore(
    (s) => s.applyNameEncryptionToAll,
  );
  const metadataCacheMode = useCacheSettingsStore((s) => s.metadataCacheMode);
  const previewCacheMode = useCacheSettingsStore((s) => s.previewCacheMode);
  const setMetadataCacheMode = useCacheSettingsStore(
    (s) => s.setMetadataCacheMode,
  );
  const setPreviewCacheMode = useCacheSettingsStore(
    (s) => s.setPreviewCacheMode,
  );
  const [activeSection, setActiveSection] =
    useState<SettingsSectionId>("security");
  const [clearing, setClearing] = useState<"persistent" | "preview" | null>(
    null,
  );
  const [applyingNameSetting, setApplyingNameSetting] = useState(false);
  const rootFolderName = useVaultStore((s) => s.rootFolderName);
  const renameRootFolder = useVaultStore((s) => s.renameRootFolder);
  const [editingFolderName, setEditingFolderName] = useState("");
  const [renamingFolder, setRenamingFolder] = useState(false);

  useEffect(() => {
    if (rootFolderName) setEditingFolderName(rootFolderName);
  }, [rootFolderName]);

  // PWA install prompt
  const [pwaPrompt, setPwaPrompt] = useState<BeforeInstallPromptEvent | null>(
    window.__pwaInstallPrompt ?? null,
  );
  const [pwaInstalled, setPwaInstalled] = useState(
    window.matchMedia("(display-mode: standalone)").matches,
  );
  useEffect(() => {
    const handler = () => setPwaPrompt(window.__pwaInstallPrompt ?? null);
    window.addEventListener("pwa-prompt-available", handler);
    return () => window.removeEventListener("pwa-prompt-available", handler);
  }, []);
  const handlePwaInstall = async () => {
    if (!pwaPrompt) return;
    pwaPrompt.prompt();
    const result = await pwaPrompt.userChoice;
    if (result.outcome === "accepted") {
      setPwaInstalled(true);
    }
    window.__pwaInstallPrompt = null;
    setPwaPrompt(null);
  };

  const sections = useMemo<SettingsSection[]>(
    () => [
      {
        id: "security",
        label: "セキュリティ",
        description: "暗号化とパスフレーズ",
      },
      {
        id: "performance",
        label: "パフォーマンス",
        description: "転送・並列処理・キャッシュ",
      },
      {
        id: "display",
        label: "外観",
        description: "テーマと表示設定",
      },
      {
        id: "app",
        label: "アプリ",
        description: "認証とインストール",
      },
      {
        id: "project",
        label: "プロジェクト情報",
        description: "開発者・ライセンス",
      },
    ],
    [],
  );

  useEffect(() => {
    const htmlEl = document.documentElement;
    const previousOverflow = htmlEl.style.overflow;
    htmlEl.style.overflow = "hidden";

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      htmlEl.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  const handleMetadataModeChange = async (mode: CacheMetadataMode) => {
    setMetadataCacheMode(mode);
    syncSettingToMeta({ metadataCacheMode: mode });
    if (mode === "off") {
      setClearing("persistent");
      try {
        await clearAllFiles();
      } finally {
        setClearing(null);
      }
    }
  };

  const handlePreviewModeChange = (mode: PreviewCacheMode) => {
    setPreviewCacheMode(mode);
    syncSettingToMeta({ previewCacheMode: mode });
    if (mode === "off") {
      clearPreviewCache();
    }
  };

  const handleClearPersistentCache = async () => {
    setClearing("persistent");
    try {
      await clearAllFiles();
    } finally {
      setClearing(null);
    }
  };

  const handleClearPreviewCache = () => {
    setClearing("preview");
    clearPreviewCache();
    setClearing(null);
  };

  const handleApplyNameSetting = async () => {
    setApplyingNameSetting(true);
    try {
      await applyNameEncryptionToAll(defaultEncryptName);
    } finally {
      setApplyingNameSetting(false);
    }
  };

  const handleRenameRootFolder = async () => {
    const trimmed = sanitizeTextInput(editingFolderName);
    if (!trimmed || trimmed === rootFolderName) return;
    const err = validateDriveFolderName(trimmed);
    if (err) {
      useUIStore.getState().addToast({ message: err, type: "error" });
      return;
    }
    setEditingFolderName(trimmed);
    setRenamingFolder(true);
    try {
      await renameRootFolder(trimmed);
      useUIStore
        .getState()
        .addToast({ message: "フォルダ名を変更しました", type: "success" });
    } catch (e) {
      useUIStore.getState().addToast({
        message:
          e instanceof Error ? e.message : "フォルダ名の変更に失敗しました",
        type: "error",
      });
    } finally {
      setRenamingFolder(false);
    }
  };
  const renderSectionContent = () => {
    if (activeSection === "security") {
      return (
        <div className="space-y-5">
          <SectionCard
            title="ファイル名の暗号化"
            description="新規アップロードや新規フォルダ作成時の標準動作です。必要に応じて既存アイテムへもまとめて反映できます。"
          >
            <ToggleRow
              title="ファイル名・フォルダ名を暗号化"
              description="有効にすると、Google Drive 上の実ファイル名も暗号化されます。"
              checked={defaultEncryptName}
              onToggle={() => {
                const next = !defaultEncryptName;
                setDefaultEncryptName(next);
                syncSettingToMeta({ encryptName: next });
              }}
            />

            <div className="rounded-xl border border-gray-200 bg-white px-4 py-4 dark:border-gray-700 dark:bg-gray-800">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                既存のファイルとフォルダへ適用
              </p>
              <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                data
                配下の既存アイテムにも、現在のファイル名暗号化設定を反映します。
              </p>
              <button
                type="button"
                onClick={() => void handleApplyNameSetting()}
                disabled={applyingNameSetting}
                className="mt-4 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {applyingNameSetting
                  ? "適用中..."
                  : "現在の設定を既存のファイルとフォルダへ適用"}
              </button>
            </div>
          </SectionCard>

          <SectionCard
            title="パスフレーズ操作"
            description="必要に応じて、現在のパスフレーズを別のものへ変更できます。"
          >
            <button
              type="button"
              onClick={openPasswordChange}
              className="flex w-full items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-4 text-left transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
            >
              <span>
                <span className="block text-sm font-medium text-gray-800 dark:text-gray-200">
                  パスフレーズを変更
                </span>
                <span className="mt-1 block text-sm text-gray-500 dark:text-gray-400">
                  既存ファイルの鍵情報も順次更新します。
                </span>
              </span>
              <SettingsIcon
                title="開く"
                className="h-5 w-5 text-gray-400 dark:text-gray-500"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </SettingsIcon>
            </button>
          </SectionCard>

          <SectionCard
            title="Google Drive フォルダ名"
            description="Google Drive 上のルートフォルダの表示名を変更できます。暗号化やデータには影響しません。"
          >
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={editingFolderName}
                onChange={(e) => setEditingFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleRenameRootFolder();
                }}
                disabled={renamingFolder}
                maxLength={200}
                className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 transition focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:focus:border-blue-400 dark:focus:ring-blue-400"
                placeholder="フォルダ名"
              />
              <button
                type="button"
                onClick={() => void handleRenameRootFolder()}
                disabled={
                  renamingFolder || editingFolderName.trim() === rootFolderName
                }
                className="shrink-0 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {renamingFolder ? "変更中..." : "変更"}
              </button>
            </div>
          </SectionCard>
        </div>
      );
    }

    if (activeSection === "performance") {
      const hwCores =
        typeof navigator !== "undefined"
          ? (navigator.hardwareConcurrency ?? 4)
          : 4;
      const parallelOptions: { value: ParallelFileCount; label: string }[] = [
        { value: "auto", label: `自動（${hwCores} コア検出）` },
        { value: 1, label: "1（順次処理）" },
        { value: 2, label: "2" },
        { value: 4, label: "4" },
        { value: 6, label: "6" },
        { value: 8, label: "8" },
        { value: 12, label: "12" },
        { value: 16, label: "16" },
        { value: 20, label: "20" },
      ];

      return (
        <div className="space-y-5">
          <SectionCard
            title="並列処理数"
            description="同時に暗号化・アップロード・ダウンロードするファイル数の上限です。コア数の多い端末では大きい値が有効です。"
          >
            <div>
              <select
                value={String(parallelFileCount)}
                onChange={(e) => {
                  const v = e.target.value;
                  setParallelFileCount(
                    v === "auto" ? "auto" : (Number(v) as ParallelFileCount),
                  );
                }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300"
              >
                {parallelOptions.map((opt) => (
                  <option key={String(opt.value)} value={String(opt.value)}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                「自動」ではハードウェアのコア数に応じて最適な値を選択します。低スペック端末や回線が不安定な場合は数値を小さくしてください。
              </p>
            </div>
          </SectionCard>

          <SectionCard
            title="大量ファイルのアップロード"
            description="フォルダに100件以上のファイルが含まれる場合の動作を設定します。"
          >
            <div>
              <select
                value={bulkUploadBehavior}
                onChange={(e) =>
                  setBulkUploadBehavior(e.target.value as BulkUploadBehavior)
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300"
              >
                <option value="ask">毎回対応を聞く</option>
                <option value="direct">そのままアップロード</option>
                <option value="zip">ZIPにしてからアップロード</option>
              </select>
            </div>
          </SectionCard>

          <SectionCard
            title="キャッシュ管理"
            description="一覧キャッシュは保存時に暗号化されます。必要に応じて無効化や即時削除ができます。"
          >
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                メタデータキャッシュ
              </label>
              <select
                value={metadataCacheMode}
                onChange={(e) =>
                  void handleMetadataModeChange(
                    e.target.value as CacheMetadataMode,
                  )
                }
                className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300"
              >
                <option value="off">無効</option>
                <option value="session">セッション（タブを閉じるまで）</option>
                <option value="24h">24時間</option>
                <option value="7d">7日間</option>
                <option value="unlimited">無制限</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
                プレビューキャッシュ
              </label>
              <select
                value={previewCacheMode}
                onChange={(e) =>
                  handlePreviewModeChange(e.target.value as PreviewCacheMode)
                }
                className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300"
              >
                <option value="memory">有効（メモリのみ）</option>
                <option value="off">無効</option>
              </select>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => void handleClearPersistentCache()}
                disabled={clearing !== null}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {clearing === "persistent"
                  ? "削除中..."
                  : "一覧キャッシュを削除"}
              </button>
              <button
                type="button"
                onClick={handleClearPreviewCache}
                disabled={clearing !== null}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {clearing === "preview"
                  ? "削除中..."
                  : "プレビューキャッシュを削除"}
              </button>
            </div>
          </SectionCard>
        </div>
      );
    }

    if (activeSection === "display") {
      const themeOptions: {
        value: ThemeMode;
        title: string;
        description: string;
      }[] = [
        {
          value: "system",
          title: "システム設定に従う",
          description: "OS のダークモード設定を自動的に反映します。",
        },
        {
          value: "light",
          title: "ライト",
          description: "常に明るい配色で表示します。",
        },
        {
          value: "dark",
          title: "ダーク",
          description: "常に暗い配色で表示します。",
        },
      ];

      const iconOptions: {
        value: UserIconDisplay;
        title: string;
        description: string;
      }[] = [
        {
          value: "icon",
          title: "アイコンのみ",
          description: "プロフィール画像またはイニシャルだけを表示します。",
        },
        {
          value: "name-icon",
          title: "名前 + アイコン",
          description: "アカウント名とアイコンを並べて表示します。",
        },
        {
          value: "name-email-icon",
          title: "名前 + メール + アイコン",
          description:
            "アカウント名、メールアドレス、アイコンをすべて表示します。",
        },
        {
          value: "none",
          title: "非表示",
          description:
            "ユーザー情報を表示しません。設定メニューのみ利用できます。",
        },
      ];

      return (
        <div className="space-y-5">
          <SectionCard
            title="テーマ"
            description="アプリケーション全体の配色を選択します。"
          >
            {themeOptions.map((opt) => (
              <RadioCard
                key={opt.value}
                title={opt.title}
                description={opt.description}
                checked={themeMode === opt.value}
                onSelect={() => setThemeMode(opt.value)}
              />
            ))}
          </SectionCard>

          <SectionCard
            title="ユーザーアイコン表示"
            description="ヘッダーに表示するユーザー情報の範囲を選択します。"
          >
            {iconOptions.map((opt) => (
              <RadioCard
                key={opt.value}
                title={opt.title}
                description={opt.description}
                checked={userIconDisplay === opt.value}
                onSelect={() => setUserIconDisplay(opt.value)}
              />
            ))}
          </SectionCard>
        </div>
      );
    }

    if (activeSection === "app") {
      return (
        <div className="space-y-5">
          <SectionCard
            title="自動ログイン"
            description="ページを開いたときの認証動作を設定します。"
          >
            <ToggleRow
              title="自動ポップアップログイン"
              description="有効にすると、ページを開いた際に Google のサイレント認証を自動で試みます。無効の場合はログインボタンを手動で押す必要があります。"
              checked={autoPopupLogin}
              onToggle={() => {
                const next = !autoPopupLogin;
                setAutoPopupLogin(next);
                syncSettingToMeta({ autoPopupLogin: next });
              }}
            />
          </SectionCard>

          <SectionCard
            title="アプリのインストール"
            description="ブラウザからアプリとしてインストールできます。"
          >
            <div className="flex items-start justify-between gap-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-4 dark:border-gray-700 dark:bg-gray-900">
              <div>
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                  PWA インストール
                </p>
                <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                  {pwaInstalled
                    ? "このアプリは既にインストールされています。"
                    : pwaPrompt
                      ? "kakusu をアプリとしてインストールし、スタンドアロンウィンドウで利用できます。"
                      : "お使いのブラウザではアプリのインストールに対応していないか、既にインストール済みです。"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handlePwaInstall()}
                disabled={!pwaPrompt || pwaInstalled}
                className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {pwaInstalled ? "インストール済み" : "インストール"}
              </button>
            </div>
          </SectionCard>
        </div>
      );
    }

    return (
      <div className="space-y-5">
        <SectionCard
          title="プロジェクト概要"
          description="kakusu の公開情報と開発メタデータです。"
        >
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-4 text-sm leading-relaxed text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
            <p className="font-medium text-gray-800 dark:text-gray-200">
              kakusu v1.0.0
            </p>
            <p className="mt-2">
              クライアントサイドで暗号化するGoogle Driveクライアント
            </p>
          </div>
        </SectionCard>

        <SectionCard
          title="開発者情報"
          description="公開先とメンテナ情報を確認できます。"
        >
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
            <div className="flex items-start justify-between gap-4 border-b border-gray-100 pb-3 dark:border-gray-700">
              <span className="font-medium text-gray-500 dark:text-gray-400">
                aftn
              </span>
              <a
                href="https://aftn.jp"
                target="_blank"
                rel="noreferrer"
                className="text-right text-blue-600 hover:underline dark:text-blue-400"
              >
                aftn.jp
              </a>
            </div>
            <div className="flex items-start justify-between gap-4 pt-3">
              <span className="font-medium text-gray-500 dark:text-gray-400">
                GitHub
              </span>
              <a
                href="https://github.com/aftn/"
                target="_blank"
                rel="noreferrer"
                className="text-right text-blue-600 hover:underline dark:text-blue-400"
              >
                github.com/aftn
              </a>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="プロジェクトリンク"
          description="ソースコードと公開ライセンスを参照できます。"
        >
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
              GitHub
            </p>
            <a
              href={projectGithubUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              <SettingsIcon title="GitHub" className="h-4 w-4">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 2a10 10 0 00-3.162 19.488c.5.092.684-.217.684-.48 0-.237-.009-.866-.014-1.7-2.782.604-3.37-1.34-3.37-1.34-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.07-.607.07-.607 1.004.07 1.532 1.032 1.532 1.032.893 1.53 2.341 1.088 2.91.832.091-.647.35-1.088.636-1.338-2.221-.253-4.556-1.111-4.556-4.944 0-1.092.39-1.985 1.03-2.684-.104-.253-.446-1.272.098-2.651 0 0 .84-.269 2.75 1.025A9.565 9.565 0 0112 6.845a9.56 9.56 0 012.504.337c1.909-1.294 2.748-1.025 2.748-1.025.546 1.379.203 2.398.1 2.651.64.699 1.028 1.592 1.028 2.684 0 3.842-2.339 4.688-4.566 4.937.359.309.679.919.679 1.852 0 1.337-.012 2.416-.012 2.744 0 .266.18.576.688.478A10 10 0 0012 2z"
                />
              </SettingsIcon>
              GitHub リポジトリを開く
            </a>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white px-4 py-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
              ライセンス
            </p>
            <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              kakusu は GNU Affero General Public License v3.0
              を採用しています。
            </p>
            <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              第三者ライセンスと著作権表示は、ビルド時に package.json と
              node_modules から自動生成した一覧を同梱しています。
            </p>
            <a
              href="https://www.gnu.org/licenses/agpl-3.0.html"
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              AGPL-3.0 を確認
            </a>
            <a
              href="/oss-licenses.txt"
              target="_blank"
              rel="noreferrer"
              className="mt-3 ml-3 inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              第三者ライセンス一覧を開く
            </a>
          </div>

          {(PRIVACY_POLICY_URL || TERMS_OF_SERVICE_URL) && (
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-4 dark:border-gray-700 dark:bg-gray-800">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                規約とポリシー
              </p>
              <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                Google ユーザーデータの取扱いと KaKuSu
                の利用条件を公開サイトで確認できます。
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {PRIVACY_POLICY_URL && (
                  <a
                    href={PRIVACY_POLICY_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    プライバシーポリシー
                  </a>
                )}
                {TERMS_OF_SERVICE_URL && (
                  <a
                    href={TERMS_OF_SERVICE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    利用規約
                  </a>
                )}
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-50 dark:bg-gray-900">
      <div className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 backdrop-blur dark:border-gray-700 dark:bg-gray-900/95">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4 sm:px-6">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label="設定を閉じる"
          >
            <SettingsIcon title="戻る" className="h-5 w-5">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </SettingsIcon>
          </button>
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              設定
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              セキュリティと操作性を、この端末向けに調整します。
            </p>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8">
          <aside className="mb-6 lg:mb-0">
            <div className="flex gap-2 overflow-x-auto pb-1 lg:sticky lg:top-24 lg:flex-col lg:overflow-visible lg:pb-0">
              {sections.map((section) => {
                const active = section.id === activeSection;
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => setActiveSection(section.id)}
                    className={`min-w-fit rounded-xl px-4 py-3 text-left transition lg:w-full ${
                      active
                        ? "bg-blue-600 text-white shadow-sm"
                        : "bg-white text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                    }`}
                  >
                    <span className="block text-sm font-medium">
                      {section.label}
                    </span>
                    <span
                      className={`mt-1 block text-xs ${
                        active
                          ? "text-blue-100"
                          : "text-gray-500 dark:text-gray-400"
                      }`}
                    >
                      {section.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div>
            <div className="mb-4">
              <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                {
                  sections.find((section) => section.id === activeSection)
                    ?.label
                }
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {
                  sections.find((section) => section.id === activeSection)
                    ?.description
                }
              </p>
            </div>

            {renderSectionContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
