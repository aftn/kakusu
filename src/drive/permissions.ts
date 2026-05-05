import type { DrivePermission } from "@/types";
import * as api from "./api";
import { validateEmails } from "./validation";

export async function shareWithAnyone(
  fileId: string,
  expirationTime?: string,
): Promise<DrivePermission> {
  const permission: Partial<DrivePermission> = {
    role: "reader",
    type: "anyone",
  };
  if (expirationTime) {
    permission.expirationTime = expirationTime;
  }
  return api.createPermission(fileId, permission);
}

export async function shareWithUser(
  fileId: string,
  email: string,
  expirationTime?: string,
): Promise<DrivePermission> {
  const permission: Partial<DrivePermission> = {
    role: "reader",
    type: "user",
    emailAddress: email,
  };
  if (expirationTime) {
    permission.expirationTime = expirationTime;
  }
  return api.createPermission(fileId, permission);
}

/**
 * Share a file with multiple users (comma-separated emails).
 * Runs in parallel for speed.
 */
export async function shareWithUsers(
  fileId: string,
  emails: string[],
  expirationTime?: string,
): Promise<void> {
  const { valid, invalid } = validateEmails(emails.join(","));
  if (invalid.length > 0) {
    throw new Error(`Invalid email addresses: ${invalid.join(", ")}`);
  }
  await Promise.all(
    valid.map((email) => shareWithUser(fileId, email, expirationTime)),
  );
}

/**
 * Revoke all non-owner permissions on a single file.
 * Returns the count of revoked permissions.
 */
export async function revokeAllNonOwnerPermissions(
  fileId: string,
): Promise<number> {
  const perms = await getPermissions(fileId);
  const toRevoke = perms.filter((p) => p.role !== "owner");
  await Promise.all(toRevoke.map((p) => revokePermission(fileId, p.id)));
  return toRevoke.length;
}

/**
 * Revoke all non-owner permissions on multiple files with bounded concurrency.
 */
export async function revokePermissionsBatch(
  fileIds: string[],
  concurrency = 8,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let done = 0;
  const total = fileIds.length;
  const executing = new Set<Promise<void>>();

  for (const fileId of fileIds) {
    const p = (async () => {
      try {
        await revokeAllNonOwnerPermissions(fileId);
      } catch {
        // File may be deleted or inaccessible — skip
      }
      done++;
      onProgress?.(done, total);
    })().then(() => {
      executing.delete(p);
    });
    executing.add(p);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

export async function revokePermission(
  fileId: string,
  permissionId: string,
): Promise<void> {
  return api.deletePermission(fileId, permissionId);
}

export async function getPermissions(
  fileId: string,
): Promise<DrivePermission[]> {
  return api.listPermissions(fileId);
}
