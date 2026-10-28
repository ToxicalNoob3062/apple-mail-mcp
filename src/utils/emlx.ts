/**
 * Mail.app `.emlx` files: where a message's file lives, and how to read it.
 *
 * Mail stores each synced message as
 *
 *   <V-dir>/<account-id>/<a>.mbox/<b>.mbox/<store-uuid>/Data/<d…>/Messages/<id>.emlx
 *
 * where the `.mbox` chain mirrors the account-relative mailbox path
 * (`[Gmail]/All Mail` → `[Gmail].mbox/All Mail.mbox`), `<id>` is the Envelope
 * Index ROWID (= AppleScript `id of message`), and `<d…>` are the decimal digits
 * of `floor(id / 1000)`, least significant first (id 10371 → `Data/0/1`; ids
 * below 1000 sit directly in `Data/Messages`). A message whose body Mail hasn't
 * fully downloaded is `<id>.partial.emlx`.
 *
 * The file is a byte-count line, that many bytes of RFC 5322 message, then an
 * XML plist of Mail's own metadata.
 *
 * @module utils/emlx
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";

/** Directory under `Data/` holding message `id`, as path segments. */
export function dataSubdirs(id: number): string[] {
  const bucket = Math.floor(id / 1000);
  return bucket === 0 ? [] : String(bucket).split("").reverse();
}

/**
 * Candidate `.emlx` paths for message `id` in an account-relative mailbox,
 * full download first. Only lists the mailbox's store directories — no walk.
 */
export function emlxCandidates(
  versionDir: string,
  accountId: string,
  mailboxPath: string,
  id: number
): string[] {
  const segments = mailboxPath.split("/").filter(Boolean);
  if (segments.length === 0) return [];
  const mailboxDir = join(versionDir, accountId, ...segments.map((s) => `${s}.mbox`));
  let stores: string[];
  try {
    stores = readdirSync(mailboxDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(mailboxDir, e.name, "Data")))
      .map((e) => join(mailboxDir, e.name, "Data"));
  } catch {
    return [];
  }
  // Some stores keep Data directly under the .mbox.
  if (existsSync(join(mailboxDir, "Data"))) stores.push(join(mailboxDir, "Data"));
  const sub = dataSubdirs(id);
  return stores.flatMap((data) => [
    join(data, ...sub, "Messages", `${id}.emlx`),
    join(data, ...sub, "Messages", `${id}.partial.emlx`),
  ]);
}

/**
 * The RFC 5322 message inside an `.emlx` file, as a latin1 string of the raw
 * bytes (the form mimeParse expects), or null when the framing is wrong.
 */
export function emlxSource(bytes: Buffer): string | null {
  const nl = bytes.indexOf(0x0a);
  if (nl <= 0) return null;
  const count = Number(bytes.subarray(0, nl).toString("latin1").trim());
  if (!Number.isInteger(count) || count <= 0) return null;
  return bytes.subarray(nl + 1, nl + 1 + count).toString("latin1");
}

/** Strip tags and common entities so an HTML-only body reads as text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
