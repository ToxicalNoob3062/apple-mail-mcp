import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dataSubdirs, emlxCandidates, emlxSource, htmlToText, messageText } from "@/utils/emlx.js";
import { emlx, plainMessage, writeEmlx } from "@/utils/envelopeIndex.testFixture.js";

describe("dataSubdirs", () => {
  it("puts ids below 1000 directly in Data/Messages", () => {
    expect(dataSubdirs(0)).toEqual([]);
    expect(dataSubdirs(999)).toEqual([]);
  });

  it("uses the digits of id/1000, least significant first", () => {
    // Real paths from a Mail store: 10371 → Data/0/1, 11140 → Data/1/1.
    expect(dataSubdirs(10371)).toEqual(["0", "1"]);
    expect(dataSubdirs(11140)).toEqual(["1", "1"]);
    expect(dataSubdirs(72750)).toEqual(["2", "7"]);
    expect(dataSubdirs(1000)).toEqual(["1"]);
    expect(dataSubdirs(123456)).toEqual(["3", "2", "1"]);
  });
});

describe("emlxCandidates", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "emlx-cand-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("maps a nested mailbox path onto the .mbox chain and the id's Data folder", () => {
    const file = writeEmlx(root, "ACC", "[Gmail]/All Mail", 10371, plainMessage("s", "b"));
    expect(emlxCandidates(root, "ACC", "[Gmail]/All Mail", 10371)).toContain(file);
  });

  it("offers the partial file too, full download first", () => {
    const c = emlxCandidates(
      (writeEmlx(root, "ACC", "INBOX", 5, plainMessage("s", "b")), root),
      "ACC",
      "INBOX",
      5
    );
    expect(c[0]).toMatch(/\/5\.emlx$/);
    expect(c[1]).toMatch(/\/5\.partial\.emlx$/);
  });

  it("checks every store directory of the mailbox", () => {
    writeEmlx(root, "ACC", "INBOX", 5, plainMessage("s", "b"));
    mkdirSync(join(root, "ACC", "INBOX.mbox", "OTHER-STORE", "Data"), { recursive: true });
    expect(emlxCandidates(root, "ACC", "INBOX", 5)).toHaveLength(4);
  });

  it("returns nothing for a mailbox that isn't on disk, or an empty path", () => {
    expect(emlxCandidates(root, "ACC", "Nope", 5)).toEqual([]);
    expect(emlxCandidates(root, "ACC", "", 5)).toEqual([]);
  });
});

describe("emlxSource", () => {
  it("returns exactly the counted message bytes", () => {
    const msg = plainMessage("Hi", "body");
    expect(emlxSource(emlx(msg))).toBe(msg);
  });

  it("keeps raw bytes as latin1 for mimeParse to decode", () => {
    const utf8 = Buffer.from("Subject: x\r\n\r\ncafé", "utf8");
    const framed = Buffer.concat([Buffer.from(`${utf8.length}\n`), utf8]);
    expect(emlxSource(framed)).toBe(utf8.toString("latin1"));
  });

  it("rejects missing or bad framing", () => {
    expect(emlxSource(Buffer.from("no newline"))).toBeNull();
    expect(emlxSource(Buffer.from("\nstarts with newline"))).toBeNull();
    expect(emlxSource(Buffer.from("abc\nx"))).toBeNull();
    expect(emlxSource(Buffer.from("0\nx"))).toBeNull();
  });
});

describe("htmlToText", () => {
  it("drops scripts and styles, keeps line structure, decodes entities", () => {
    expect(
      htmlToText(
        "<style>p{}</style><p>Hello&nbsp;&amp; welcome</p><script>x()</script><p>Line&nbsp;2<br>3</p>"
      )
    ).toBe("Hello & welcome\n Line 2\n3");
  });

  it("decodes each entity once (no double-unescape of &amp;lt;)", () => {
    expect(htmlToText("<p>&amp;lt;b&amp;gt; &amp;amp;</p>")).toBe("&lt;b&gt; &amp;");
  });

  /** The regex version htmlToText replaced; quadratic on hostile input, so only fed small strings. */
  const regexVersion = (html: string) =>
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, "&")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n\n")
      .trim();

  it("gives exactly what the regex version gave, on random tag soup", () => {
    const pieces = [
      "<",
      ">",
      "<>",
      "<p>",
      "</p>",
      "<br/>",
      "<STYLE a=1>",
      "</style>",
      "</STYLE>",
      "<script>",
      "</Script>",
      "<scripts>",
      "<stylesheet>",
      "</style >",
      "<sty",
      "le>",
      "x",
      " ",
      "\n",
      "\t",
      "&amp;",
      "&lt;",
      "ſcript",
      "<ſtyle>",
      "K",
      "é",
      "<b",
      "c>",
    ];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 5000; i++) {
      let html = "";
      for (let n = Math.floor(rnd() * 40); n > 0; n--)
        html += pieces[Math.floor(rnd() * pieces.length)];
      expect(htmlToText(html)).toBe(regexVersion(html));
    }
  });

  it("takes linear time on input built to make the regexes rescan", () => {
    const hostile = [
      "<".repeat(200_000), // no `>` after any `<`
      "<style>".repeat(100_000), // opening tags that never close
      "<script".repeat(100_000), // and never even end
      "<style>x</style>".repeat(50_000) + "<style>".repeat(50_000),
    ];
    const t0 = performance.now();
    for (const html of hostile) htmlToText(html);
    // The regex version took 1.6 s for 20,000 `<script`s, growing with the square.
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(htmlToText("<style>".repeat(3) + "<p>kept</p>")).toBe("kept");
  });
});

describe("messageText", () => {
  const multipart = (plain: string, html: string) =>
    'Content-Type: multipart/alternative; boundary="b"\r\n\r\n' +
    `--b\r\nContent-Type: text/plain\r\n\r\n${plain}\r\n` +
    `--b\r\nContent-Type: text/html\r\n\r\n${html}\r\n--b--\r\n`;

  it("prefers the plain part", () => {
    expect(messageText(multipart("plain words", "<p>html words</p>"))).toBe("plain words");
  });

  it("reads the HTML part when the plain part is missing or blank", () => {
    expect(messageText(multipart(" \r\n\t", "<p>html words</p>"))).toBe("html words");
    expect(messageText("Content-Type: text/html\r\n\r\n<b>only html</b>")).toBe("only html");
  });

  it("uses an HTML part the caller already has, and keeps a blank plain part when there is no HTML", () => {
    expect(messageText(multipart(" ", "<p>x</p>"), "<p>given</p>")).toBe("given");
    expect(messageText("Content-Type: text/plain\r\n\r\n  ")).toBe("  ");
    expect(messageText("Content-Type: image/png\r\n\r\nxx")).toBe("");
  });
});
