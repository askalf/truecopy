// OS-keychain storage for canon's PRIVATE signing key — held by the operating
// system, tied to your login, never written as plaintext. Zero deps: each
// platform's native CLI/API.
//   macOS   → Keychain        (security)
//   Linux   → Secret Service  (secret-tool / libsecret)
//   Windows → DPAPI user-scope (PowerShell; an encrypted blob only this user can read)
// The PUBLIC key + keyId stay in ~/.canon/signing-key.json (public is not secret).
// CANON_KEYCHAIN_FAKE=<file> is a TEST seam (a plain JSON file standing in for the
// keychain); CANON_NO_KEYCHAIN forces the plaintext-file fallback.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVICE = 'canon', ACCOUNT = 'signing-key';
const home = () => path.join(process.env.CANON_HOME || os.homedir(), '.canon');
const blobFile = () => path.join(home(), 'signing-key.dpapi');
const run = (cmd, args, input) => execFileSync(cmd, args, { input, stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8' });
const fake = () => process.env.CANON_KEYCHAIN_FAKE;

export function keychainAvailable() {
  if (process.env.CANON_NO_KEYCHAIN) return false;      // explicit opt-out / test seam
  if (fake()) return true;
  if (process.platform === 'darwin' || process.platform === 'win32') return true; // security / DPAPI are built in
  if (process.platform === 'linux') { try { run('secret-tool', ['--version']); return true; } catch { return false; } }
  return false;
}

/** Read the stored value (string), or null if none. */
export function keychainGet() {
  if (fake()) { try { return JSON.parse(fs.readFileSync(fake(), 'utf8')).value || null; } catch { return null; } }
  try {
    if (process.platform === 'darwin') return run('security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w']).trim() || null;
    if (process.platform === 'linux') return run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]).trim() || null;
    if (process.platform === 'win32') {
      const blob = blobFile();
      if (!fs.existsSync(blob)) return null;
      const enc = fs.readFileSync(blob, 'utf8').trim();
      // The blob goes in on STDIN, never interpolated into the command string.
      // It used to be spliced into a single-quoted PowerShell literal, so one
      // apostrophe in signing-key.dpapi closed the quote and the rest of the file
      // ran as PowerShell — arbitrary code as this user, on the next `--sign`.
      // We write that file ourselves as base64, so it takes a separate write to
      // reach it; but "an attacker who can already write there could do worse"
      // is a weak defense for a key store, and it stops being true the moment
      // ~/.canon is a mounted volume, a synced home directory, or a shared CI
      // box. The set path has always used stdin — this just matches it.
      if (!/^[A-Za-z0-9+/=\s]+$/.test(enc)) return null;   // not base64: refuse rather than hand it to a shell
      const ps = 'Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,\'CurrentUser\'); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))';
      return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], enc).trim() || null;
    }
  } catch { return null; }
  return null;
}

/** Store the value (string) in the OS keychain. On Linux (secret-tool) and Windows
 *  (PowerShell DPAPI) the value goes via stdin, so it never appears in a process
 *  listing. macOS `security` has NO stdin password input (its -w prompt reads /dev/tty,
 *  not stdin), so there the value is passed as an argument — briefly visible in `ps` for
 *  the command's duration. A CLI limitation; closing it fully needs the native Security
 *  framework (a non-CLI follow-up). */
export function keychainSet(value) {
  if (fake()) { fs.mkdirSync(path.dirname(fake()), { recursive: true }); fs.writeFileSync(fake(), JSON.stringify({ value }), { mode: 0o600 }); return; }
  // macOS: `security` can't take the password on stdin (see note above), so it goes as an
  // argument and is briefly visible in `ps`. Accepted CLI limitation — do NOT "fix" this
  // with `-w` and no inline value: that reads /dev/tty, not stdin, and silently stores the
  // wrong secret (caught by the macOS CI added in this change).
  if (process.platform === 'darwin') { run('security', ['add-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w', value, '-U']); return; }
  if (process.platform === 'linux') { run('secret-tool', ['store', '--label=canon signing key', 'service', SERVICE, 'account', ACCOUNT], value); return; }
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Security; $p=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $b=[Security.Cryptography.ProtectedData]::Protect($p,$null,'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($b))`;
    const enc = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], value).trim();
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(blobFile(), enc, { mode: 0o600 });
    return;
  }
  throw new Error('canon: no OS keychain available on this platform');
}

export const keychainKind = () =>
  fake() ? 'test-fake'
    : process.platform === 'darwin' ? 'macOS Keychain'
      : process.platform === 'win32' ? 'Windows DPAPI (user scope)'
        : process.platform === 'linux' ? 'Secret Service (libsecret)'
          : 'unknown';
