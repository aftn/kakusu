/**
 * Write text to the system clipboard with fallback.
 * Uses the Clipboard API when available, falls back to
 * a temporary textarea + execCommand('copy').
 */
export async function writeClipboardText(
  textOrPromise: string | Promise<string>,
): Promise<void> {
  const isPromise = typeof textOrPromise !== "string";

  // Safari and modern Chrome support ClipboardItem with Promises
  if (
    isPromise &&
    typeof window.ClipboardItem !== "undefined" &&
    navigator.clipboard?.write
  ) {
    try {
      const promiseBlob = textOrPromise.then(
        (text) => new Blob([text], { type: "text/plain" }),
      );
      await navigator.clipboard.write([
        new window.ClipboardItem({ "text/plain": promiseBlob }),
      ]);
      return;
    } catch (e) {
      console.warn("Clipboard API (ClipboardItem promise) failed:", e);
      // Fall through to try writeText as fallback
    }
  }

  const text = await Promise.resolve(textOrPromise);

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Clipboard API failed (e.g., permission denied) — fall through to fallback
    }
  }

  // Fallback: create a temporary textarea and use execCommand
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // Move off-screen
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}
