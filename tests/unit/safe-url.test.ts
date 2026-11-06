import { describe, expect, it } from "vitest";
import { safeHttpUrl as safeHttpUrlFromHelpers } from "@/app/components/inventory/helpers";
import { isHttpUrlText, isVendorLinkText, safeHttpUrl } from "@/lib/safe-url";

describe("safeHttpUrl (what may become a link)", () => {
  it("is the same function the Inventory components import from their helpers (it moved, nothing else changed)", () => {
    expect(safeHttpUrlFromHelpers).toBe(safeHttpUrl);
  });

  it.each([
    ["https://shop.example.com/reorder?item=1", "https://shop.example.com/reorder?item=1"],
    ["http://shop.example.com", "http://shop.example.com/"],
    ["  https://shop.example.com/a  ", "https://shop.example.com/a"],
    ["HTTPS://SHOP.EXAMPLE.COM/A", "https://shop.example.com/A"],
  ])("keeps the address %j as a link", (raw, expected) => {
    expect(safeHttpUrl(raw)).toBe(expected);
  });

  it.each([
    ["shop.example.com/reorder", "https://shop.example.com/reorder"],
    ["shop.example.com", "https://shop.example.com/"],
    ["my-shop.example.org/a/b?c=d", "https://my-shop.example.org/a/b?c=d"],
  ])("reads a bare address %j as https, because earlier staff typed them that way", (raw, expected) => {
    expect(safeHttpUrl(raw)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://files.example/a",
    "mailto:orders@example.org",
    "plain words",
    "",
    "   ",
    "http://",
  ])("gives no link for %j", (raw) => {
    expect(safeHttpUrl(raw)).toBeNull();
  });

  it("gives no link for something that is not text", () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});

describe("isHttpUrlText (what may be stored)", () => {
  it.each([
    "https://shop.example.com/reorder?item=1#top",
    "http://shop.example.com",
    "HTTPS://SHOP.EXAMPLE.COM",
    "https://ok.example:8443/a",
    "http://192.168.1.20/a.png",
    "https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/medication-photos/1730000000000-k3j2h1g0f9.jpg",
    "https://ok.example/path with spaces",
  ])("accepts %j", (text) => {
    expect(isHttpUrlText(text)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "ftp://files.example/a",
    "shop.example.com/reorder",
    "//evil.example/x",
    "http://",
    "https:///path",
    "http:example.com",
    "https://?query",
    "https://#fragment",
    "https://ok.example/a\nb",
    "https://ok.example/a\tb",
    "https://ok.example/a\rb",
    "https://ok.example/a\u0000b",
    "https://ok.example/a\u007fb",
    "",
    " ",
  ])("refuses %j", (text) => {
    expect(isHttpUrlText(text)).toBe(false);
  });

  it("is stricter than the display rule on purpose: a bare address is shown as a link, but a photo address must be a real http(s) address", () => {
    expect(safeHttpUrl("shop.example.com/reorder")).not.toBeNull();
    expect(isHttpUrlText("shop.example.com/reorder")).toBe(false);
  });
});

describe("isVendorLinkText (what may be stored as a vendor link)", () => {
  it.each([
    "https://shop.example.com/reorder?item=1",
    "http://shop.example.com",
    "shop.example.com/reorder",
    "shop.example.com",
    "my-shop.example.org/a/b?c=d",
  ])("accepts %j", (text) => {
    expect(isVendorLinkText(text)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://files.example/a.png",
    "mailto:orders@example.org",
    "blob:https://ok.example/1",
    "//evil.example/x",
    "reorder",
    "http:example.com",
    "https://",
    "shop.example.com:8080/reorder",
    "shop.example.com/a b",
    "shop.example.com/a\nb",
    "https://ok.example/a\tb",
    "",
    " ",
  ])("refuses %j", (text) => {
    expect(isVendorLinkText(text)).toBe(false);
  });

  it("agrees with the display rule: whatever it accepts becomes a link, and nothing it refuses is ever drawn as one", () => {
    for (const text of ["https://a.example/x", "a.example/x", "a.example", "javascript:alert(1)", "a.example:80", "plain"]) {
      expect(isVendorLinkText(text), text).toBe(safeHttpUrl(text) !== null && !/[:\s]/.test(text.replace(/^https?:\/\//i, "")));
    }
  });
});
