/**
 * Test fixtures: a fake `~/Library/Mail` tree with an Envelope Index shaped like
 * Mail.app's (only the tables/columns the readers use) and `.emlx` files.
 * Shared by the envelopeIndex, emlx and manager tests.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { loadSqlite, type SqliteModule } from "@/utils/envelopeIndex.js";
import { dataSubdirs } from "@/utils/emlx.js";

/** node:sqlite for building fixtures, or null where it's unavailable (skip). */
export const sqlite: SqliteModule | null = loadSqlite();

export interface FixtureMessage {
  id: number;
  account: string;
  mailbox: string;
  subject: string;
  subjectPrefix?: string;
  address: string;
  name?: string;
  /** Unix seconds. */
  received: number;
  sent?: number;
  read?: boolean;
  flagged?: boolean;
  deleted?: boolean;
  /** Extra mailboxes the message belongs to via Gmail `labels` rows. */
  labels?: string[];
  attachments?: string[];
}

export interface FixtureOptions {
  /** Create the Gmail `labels` table (default true). */
  labels?: boolean;
  /** Create `messages.subject_prefix` (default true). */
  subjectPrefix?: boolean;
  /** Mailboxes that exist without messages, as `account/path`. */
  extraMailboxes?: string[];
}

/** Percent-encode a mailbox path the way Mail writes it into a URL. */
export function mailboxUrl(account: string, path: string): string {
  const scheme = account.startsWith("EWS") ? "ews" : "imap";
  return `${scheme}://${account}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Build an Envelope Index at `indexPath` holding `messages`. */
export function buildEnvelopeIndex(
  indexPath: string,
  messages: FixtureMessage[],
  opts: FixtureOptions = {}
): void {
  const db = new sqlite!.DatabaseSync(indexPath);
  db.exec(`
    CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
    CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
    CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
    CREATE TABLE messages (
      ROWID INTEGER PRIMARY KEY,
      message_id INTEGER,
      ${opts.subjectPrefix === false ? "" : "subject_prefix TEXT,"}
      subject INTEGER, sender INTEGER, mailbox INTEGER,
      date_received INTEGER, date_sent INTEGER,
      read INTEGER, flagged INTEGER, deleted INTEGER
    );
    CREATE TABLE attachments (ROWID INTEGER PRIMARY KEY, message INTEGER, name TEXT);
  `);
  if (opts.labels !== false) {
    db.exec(`CREATE TABLE labels (message_id INTEGER, mailbox_id INTEGER)`);
  }

  const mailboxIds = new Map<string, number>();
  const mailboxId = (account: string, path: string): number => {
    const key = `${account}/${path}`;
    let id = mailboxIds.get(key);
    if (id === undefined) {
      id = mailboxIds.size + 1;
      mailboxIds.set(key, id);
      db.prepare(`INSERT INTO mailboxes (ROWID, url) VALUES (?, ?)`).run(
        id,
        mailboxUrl(account, path)
      );
    }
    return id;
  };
  for (const extra of opts.extraMailboxes ?? []) {
    const [account, ...rest] = extra.split("/");
    mailboxId(account, rest.join("/"));
  }

  messages.forEach((m, i) => {
    db.prepare(`INSERT INTO subjects (ROWID, subject) VALUES (?, ?)`).run(i + 1, m.subject);
    db.prepare(`INSERT INTO addresses (ROWID, address, comment) VALUES (?, ?, ?)`).run(
      i + 1,
      m.address,
      m.name ?? null
    );
    const cols =
      opts.subjectPrefix === false
        ? `ROWID, subject, sender, mailbox, date_received, date_sent, read, flagged, deleted`
        : `ROWID, subject_prefix, subject, sender, mailbox, date_received, date_sent, read, flagged, deleted`;
    const values = [
      m.id,
      ...(opts.subjectPrefix === false ? [] : [m.subjectPrefix ?? null]),
      i + 1,
      i + 1,
      mailboxId(m.account, m.mailbox),
      m.received,
      m.sent ?? null,
      m.read ? 1 : 0,
      m.flagged ? 1 : 0,
      m.deleted ? 1 : 0,
    ];
    db.prepare(`INSERT INTO messages (${cols}) VALUES (${values.map(() => "?").join(", ")})`).run(
      ...values
    );
    for (const label of opts.labels === false ? [] : (m.labels ?? [])) {
      db.prepare(`INSERT INTO labels (message_id, mailbox_id) VALUES (?, ?)`).run(
        m.id,
        mailboxId(m.account, label)
      );
    }
    for (const name of m.attachments ?? []) {
      db.prepare(`INSERT INTO attachments (message, name) VALUES (?, ?)`).run(m.id, name);
    }
  });
  db.close();
}

/** Wrap an RFC 5322 message in Mail's `.emlx` framing (count line + plist footer). */
export function emlx(message: string): Buffer {
  const body = Buffer.from(message, "latin1");
  const footer = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>flags</key><integer>0</integer></dict></plist>\n`;
  return Buffer.concat([Buffer.from(`${body.length}\n`), body, Buffer.from(footer)]);
}

/** A plain-text message with the given body. */
export function plainMessage(subject: string, body: string): string {
  return `From: a@example.com\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
}

/**
 * Write an `.emlx` file into a `V10` tree the way Mail lays it out:
 * `<account>/<a>.mbox/<b>.mbox/<store>/Data/<digits>/Messages/<id>.emlx`, where
 * `mailbox` is the account-relative path (`[Gmail]/All Mail`).
 */
export function writeEmlx(
  versionDir: string,
  account: string,
  mailbox: string,
  id: number,
  message: string,
  opts: { partial?: boolean } = {}
): string {
  const dir = join(
    versionDir,
    account,
    ...mailbox.split("/").map((seg) => `${seg}.mbox`),
    "STORE-UUID",
    "Data",
    ...dataSubdirs(id),
    "Messages"
  );
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}${opts.partial ? ".partial" : ""}.emlx`);
  writeFileSync(file, emlx(message));
  return file;
}
