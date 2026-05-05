import { useUIStore } from "@/stores/uiStore";
import { useEffect, useRef, useState } from "react";

export default function ConfirmDialog() {
  const confirmDialog = useUIStore((s) => s.confirmDialog);
  const closeConfirmDialog = useUIStore((s) => s.closeConfirmDialog);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (confirmDialog) {
      confirmRef.current?.focus();
      setChecked(false);
    }
  }, [confirmDialog]);

  useEffect(() => {
    if (!confirmDialog) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeConfirmDialog();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [confirmDialog, closeConfirmDialog]);

  if (!confirmDialog) return null;

  const isInfo = confirmDialog.variant === "info";

  const handleConfirm = () => {
    if (confirmDialog.onConfirmWithCheckbox) {
      confirmDialog.onConfirmWithCheckbox(checked);
    } else {
      confirmDialog.onConfirm();
    }
    closeConfirmDialog();
  };

  const handleSecondary = () => {
    if (confirmDialog.onSecondaryWithCheckbox) {
      confirmDialog.onSecondaryWithCheckbox(checked);
    } else {
      confirmDialog.onSecondary?.();
    }
    closeConfirmDialog();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <button
        type="button"
        aria-label="確認ダイアログを閉じる"
        onClick={closeConfirmDialog}
        className="absolute inset-0 bg-black/40 animate-in fade-in duration-150"
      />
      <div className="relative z-10 mx-4 w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl animate-in zoom-in-95 duration-150 dark:bg-gray-800">
        <p className="text-sm leading-relaxed text-gray-700 whitespace-pre-line dark:text-gray-300">
          {confirmDialog.message}
        </p>
        {confirmDialog.checkboxLabel && (
          <label className="mt-4 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600"
            />
            {confirmDialog.checkboxLabel}
          </label>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={closeConfirmDialog}
            className="rounded-lg px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          >
            キャンセル
          </button>
          {(confirmDialog.onSecondary ||
            confirmDialog.onSecondaryWithCheckbox) &&
            confirmDialog.secondaryLabel && (
              <button
                type="button"
                onClick={handleSecondary}
                className={
                  isInfo
                    ? "rounded-lg border border-blue-300 px-4 py-2 text-sm font-medium text-blue-600 transition hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-blue-700 dark:text-blue-400 dark:hover:bg-blue-900/20"
                    : "rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
                }
              >
                {confirmDialog.secondaryLabel}
              </button>
            )}
          <button
            type="button"
            ref={confirmRef}
            onClick={handleConfirm}
            className={
              isInfo
                ? "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                : "rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
            }
          >
            {confirmDialog.confirmLabel ?? "確認"}
          </button>
        </div>
      </div>
    </div>
  );
}
