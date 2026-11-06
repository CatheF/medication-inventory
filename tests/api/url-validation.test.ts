// Requirement-driven tests: the vendor link and the photo address are only ever stored as http or https addresses.
//
// Why: both fields were stored with any scheme (javascript:, data:, file:) and any text. The Inventory screen guards the
// vendor LINK when it draws it, but the browser requests whatever the photo address says, and the stored value is what
// every other consumer (exports, other pages, other tools) reads. So the API refuses the value when it is written.
// The vendor link keeps accepting a bare "shop.example.com/reorder" (staff have always typed those and every screen shows
// them as https links); the photo address must be a real http(s) address. Values that are already stored are never rewritten.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asRecord, bodyRecord, errorTextOf, ID_SHAPES, itemNamed, snapshotDb, storedMedication } from "../helpers/api-test-kit";
import { installFake, type FakeSupabase } from "../helpers/fake-supabase";
import { seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const FIELDS = [
  { field: "vendor_url", label: /vendor url/i },
  { field: "photo_url", label: /photo url/i },
] as const;

/** What /api/upload hands back after a photo is stored (a public Supabase Storage URL). */
const STORAGE_URL = "https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/medication-photos/1730000000000-k3j2h1g0f9.jpg";

const REFUSED: Array<[string, string]> = [
  ["a javascript: address", "javascript:alert(1)"],
  ["a javascript: address in capital letters", "JAVASCRIPT:alert(1)"],
  ["a javascript: address with a leading space", "  javascript:alert(1)"],
  ["a data: address", "data:text/html,<script>alert(1)</script>"],
  ["a data: image", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
  ["a file: address", "file:///etc/passwd"],
  ["an ftp: address", "ftp://files.example/a.png"],
  ["a mailto: address", "mailto:orders@example.org"],
  ["a blob: address", "blob:https://ok.example/1234"],
  ["a protocol-relative address", "//evil.example/x"],
  ["a plain word", "reorder"],
  ["http: with no host", "http://"],
  ["https: with an empty host", "https:///path"],
  ["http: without the two slashes", "http:example.com"],
  ["an address with a line break in it (the URL parser would drop it silently)", "https://ok.example/a\nb"],
  ["an address with a tab in it", "https://ok.example/a\tb"],
];

describe.each(ID_SHAPES)("vendor link and photo address on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let itemId: number;
  beforeEach(() => {
    fake = installFake(options);
    const { medications } = seedStandard(fake);
    itemId = itemNamed(medications, "Naproxen 220 mg").id;
  });

  describe.each(FIELDS)("$field", ({ field, label }) => {
    it.each(REFUSED)("refuses %s when an item is created: 400, the field name, a plain message, nothing stored", async (_what, value) => {
      const before = snapshotDb(fake);
      const res = await api.createItem({ barcode: "URL-NEW", name: "Url probe", [field]: value });
      expect(res.status).toBe(400);
      const body = await bodyRecord(res);
      expect(body.field).toBe(field);
      expect(errorTextOf(body)).toMatch(label);
      expect(errorTextOf(body)).toMatch(/https:\/\//);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it.each(REFUSED)("refuses %s when an item is edited: 400, the field name, nothing changes", async (_what, value) => {
      const before = snapshotDb(fake);
      const res = await api.updateItem(itemId, { [field]: value });
      expect(res.status).toBe(400);
      const body = await bodyRecord(res);
      expect(body.field).toBe(field);
      expect(errorTextOf(body)).toMatch(label);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it.each([
      ["a normal https address", "https://shop.example.com/reorder?item=naproxen&qty=2#top", "https://shop.example.com/reorder?item=naproxen&qty=2#top"],
      ["a normal http address", "http://shop.example.com/reorder", "http://shop.example.com/reorder"],
      ["a scheme in capital letters", "HTTPS://SHOP.EXAMPLE.COM/A", "HTTPS://SHOP.EXAMPLE.COM/A"],
      ["an address with spaces around it (trimmed)", " https://ok.example/a ", "https://ok.example/a"],
      ["an address with a port and credentials-free host", "https://ok.example:8443/a", "https://ok.example:8443/a"],
      ["an IP address host", "http://192.168.1.20/photos/1.png", "http://192.168.1.20/photos/1.png"],
      ["a Supabase Storage address shaped like the one /api/upload returns", STORAGE_URL, STORAGE_URL],
    ])("accepts %s, exactly as typed apart from the spaces around it, when creating and when editing", async (_what, typed, stored) => {
      const created = await api.createItem({ barcode: "URL-OK", name: "Url probe", [field]: typed });
      expect(created.status).toBe(201);
      expect(asRecord(await created.json())[field]).toBe(stored);

      const edited = await api.updateItem(itemId, { [field]: typed });
      expect(edited.status).toBe(200);
      expect(asRecord(await edited.json())[field]).toBe(stored);
      expect(storedMedication(fake, itemId)[field]).toBe(stored);
    });

    if (field === "photo_url") {
      it.each([
        ["a bare address", "shop.example.com/photo.png"],
        ["a bare host name", "shop.example.com"],
      ])("refuses %s: the browser would request it as a path on this site", async (_what, value) => {
        const before = snapshotDb(fake);
        const res = await api.updateItem(itemId, { photo_url: value });
        expect(res.status).toBe(400);
        expect((await bodyRecord(res)).field).toBe("photo_url");
        expect(snapshotDb(fake)).toEqual(before);
      });
    } else {
      it.each([
        ["a bare address with a path", "shop.example.com/reorder", "shop.example.com/reorder"],
        ["a bare host name", "shop.example.com", "shop.example.com"],
        ["a bare address with a query, with spaces around it", "  my-shop.example.org/a/b?c=d ", "my-shop.example.org/a/b?c=d"],
      ])("accepts %s, stored exactly as typed (every screen shows it as an https link), when creating and when editing", async (_what, typed, stored) => {
        const created = await api.createItem({ barcode: "URL-BARE", name: "Url probe", vendor_url: typed });
        expect(created.status).toBe(201);
        expect(asRecord(await created.json()).vendor_url).toBe(stored);
        const edited = await api.updateItem(itemId, { vendor_url: typed });
        expect(edited.status).toBe(200);
        expect(storedMedication(fake, itemId).vendor_url).toBe(stored);
      });

      it.each([
        ["a bare address that carries a scheme-like colon", "shop.example.com:8080/reorder"],
        ["a bare address with a line break", "shop.example.com/a\nb"],
        ["a bare address with a space inside", "shop.example.com/a b"],
      ])("still refuses %s", async (_what, value) => {
        const before = snapshotDb(fake);
        const res = await api.updateItem(itemId, { vendor_url: value });
        expect(res.status).toBe(400);
        expect((await bodyRecord(res)).field).toBe("vendor_url");
        expect(snapshotDb(fake)).toEqual(before);
      });
    }

    it.each([
      ["null", null],
      ["an empty string", ""],
      ["only spaces", "   "],
    ])("still clears the field when it is %s (an empty value is not an address)", async (_what, value) => {
      expect((await api.updateItem(itemId, { [field]: "https://ok.example/a" })).status).toBe(200);
      const cleared = await api.updateItem(itemId, { [field]: value });
      expect(cleared.status).toBe(200);
      expect(asRecord(await cleared.json())[field]).toBeNull();

      const created = await api.createItem({ barcode: "URL-EMPTY", [field]: value });
      expect(created.status).toBe(201);
      expect(asRecord(await created.json())[field]).toBeNull();
    });

    it("does not rewrite what is already stored: an item whose stored value would be refused today keeps it through an unrelated edit", async () => {
      // Written before this validation existed (or by the CSV import, which is not covered by it).
      fake.seedMedications([{ id: 7100, barcode: "LEGACY-URL", name: "Legacy", vendor_url: "javascript:alert(1)", photo_url: "data:text/html,legacy" }]);

      const res = await api.updateItem(7100, { stock: 12, notes: "Counted on the shelf" });
      expect(res.status).toBe(200);
      expect(storedMedication(fake, 7100)).toMatchObject({ vendor_url: "javascript:alert(1)", photo_url: "data:text/html,legacy", stock: 12 });

      const listed = asRecord((await (await api.getItem(7100)).json()) as unknown);
      expect(listed).toMatchObject({ vendor_url: "javascript:alert(1)", photo_url: "data:text/html,legacy" });

      // Sending the field is what validates it.
      expect((await api.updateItem(7100, { [field]: "javascript:alert(2)" })).status).toBe(400);
      expect(storedMedication(fake, 7100)).toMatchObject({ vendor_url: "javascript:alert(1)", photo_url: "data:text/html,legacy" });
    });

    it("keeps refusing a NUL character with its own message, as before (the database cannot store it)", async () => {
      const res = await api.updateItem(itemId, { [field]: "https://ok.example/a\u0000b" });
      expect(res.status).toBe(400);
      const body = await bodyRecord(res);
      expect(body.field).toBe(field);
      expect(errorTextOf(body)).toMatch(/null characters/i);
    });

    it("still refuses a value that is not text (a number or a list) as before, with the field name", async () => {
      for (const value of [5, ["https://ok.example"], { href: "https://ok.example" }, true]) {
        const res = await api.updateItem(itemId, { [field]: value });
        expect(res.status).toBe(400);
        expect((await bodyRecord(res)).field).toBe(field);
      }
    });
  });

  it("checks both addresses in one request and names the first one that is wrong", async () => {
    const res = await api.updateItem(itemId, { photo_url: STORAGE_URL, vendor_url: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect((await bodyRecord(res)).field).toBe("vendor_url");
    expect(storedMedication(fake, itemId).photo_url).not.toBe(STORAGE_URL);
  });
});
