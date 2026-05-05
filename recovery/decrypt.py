#!/usr/bin/env python3
"""
Kakusu Offline Recovery Script
================================
Decrypt files downloaded manually from Google Drive.

Prerequisites:
- Python 3.9+
- cryptography package (auto-installed by recover.bat)

Directory layout:
  decrypt.py
    <downloaded-vault-root>/
      data/              (entire data folder from Drive)
      DO_NOT_DELETE.json  (metadata file from Drive root)
  rawdata/
      data/              (decrypted output appears here)

Usage:
  python decrypt.py                          # interactive mode
  python decrypt.py kakusu/ -o rawdata/      # explicit paths
  python decrypt.py file.enc                 # single file
  python decrypt.py folder1/ folder2/        # multiple folders
  python decrypt.py -p "passphrase"          # non-interactive
"""

import argparse
import base64
import getpass
import hashlib
import json
import os
import struct
import sys
import traceback
from pathlib import Path

AESGCM = None
aes_key_unwrap = None
HKDF = None
hashes = None


# -- Constants (must match TypeScript implementation) --
PBKDF2_ITERATIONS = 600_000
CHUNK_VERSION_1 = 0x01
CHUNK_VERSION_2 = 0x02
GCM_TAG_SIZE = 16
V1_HEADER_SIZE = 13  # 1B version + 4B chunk_size + 8B base_iv
META_FILE_NAME = "DO_NOT_DELETE.json"

REQUIRED_META_KEYS = ("salt", "verify_ciphertext", "verify_iv")


def ensure_crypto_available() -> None:
    """Import cryptography lazily so --help can work before dependencies are installed."""
    global AESGCM, aes_key_unwrap, HKDF, hashes

    if AESGCM is not None:
        return

    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM as _AESGCM
        from cryptography.hazmat.primitives.keywrap import aes_key_unwrap as _aes_key_unwrap
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF as _HKDF
        from cryptography.hazmat.primitives import hashes as _hashes
    except ImportError:
        print("エラー: 'cryptography' パッケージが見つかりません。")
        print("インストール方法: pip install cryptography")
        sys.exit(1)

    AESGCM = _AESGCM
    aes_key_unwrap = _aes_key_unwrap
    HKDF = _HKDF
    hashes = _hashes


def base64url_decode(s: str) -> bytes:
    """Decode base64url (no padding) to bytes."""
    s = s.replace("-", "+").replace("_", "/")
    padding = 4 - len(s) % 4
    if padding != 4:
        s += "=" * padding
    return base64.b64decode(s)


def base64url_encode(b: bytes) -> str:
    """Encode bytes to base64url (no padding)."""
    return base64.b64encode(b).decode("ascii").rstrip("=").replace("+", "-").replace("/", "_")


def derive_meks(passphrase: str, salt: bytes) -> tuple:
    """Derive MEK_enc and MEK_wrap from passphrase via PBKDF2 + HKDF."""
    ensure_crypto_available()
    ikm = hashlib.pbkdf2_hmac(
        "sha256",
        passphrase.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
        dklen=32,
    )

    mek_enc = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=b"veld-meta-encryption",
    ).derive(ikm)

    mek_wrap = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=b"veld-key-wrapping",
    ).derive(ikm)

    return mek_enc, mek_wrap


def verify_passphrase(mek_enc: bytes, ciphertext: bytes, iv: bytes) -> bool:
    """Verify passphrase by decrypting the verify data (should be 'veld-ok')."""
    ensure_crypto_available()
    try:
        aesgcm = AESGCM(mek_enc)
        plaintext = aesgcm.decrypt(iv, ciphertext, None)
        return plaintext == b"veld-ok"
    except Exception:
        return False


def unwrap_key(mek_wrap: bytes, wrapped_key: bytes) -> bytes:
    """Unwrap an AES-KW wrapped key."""
    ensure_crypto_available()
    return aes_key_unwrap(mek_wrap, wrapped_key)


def decrypt_name_from_bytes(key: bytes, iv_meta: bytes, enc_name: bytes) -> str:
    """Decrypt an encrypted name using AES-GCM."""
    ensure_crypto_available()
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(iv_meta, enc_name, None)
    return plaintext.decode("utf-8")


DRIVE_NAME_IV_PART_LENGTH = 16


def parse_encrypted_drive_name(name: str):
    """
    Parse an IV-prefixed encrypted Drive name.
    Format: [16-char base64 IV]_[base64 ciphertext][.enc]
    Returns (iv_bytes, enc_bytes) or None.
    """
    if name.endswith(".enc"):
        name = name[:-4]

    if len(name) > DRIVE_NAME_IV_PART_LENGTH and name[DRIVE_NAME_IV_PART_LENGTH] == "_":
        iv_part = name[:DRIVE_NAME_IV_PART_LENGTH]
        enc_part = name[DRIVE_NAME_IV_PART_LENGTH + 1:]
    else:
        sep_idx = name.find("_")
        if sep_idx < 1:
            return None
        iv_part = name[:sep_idx]
        enc_part = name[sep_idx + 1:]

    if not iv_part or not enc_part:
        return None

    try:
        iv_bytes = base64url_decode(iv_part)
        enc_bytes = base64url_decode(enc_part)
        if len(iv_bytes) != 12 or not enc_bytes:
            return None
        return iv_bytes, enc_bytes
    except Exception:
        return None


def try_decrypt_name(key: bytes, drive_name: str) -> str | None:
    """Try to decrypt a Drive filename. Returns original name or None."""
    parsed = parse_encrypted_drive_name(drive_name)
    if parsed is None:
        return None
    iv_meta, enc_name_bytes = parsed
    try:
        return decrypt_name_from_bytes(key, iv_meta, enc_name_bytes)
    except Exception:
        return None


def decrypt_name_with_fallback(name_keys: list[bytes], drive_name: str) -> str | None:
    """Try decrypting a name with multiple keys (NameKey, then MEK_enc fallback)."""
    for key in name_keys:
        result = try_decrypt_name(key, drive_name)
        if result is not None:
            return result
    return None


def parse_file_header(data: bytes):
    """Parse encrypted file header. Returns (version, chunk_size, base_iv, wrapped_cek, data_offset)."""
    if len(data) < V1_HEADER_SIZE:
        raise ValueError("ファイルが短すぎてヘッダーを読み取れません")

    version = data[0]
    chunk_size = struct.unpack(">I", data[1:5])[0]
    base_iv = data[5:13]

    if version == CHUNK_VERSION_2:
        if len(data) < V1_HEADER_SIZE + 1:
            raise ValueError("v2 ヘッダーが短すぎます")
        wcek_len = data[13]
        if len(data) < V1_HEADER_SIZE + 1 + wcek_len:
            raise ValueError("v2 wrapped CEK が不完全です")
        wrapped_cek = data[14:14 + wcek_len]
        data_offset = V1_HEADER_SIZE + 1 + wcek_len
        return version, chunk_size, base_iv, wrapped_cek, data_offset
    elif version == CHUNK_VERSION_1:
        return version, chunk_size, base_iv, None, V1_HEADER_SIZE
    else:
        raise ValueError(f"未知のファイルバージョンです: {version}")


def build_chunk_iv(base_iv: bytes, chunk_index: int) -> bytes:
    """Build 12-byte chunk IV from base_iv (8B) + chunk_index (4B big-endian)."""
    return base_iv[:8] + struct.pack(">I", chunk_index)


def decrypt_file_content(cek: bytes, data: bytes) -> bytes:
    """Decrypt an encrypted file (header + chunks) using the CEK."""
    ensure_crypto_available()
    version, chunk_size, base_iv, _, data_offset = parse_file_header(data)

    encrypted_data = data[data_offset:]
    enc_chunk_size = chunk_size + GCM_TAG_SIZE
    total_chunks = max(1, (len(encrypted_data) + enc_chunk_size - 1) // enc_chunk_size)

    aesgcm = AESGCM(cek)
    decrypted_parts = []

    for i in range(total_chunks):
        start = i * enc_chunk_size
        end = min(start + enc_chunk_size, len(encrypted_data))
        chunk = encrypted_data[start:end]
        iv = build_chunk_iv(base_iv, i)
        plaintext = aesgcm.decrypt(iv, chunk, None)
        decrypted_parts.append(plaintext)

    return b"".join(decrypted_parts)


def find_meta_file(search_dir: Path) -> Path | None:
    """Search for DO_NOT_DELETE.json (or legacy DO_NOT_DELETE) in a directory."""
    path = search_dir / META_FILE_NAME
    if path.is_file():
        return path
    return None


def find_vault_dirs(base_dir: Path) -> list[Path]:
    """Find candidate downloaded vault root directories placed next to the script."""
    candidates: list[Path] = []
    try:
        children = sorted(base_dir.iterdir())
    except OSError:
        return candidates

    for child in children:
        if not child.is_dir() or child.name in {".venv", "rawdata", "__pycache__"}:
            continue
        meta_path = find_meta_file(child)
        if meta_path is None:
            continue
        try:
            has_payload = any(item.name != META_FILE_NAME for item in child.iterdir())
        except OSError:
            has_payload = False
        if has_payload:
            candidates.append(child)

    return candidates


def load_meta_file(meta_path: Path) -> dict:
    """Load and parse the DO_NOT_DELETE metadata JSON file."""
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            content = f.read()
    except OSError as e:
        raise ValueError(f"メタデータファイル '{meta_path}' の読み込みに失敗しました: {e}")

    try:
        meta = json.loads(content)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"メタデータファイル '{meta_path.name}' の JSON 形式が正しくありません: {e}"
        )

    if not isinstance(meta, dict):
        raise ValueError(f"メタデータファイル '{meta_path.name}' の内容がオブジェクト形式ではありません。")

    missing = [k for k in REQUIRED_META_KEYS if k not in meta]
    if missing:
        raise ValueError(
            f"メタデータファイル '{meta_path.name}' に必須項目が見つかりません: {', '.join(missing)}"
        )

    return meta


def derive_keys(meta: dict, passphrase: str):
    """Derive all encryption keys from metadata and passphrase."""
    try:
        salt = base64url_decode(meta["salt"])
    except Exception as e:
        raise ValueError(f"メタデータの salt のデコードに失敗しました: {e}")

    print("[1/4] パスフレーズからキーを導出しています...")
    try:
        mek_enc, mek_wrap = derive_meks(passphrase, salt)
    except Exception as e:
        raise ValueError(f"キーの導出に失敗しました: {e}")

    print("[2/4] パスフレーズを検証しています...")
    try:
        verify_ct = base64url_decode(meta["verify_ciphertext"])
        verify_iv = base64url_decode(meta["verify_iv"])
    except Exception as e:
        raise ValueError(f"検証データのデコードに失敗しました: {e}")

    if not verify_passphrase(mek_enc, verify_ct, verify_iv):
        print("  x パスフレーズが正しくありません！")
        sys.exit(1)
    print("  OK - パスフレーズを確認しました。")

    print("[3/4] 暗号化キーを展開しています...")
    vault_key = None
    name_key = None
    if meta.get("wrapped_vault_key"):
        try:
            vault_key = unwrap_key(mek_wrap, base64url_decode(meta["wrapped_vault_key"]))
        except Exception as e:
            print(f"  警告: Vault Key の展開に失敗しました: {e}")
    if meta.get("wrapped_name_key"):
        try:
            name_key = unwrap_key(mek_wrap, base64url_decode(meta["wrapped_name_key"]))
        except Exception as e:
            print(f"  警告: Name Key の展開に失敗しました: {e}")

    # Collect candidate keys for name decryption.
    # Newer files use NameKey; older files fall back to MEK_enc.
    name_keys = []
    if name_key:
        name_keys.append(name_key)
    if mek_enc not in name_keys:
        name_keys.append(mek_enc)

    unwrap_key_for_ceks = vault_key or mek_wrap

    return name_keys, unwrap_key_for_ceks


def decrypt_single_file(
    enc_file: Path,
    output_path: Path,
    name_keys: list[bytes],
    unwrap_key_for_ceks: bytes,
) -> bool:
    """Decrypt a single .enc file. Returns True on success."""
    try:
        original_name = decrypt_name_with_fallback(name_keys, enc_file.name)
    except Exception as e:
        print(f"  ERR {enc_file.name}: ファイル名の復号に失敗しました: {e}")
        return False

    try:
        file_data = enc_file.read_bytes()
    except OSError as e:
        print(f"  ERR {enc_file.name}: ファイルの読み込みに失敗しました: {e}")
        return False

    try:
        version, chunk_size, base_iv, wrapped_cek, data_offset = parse_file_header(file_data)
    except ValueError as e:
        print(f"  ERR {enc_file.name}: ヘッダー解析エラー: {e}")
        return False

    if wrapped_cek is None:
        print(f"  SKIP {enc_file.name}: v1 形式 (CEK が埋め込まれていないため復号できません)")
        return False

    try:
        cek = unwrap_key(unwrap_key_for_ceks, bytes(wrapped_cek))
    except Exception as e:
        print(f"  ERR {enc_file.name}: CEK の展開に失敗しました: {e}")
        return False

    try:
        plaintext = decrypt_file_content(cek, file_data)
    except Exception as e:
        print(f"  ERR {enc_file.name}: ファイル内容の復号に失敗しました: {e}")
        return False

    out_name = original_name or enc_file.stem
    out_path = output_path / out_name

    counter = 1
    base_out = out_path
    while out_path.exists():
        stem = base_out.stem
        suffix = base_out.suffix
        out_path = base_out.parent / f"{stem} ({counter}){suffix}"
        counter += 1

    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(plaintext)
    except OSError as e:
        print(f"  ERR {enc_file.name}: ファイルの書き込みに失敗しました: {e}")
        return False

    size_kb = len(plaintext) / 1024
    display_name = original_name or enc_file.name
    print(f"  OK  {display_name} ({size_kb:.1f} KB)")
    return True


def resolve_folder_name(folder: Path, name_keys: list[bytes]) -> str:
    """Try to decrypt a folder's Drive name. Falls back to raw name."""
    decrypted = decrypt_name_with_fallback(name_keys, folder.name)
    if decrypted:
        return decrypted
    if folder.name.endswith(".enc"):
        return folder.name[:-4]
    return folder.name


def process_folder_recursive(
    source_dir: Path,
    output_dir: Path,
    name_keys: list[bytes],
    unwrap_key_for_ceks: bytes,
    stats: dict,
    depth: int = 0,
):
    """Recursively process a folder, decrypting files and folder names."""
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        print(f"  ERR 出力フォルダ '{output_dir}' の作成に失敗しました: {e}")
        stats["failed"] += sum(1 for _ in source_dir.rglob("*.enc"))
        return

    try:
        items = sorted(source_dir.iterdir())
    except OSError as e:
        print(f"  ERR フォルダ '{source_dir}' の読み取りに失敗しました: {e}")
        return

    for item in items:
        if item.name == META_FILE_NAME:
            continue

        if item.is_file() and item.name.endswith(".enc"):
            if decrypt_single_file(item, output_dir, name_keys, unwrap_key_for_ceks):
                stats["succeeded"] += 1
            else:
                stats["failed"] += 1

        elif item.is_dir():
            subfolder_name = resolve_folder_name(item, name_keys)
            sub_output = output_dir / subfolder_name
            indent = "  " * (depth + 1)
            print(f"{indent}[DIR] {item.name} -> {subfolder_name}/")
            process_folder_recursive(
                item, sub_output, name_keys, unwrap_key_for_ceks, stats, depth + 1
            )


def process_targets(
    targets: list,
    meta_path: Path,
    output_dir: Path,
    passphrase: str,
):
    """Main processing: load metadata, derive keys, decrypt targets."""
    print(f"\nメタデータ: {meta_path}")
    print(f"出力先:     {output_dir}")
    print(f"対象数:     {len(targets)}")
    for t in targets:
        kind = "[DIR]" if t.is_dir() else "[FILE]"
        print(f"   {kind} {t}")

    try:
        meta = load_meta_file(meta_path)
    except ValueError as e:
        print(f"\nエラー: {e}")
        sys.exit(1)

    try:
        name_keys, unwrap_key_for_ceks = derive_keys(meta, passphrase)
    except ValueError as e:
        print(f"\nエラー: キーの導出に失敗しました: {e}")
        sys.exit(1)

    print("[4/4] ファイルを復号しています...")
    stats = {"succeeded": 0, "failed": 0}

    for target in targets:
        if target.is_file():
            if target.name.endswith(".enc"):
                if decrypt_single_file(target, output_dir, name_keys, unwrap_key_for_ceks):
                    stats["succeeded"] += 1
                else:
                    stats["failed"] += 1
            else:
                print(f"  SKIP .enc ではないファイル: {target.name}")
        elif target.is_dir():
            folder_name = resolve_folder_name(target, name_keys)
            folder_output = output_dir / folder_name
            print(f"[DIR] {target.name} -> {folder_name}/")
            process_folder_recursive(
                target, folder_output, name_keys, unwrap_key_for_ceks, stats
            )
        else:
            print(f"  SKIP 見つかりません: {target}")

    total = stats["succeeded"] + stats["failed"]
    print(f"\n{'=' * 50}")
    print(f"結果: {stats['succeeded']} 件成功、{stats['failed']} 件失敗 （対象合計 {total} 件）")
    if stats["succeeded"] > 0:
        print(f"復号されたファイルの保存先: {output_dir}")


def find_default_layout(script_dir: Path):
    """
    Detect a downloaded vault layout placed next to the script:
      script.py
      <downloaded-vault-root>/
          data/
          DO_NOT_DELETE.json
    Returns (vault_dir, meta_path, targets) or None.
    """
    candidate_dirs = find_vault_dirs(script_dir)
    if not candidate_dirs:
        return None

    vault_dir = next((path for path in candidate_dirs if path.name == "kakusu"), candidate_dirs[0])

    meta_path = find_meta_file(vault_dir)
    if meta_path is None:
        return None

    data_dir = vault_dir / "data"
    targets = []
    if data_dir.is_dir():
        targets.append(data_dir)
    else:
        for item in vault_dir.iterdir():
            if item.name not in META_FILE_NAMES:
                targets.append(item)

    return vault_dir, meta_path, targets


def ask_path(prompt: str, default: Path, must_exist: bool = True) -> Path:
    """Ask the user for a path with a default value."""
    while True:
        try:
            raw = input(f"{prompt} [デフォルト: {default}]: ").strip()
        except EOFError:
            print("  エラー: 入力がEOFで終了しました。")
            sys.exit(1)
        if not raw:
            path = default
        else:
            path = Path(raw).expanduser()
            if not path.is_absolute():
                path = Path.cwd() / path
        if must_exist and not path.exists():
            print(f"  エラー: '{path}' が見つかりません。再度入力してください。")
            continue
        return path


def ask_passphrase() -> str:
    """Ask for passphrase securely."""
    while True:
        try:
            pw = getpass.getpass("パスフレーズを入力してください: ")
        except EOFError:
            print("  エラー: 入力がEOFで終了しました。")
            sys.exit(1)
        if pw:
            return pw
        print("  エラー: パスフレーズは空にできません。")


def interactive_setup(script_dir: Path) -> tuple:
    """
    Run an interactive wizard to collect settings.
    Returns (targets, meta_path, output_dir, passphrase).
    """
    print("\n対話形式で設定を行います。空のまま Enter を押すとデフォルト値が使用されます。\n")

    default_layout = find_default_layout(script_dir)

    # Step 1: Metadata file
    if default_layout:
        default_vault_dir, default_meta, default_targets = default_layout
    else:
        default_vault_dir = script_dir / "kakusu"
        default_meta = default_vault_dir / "DO_NOT_DELETE.json"
        default_targets = [default_vault_dir / "data"]
        if not default_meta.exists():
            default_meta = default_vault_dir / "DO_NOT_DELETE"
        if not default_meta.exists():
            default_meta = default_vault_dir / "DO_NOT_DELETE.json"

    print("[1/4] メタデータファイル (DO_NOT_DELETE.json) のパスを入力してください。")
    meta_path = ask_path("      ", default_meta, must_exist=True)

    # Step 2: Target(s)
    default_target = default_vault_dir / "data"
    if not default_target.exists() and default_targets:
        default_target = default_targets[0]
    if not default_target.exists():
        default_target = default_vault_dir
    if not default_target.exists():
        default_target = script_dir

    print("\n[2/4] 復号対象のフォルダまたはファイルのパスを入力してください。")
    target_path = ask_path("      ", default_target, must_exist=True)
    targets = [target_path]

    # Step 3: Output directory
    default_output = script_dir / "rawdata"
    print("\n[3/4] 出力先フォルダのパスを入力してください。")
    try:
        out_raw = input(f"      [デフォルト: {default_output}]: ").strip()
    except EOFError:
        print("  エラー: 入力がEOFで終了しました。")
        sys.exit(1)
    if out_raw:
        output_dir = Path(out_raw).expanduser()
        if not output_dir.is_absolute():
            output_dir = Path.cwd() / output_dir
    else:
        output_dir = default_output

    # Step 4: Passphrase
    print("\n[4/4] 暗号化に使用したパスフレーズを入力してください。")
    passphrase = ask_passphrase()

    # If target is a directory that contains the meta file, expand its children
    if len(targets) == 1 and targets[0].is_dir():
        single_dir = targets[0]
        found_meta = find_meta_file(single_dir)
        if found_meta and found_meta.resolve() == meta_path.resolve():
            try:
                targets = [
                    item for item in single_dir.iterdir()
                    if item.name != META_FILE_NAME
                ]
            except OSError as e:
                print(f"\nエラー: 復号対象フォルダの読み取りに失敗しました: {e}")
                sys.exit(1)

    # Confirmation
    print(f"\n{'-' * 50}")
    print("設定の確認:")
    print(f"  メタデータ: {meta_path}")
    print(f"  復号対象:   {target_path}")
    print(f"  出力先:     {output_dir}")
    print(f"{'-' * 50}")

    while True:
        try:
            confirm = input("この設定で復号を実行しますか？ (Y/n): ").strip().lower()
        except EOFError:
            print("  エラー: 入力がEOFで終了しました。")
            sys.exit(1)
        if confirm in ("", "y", "yes"):
            break
        if confirm in ("n", "no"):
            print("キャンセルしました。")
            sys.exit(0)
        print("  Y または n で入力してください。")

    return targets, meta_path, output_dir, passphrase


def main():
    parser = argparse.ArgumentParser(
        description="Kakusu Offline Recovery - Decrypt files downloaded from Google Drive",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Interactive mode (just run the script with no arguments):
  python decrypt.py

Non-interactive examples:
    python decrypt.py downloaded-vault-root/       # explicit input folder
  python decrypt.py file.enc                     # single file
  python decrypt.py folder1/ folder2/            # multiple folders
    python decrypt.py downloaded-vault-root/ -o output/           # custom output directory
    python decrypt.py -m downloaded-vault-root/DO_NOT_DELETE.json folder1/  # explicit meta file
    python decrypt.py -p "passphrase" downloaded-vault-root/      # avoid prompt
""",
    )
    parser.add_argument(
        "targets",
        type=Path,
        nargs="*",
        help="Files or folders to decrypt (default: interactive mode)",
    )
    parser.add_argument(
        "-o", "--output",
        type=Path,
        default=None,
        help="Output directory for decrypted files (default: rawdata/)",
    )
    parser.add_argument(
        "-m", "--meta",
        type=Path,
        default=None,
        help="Path to DO_NOT_DELETE.json metadata file",
    )
    parser.add_argument(
        "-p", "--passphrase",
        type=str,
        default=None,
        help="Passphrase (will prompt if not provided)",
    )

    args = parser.parse_args()
    script_dir = Path(__file__).resolve().parent

    print("=" * 50)
    print(" Kakusu Offline Recovery Tool")
    print("=" * 50)

    interactive_mode = not args.targets

    try:
        if interactive_mode:
            targets, meta_path, output_dir, passphrase = interactive_setup(script_dir)
        else:
            # -- Resolve targets and meta file --
            targets = []
            meta_path = args.meta

            for t in args.targets:
                t = t.resolve() if t.is_absolute() else (Path.cwd() / t).resolve()
                if not t.exists():
                    print(f"エラー: '{t}' が見つかりません。")
                    sys.exit(1)
                targets.append(t)

            # If a single directory is given and contains DO_NOT_DELETE.json,
            # treat it as the kakusu root folder
            if len(targets) == 1 and targets[0].is_dir():
                single_dir = targets[0]
                found_meta = find_meta_file(single_dir)
                if found_meta:
                    meta_path = meta_path or found_meta
                    try:
                        targets = [
                            item for item in single_dir.iterdir()
                            if item.name != META_FILE_NAME
                        ]
                    except OSError as e:
                        print(f"エラー: フォルダ '{single_dir}' の読み取りに失敗しました: {e}")
                        sys.exit(1)

            # Find meta file if not specified
            if meta_path is None:
                for t in args.targets:
                    search = t.resolve()
                    if search.is_file():
                        search = search.parent
                    while search != search.parent:
                        found = find_meta_file(search)
                        if found:
                            meta_path = found
                            break
                        search = search.parent
                    if meta_path:
                        break

                if meta_path is None:
                    result = find_default_layout(script_dir)
                    if result:
                        _, meta_path, _ = result

            if meta_path is None:
                print("\nエラー: DO_NOT_DELETE.json メタデータファイルが見つかりません。")
                print("明示的に指定するには: python decrypt.py -m /path/to/DO_NOT_DELETE.json <targets>")
                sys.exit(1)

            output_dir = args.output or (script_dir / "rawdata")

            if not targets:
                print("\nエラー: 復号対象のファイルまたはフォルダがありません。")
                sys.exit(1)

            # -- Get passphrase --
            passphrase = args.passphrase
            if passphrase is None:
                try:
                    passphrase = getpass.getpass("\nパスフレーズを入力してください: ")
                except EOFError:
                    print("エラー: 入力がEOFで終了しました。")
                    sys.exit(1)
                if not passphrase:
                    print("エラー: パスフレーズは空にできません。")
                    sys.exit(1)

        # -- Process --
        process_targets(targets, meta_path, output_dir, passphrase)
    except KeyboardInterrupt:
        print("\n\n処理を中断しました。")
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as e:
        print(f"\n予期しないエラーが発生しました: {e}")
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
