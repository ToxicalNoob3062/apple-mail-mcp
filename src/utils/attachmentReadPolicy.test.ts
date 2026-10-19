import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  ATTACHMENT_READ_ROOTS_ENV,
  canonicalRoots,
  isProtectedPath,
  resolveAttachmentReadPath,
} from "@/utils/attachmentReadPolicy.js";

describe("outbound attachment read policy", () => {
  it("allows a regular file in the default temporary root", () => {
    const dir = mkdtempSync(join(tmpdir(), "amcp-read-policy-"));
    try {
      const file = join(dir, "report.pdf");
      writeFileSync(file, "pdf");
      expect(resolveAttachmentReadPath(file)).toBe(realpathSync(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a regular file in an ordinary home-directory location", () => {
    const dir = mkdtempSync(join(homedir(), "amcp-read-policy-"));
    try {
      const file = join(dir, "private.txt");
      writeFileSync(file, "private");
      expect(resolveAttachmentReadPath(file)).toBe(realpathSync(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects hidden home-directory paths by default", () => {
    const dir = mkdtempSync(join(homedir(), ".amcp-read-policy-"));
    try {
      const file = join(dir, "selected.txt");
      writeFileSync(file, "secret");
      expect(() => resolveAttachmentReadPath(file)).toThrow(/protected location/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects application config files under the home Library", () => {
    mkdirSync(join(homedir(), "Library", "Application Support"), { recursive: true });
    const dir = mkdtempSync(join(homedir(), "Library", "Application Support", "amcp-read-policy-"));
    try {
      const file = join(dir, "config.json");
      writeFileSync(file, "{}");
      expect(() => resolveAttachmentReadPath(file)).toThrow(/protected location/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects app state under the home Library but allows iCloud Drive", () => {
    // A CI runner's home has no ~/Library: mkdtemp needs its parent to exist.
    mkdirSync(join(homedir(), "Library", "Caches"), { recursive: true });
    const appState = mkdtempSync(join(homedir(), "Library", "Caches", "amcp-read-policy-"));
    try {
      const file = join(appState, "chat.db");
      writeFileSync(file, "db");
      expect(() => resolveAttachmentReadPath(file)).toThrow(/protected location/);
    } finally {
      rmSync(appState, { recursive: true, force: true });
    }

    const home = realpathSync.native(homedir());
    const icloud = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "x.pdf");
    expect(isProtectedPath(icloud)).toBe(false);
    expect(isProtectedPath(join(home, "Library", "CloudStorage", "Dropbox", "x.pdf"))).toBe(false);
    expect(isProtectedPath(join(home, "Library", "LaunchAgents", "x.plist"))).toBe(true);
    // Per-app iCloud containers are app state, not iCloud Drive.
    expect(
      isProtectedPath(join(home, "Library", "Mobile Documents", "iCloud~com~app", "db.sqlite"))
    ).toBe(true);
  });

  it("protects a user Library on any volume and in any spelling", () => {
    for (const path of [
      "/Volumes/Clone/Users/someone/Library/Messages/chat.db",
      "/Volumes/Backup/users/SOMEONE/library/Keychains/login.keychain-db",
      "/Users/JAP/Library/LaunchAgents/x.plist",
    ]) {
      expect(isProtectedPath(path), path).toBe(true);
    }
    expect(isProtectedPath("/Volumes/Clone/Users/someone/Documents/report.pdf")).toBe(false);
  });

  it("recognises the Library of a home directory that is not under /Users", () => {
    // `/Users/<name>/Library` is matched by its shape; a home elsewhere (a CI runner
    // under /Users is matched that way, a Linux or relocated home is not) has to be
    // matched against the home directory itself.
    const original = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "amcp-home-"));
    try {
      process.env.HOME = home;
      const canonicalHome = realpathSync.native(home);
      expect(isProtectedPath(join(canonicalHome, "Library", "Messages", "chat.db"))).toBe(true);
      expect(
        isProtectedPath(join(canonicalHome, "Library", "CloudStorage", "Dropbox", "x.pdf"))
      ).toBe(false);
      expect(isProtectedPath(join(canonicalHome, "Documents", "report.pdf"))).toBe(false);
    } finally {
      if (original === undefined) delete process.env.HOME;
      else process.env.HOME = original;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("lets an explicit root, and the server's tmpdir, lift only the Library rule", () => {
    const mailDownloads = "/Users/someone/Library/Containers/com.apple.mail/Data/Downloads";
    expect(isProtectedPath(join(mailDownloads, "a.pdf"))).toBe(true);
    expect(isProtectedPath(join(mailDownloads, "a.pdf"), [mailDownloads])).toBe(false);
    expect(isProtectedPath(join(mailDownloads, ".hidden"), [mailDownloads])).toBe(true);
  });

  it("does not let a root that holds the home directory lift the Library rule", () => {
    const home = realpathSync.native(homedir());
    const config = join(home, "Library", "Application Support", "apple-mail-mcp", "config.json");
    expect(isProtectedPath(config, [home])).toBe(true);
    expect(isProtectedPath(config, [join(home, "Library", "Application Support")])).toBe(false);
  });

  it("protects a Library only at the top of a volume, not a folder that is named like one", () => {
    expect(isProtectedPath("/System/Volumes/Data/Users/someone/Library/Messages/chat.db")).toBe(
      true
    );
    expect(isProtectedPath("/srv/backup/users/someone/library/books/report.pdf")).toBe(false);
    expect(isProtectedPath("/Volumes/Disk/archive/Users/someone/Library/report.pdf")).toBe(false);
  });

  it("never treats the filesystem root as a home-directory root", () => {
    expect(canonicalRoots(["/", "/tmp"])).toEqual([realpathSync.native("/tmp")]);
  });

  it("authorizes an explicit absolute root outside the defaults", () => {
    const file = "/etc/hosts";
    expect(resolveAttachmentReadPath(file, { [ATTACHMENT_READ_ROOTS_ENV]: "/etc" })).toBe(
      realpathSync(file)
    );
  });

  it("refuses a hidden path that is a symlink to an ordinary file", () => {
    // A dotfile manager's `~/.npmrc` -> `~/dotfiles/npmrc`: the target looks
    // ordinary, the path asked for names a credential location.
    const dir = mkdtempSync(join(homedir(), "amcp-dotfiles-"));
    const hidden = join(homedir(), `.amcp-npmrc-${process.pid}`);
    try {
      const target = join(dir, "npmrc");
      writeFileSync(target, "//registry.npmjs.org/:_authToken=secret");
      symlinkSync(target, hidden);
      expect(() => resolveAttachmentReadPath(hidden)).toThrow(/protected location/);
      expect(resolveAttachmentReadPath(target)).toBe(realpathSync(target));
    } finally {
      rmSync(hidden, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file reached through a hidden folder that is a symlink to a visible one", () => {
    const dir = mkdtempSync(join(homedir(), "amcp-dotfiles-"));
    const hidden = join(homedir(), `.amcp-dir-${process.pid}`);
    try {
      writeFileSync(join(dir, "notes.txt"), "notes");
      symlinkSync(dir, hidden, "dir");
      expect(() => resolveAttachmentReadPath(join(hidden, "notes.txt"))).toThrow(
        /protected location/
      );
    } finally {
      rmSync(hidden, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a relative path, a missing file, a directory and a relative extra root", () => {
    expect(() => resolveAttachmentReadPath("relative/report.pdf")).toThrow(/must be absolute/);

    const dir = mkdtempSync(join(tmpdir(), "amcp-read-policy-"));
    try {
      expect(() => resolveAttachmentReadPath(join(dir, "missing.pdf"))).toThrow(/not found/);
      expect(() => resolveAttachmentReadPath(dir)).toThrow(/not a regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(() =>
      resolveAttachmentReadPath("/etc/hosts", { [ATTACHMENT_READ_ROOTS_ENV]: "relative/root" })
    ).toThrow(/must be absolute/);
  });

  it("rejects a symlink that resolves outside an allowed temporary root", () => {
    const allowed = mkdtempSync(join(tmpdir(), "amcp-read-policy-"));
    try {
      const link = join(allowed, "link.txt");
      symlinkSync("/etc/hosts", link);
      expect(() => resolveAttachmentReadPath(link)).toThrow(/outside the allowed read roots/);
    } finally {
      rmSync(allowed, { recursive: true, force: true });
    }
  });
  it("canonicalizes to the on-disk spelling so a respelled segment cannot dodge a deny root", () => {
    // fs.realpathSync resolves symlinks but preserves the CALLER's casing; only
    // fs.realpathSync.native returns the true on-disk name. On a case-insensitive
    // volume (APFS default) that difference is a policy bypass: the deny roots are
    // written in exact case, so `~/library/keychains/...` opens the same file as
    // `~/Library/Keychains/...` while matching no deny root.
    const dir = mkdtempSync(join(homedir(), "AmcpCase-"));
    try {
      mkdirSync(join(dir, "Mixed"));
      const trueCased = join(dir, "Mixed", "Report.txt");
      writeFileSync(trueCased, "payload");

      const respelled = join(dir, "mixed", "report.txt");
      if (!existsSync(respelled)) return; // case-sensitive volume: respelling cannot exist

      // The policy must report the on-disk spelling, not the caller's.
      expect(resolveAttachmentReadPath(respelled)).toBe(realpathSync.native(trueCased));
      expect(resolveAttachmentReadPath(respelled)).not.toBe(respelled);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies a sensitive root under every spelling the filesystem accepts", () => {
    const keychain = join(homedir(), "Library", "Keychains", "login.keychain-db");
    if (!existsSync(keychain)) return; // not present on this host

    for (const variant of [
      keychain,
      join(homedir(), "library", "keychains", "login.keychain-db"),
      join(homedir(), "Library", "keychains", "login.keychain-db"),
    ]) {
      if (!existsSync(variant)) continue;
      expect(() => resolveAttachmentReadPath(variant)).toThrow(/protected location/);
    }
  });
});
