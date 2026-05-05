import { CryptoError } from "@/utils/errors";

const DRIVE_APP_PROPERTY_PAIR_LIMIT = 124;
const MAX_SEGMENTED_APP_PROPERTY_PARTS = 10;

function getSegmentedAppPropertyKey(baseKey: string, index: number): string {
  return index === 0 ? baseKey : `${baseKey}_${index + 1}`;
}

export function splitAppPropertyValue(
  baseKey: string,
  value: string,
  maxParts: number = MAX_SEGMENTED_APP_PROPERTY_PARTS,
): string[] {
  if (!value) {
    return [""];
  }

  const parts: string[] = [];
  let remaining = value;

  while (remaining.length > 0) {
    const key = getSegmentedAppPropertyKey(baseKey, parts.length);
    const maxValueLength = DRIVE_APP_PROPERTY_PAIR_LIMIT - key.length;
    if (maxValueLength <= 0) {
      throw new CryptoError(`Drive appProperty key is too long: ${key}`);
    }

    parts.push(remaining.slice(0, maxValueLength));
    remaining = remaining.slice(maxValueLength);

    if (parts.length >= maxParts && remaining.length > 0) {
      throw new CryptoError(
        "ファイル名が長すぎて Drive appProperties に保存できません",
      );
    }
  }

  return parts;
}

export function writeSegmentedAppProperty(
  target: Record<string, string>,
  baseKey: string,
  value: string,
  maxParts?: number,
): void {
  const parts = splitAppPropertyValue(baseKey, value, maxParts);
  for (let i = 0; i < parts.length; i++) {
    target[getSegmentedAppPropertyKey(baseKey, i)] = parts[i]!;
  }
}

export function clearSegmentedAppProperty(
  target: Record<string, string | null>,
  baseKey: string,
  maxParts: number = MAX_SEGMENTED_APP_PROPERTY_PARTS,
): void {
  for (let i = 0; i < maxParts; i++) {
    target[getSegmentedAppPropertyKey(baseKey, i)] = null;
  }
}

export function readSegmentedAppProperty(
  source: Record<string, string> | undefined,
  baseKey: string,
  maxParts: number = MAX_SEGMENTED_APP_PROPERTY_PARTS,
): string | undefined {
  if (!source) {
    return undefined;
  }

  const first = source[baseKey];
  if (!first) {
    return undefined;
  }

  let value = first;
  for (let i = 1; i < maxParts; i++) {
    const next = source[getSegmentedAppPropertyKey(baseKey, i)];
    if (next === undefined) {
      break;
    }
    value += next;
  }

  return value;
}
