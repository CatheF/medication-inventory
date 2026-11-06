// Requirement-driven tests: cross-site "simple" POSTs are refused.
//
// The app has no login. A web page that a staff member visits could fire POST /api/medications (junk items),
// POST /api/categories or POST /api/order-sheet/xlsx at it without any permission check from the browser, because a POST
// with Content-Type text/plain needs no CORS preflight, and the routes parsed the body as JSON whatever its type.
// The three POST routes this work added or changed now require Content-Type: application/json (415 otherwise) and refuse
// a request the browser marks Sec-Fetch-Site: cross-site (403). The routes this work did not touch (transactions, import,
// upload) are deliberately NOT covered, and these tests say so.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bodyRecord, errorTextOf, ID_SHAPES, itemNamed } from "../helpers/api-test-kit";
import { installFake, type FakeSupabase } from "../helpers/fake-supabase";
import { seedStandard } from "../helpers/fixtures-extra";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

import { POST as categoriesPost } from "@/app/api/categories/route";
import { POST as importPost } from "@/app/api/import/route";
import { POST as transactionsPost } from "@/app/api/transactions/route";
import { PUT as medicationPut } from "@/app/api/medications/[id]/route";
import { POST as medicationsPost } from "@/app/api/medications/route";
import { POST as exportPost } from "@/app/api/order-sheet/xlsx/route";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type Target = {
  name: string;
  url: string;
  call: (request: NextRequest) => Promise<Response>;
  /** A body the route accepts when the request itself is acceptable. */
  body: (itemId: number) => unknown;
  /** The success status. */
  ok: number;
  /** Which calls to the fake database prove the route did nothing (writes for the two that write, any call for the export). */
  didNothing: (fake: FakeSupabase) => boolean;
};

const TARGETS: Target[] = [
  {
    name: "POST /api/categories",
    url: "/api/categories",
    call: (request) => categoriesPost(request),
    body: () => ({ name: "Guard probe" }),
    ok: 201,
    didNothing: (fake) => fake.calls.length === 0,
  },
  {
    name: "POST /api/medications",
    url: "/api/medications",
    call: (request) => medicationsPost(request),
    body: () => ({ barcode: "GUARD-1", name: "Guard probe" }),
    ok: 201,
    didNothing: (fake) => fake.calls.length === 0,
  },
  {
    name: "POST /api/order-sheet/xlsx",
    url: "/api/order-sheet/xlsx",
    call: (request) => exportPost(request),
    body: (itemId) => ({ date: "2026-11-05", rows: [{ id: itemId, qty: "2", unit: "box" }] }),
    ok: 200,
    didNothing: (fake) => fake.calls.length === 0,
  },
];

function post(url: string, body: unknown, headers: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe.each(ID_SHAPES)("the request guard on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let itemId: number;
  beforeEach(() => {
    fake = installFake(options);
    const { medications } = seedStandard(fake);
    itemId = itemNamed(medications, "Naproxen 220 mg").id;
    fake.clearCalls();
  });

  describe.each(TARGETS)("$name", (target) => {
    const send = (headers: Record<string, string>) => target.call(post(target.url, target.body(itemId), headers));

    describe("a body that is not declared as JSON is refused with 415 and nothing happens", () => {
      it.each([
        ["no Content-Type at all", {}],
        ["text/plain (what a cross-site form or fetch can send without asking)", { "content-type": "text/plain" }],
        ["text/plain with a charset", { "content-type": "text/plain;charset=UTF-8" }],
        ["application/x-www-form-urlencoded", { "content-type": "application/x-www-form-urlencoded" }],
        ["multipart/form-data", { "content-type": "multipart/form-data; boundary=----x" }],
        ["application/xml", { "content-type": "application/xml" }],
        ["application/jsonp", { "content-type": "application/jsonp" }],
        ["application/json-patch+json", { "content-type": "application/json-patch+json" }],
        ["an empty Content-Type", { "content-type": "" }],
      ])("%s", async (_label, headers) => {
        const res = await send(headers);
        expect(res.status).toBe(415);
        expect(res.headers.get("content-type")).toMatch(/json/);
        const message = errorTextOf(await res.json());
        expect(message).toMatch(/JSON/);
        expect(message).toMatch(/application\/json/);
        expect(target.didNothing(fake)).toBe(true);
        expect(fake.writes()).toEqual([]);
      });
    });

    describe("a request the browser marks as coming from another site is refused with 403 and nothing happens", () => {
      it.each([
        ["with a JSON body", { "content-type": "application/json", "sec-fetch-site": "cross-site" }],
        ["with the header in capital letters", { "content-type": "application/json", "Sec-Fetch-Site": "Cross-Site" }],
        ["even when the body is plain text as well (refused as cross-site first)", { "content-type": "text/plain", "sec-fetch-site": "cross-site" }],
        ["with no Content-Type", { "sec-fetch-site": "cross-site" }],
      ])("%s", async (_label, headers) => {
        const res = await send(headers);
        expect(res.status).toBe(403);
        expect(res.headers.get("content-type")).toMatch(/json/);
        expect(errorTextOf(await res.json())).toMatch(/another website/i);
        expect(target.didNothing(fake)).toBe(true);
        expect(fake.writes()).toEqual([]);
      });
    });

    describe("a normal request from the app still works", () => {
      it.each([
        ["application/json", { "content-type": "application/json" }],
        ["application/json; charset=utf-8", { "content-type": "application/json; charset=utf-8" }],
        ["Application/JSON in capital letters", { "content-type": "Application/JSON" }],
        ["a same-origin request (what the app's own pages send)", { "content-type": "application/json", "sec-fetch-site": "same-origin" }],
        ["a same-site request", { "content-type": "application/json", "sec-fetch-site": "same-site" }],
        ["a request typed into the address bar or sent by a tool (none)", { "content-type": "application/json", "sec-fetch-site": "none" }],
        ["a script or curl that sends no Sec-Fetch-Site header", { "content-type": "application/json" }],
      ])("%s", async (_label, headers) => {
        const res = await send(headers);
        expect(res.status).toBe(target.ok);
      });
    });
  });

  it("the reported attack: a cross-site text/plain POST can no longer create an item", async () => {
    const before = fake.dump("medications").length;
    const attack = new NextRequest("http://localhost/api/medications", {
      method: "POST",
      headers: { "content-type": "text/plain", "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      body: JSON.stringify({ barcode: "JUNK-1", name: "Junk" }),
    });
    expect((await medicationsPost(attack)).status).toBe(403);
    // An old browser sends no Sec-Fetch-Site: the content type alone still stops the "simple request".
    const oldBrowser = new NextRequest("http://localhost/api/medications", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body: JSON.stringify({ barcode: "JUNK-2", name: "Junk" }),
    });
    expect((await medicationsPost(oldBrowser)).status).toBe(415);
    expect(fake.dump("medications")).toHaveLength(before);
  });

  it("a malformed body is still a 400 (not a 415) once the request is declared as JSON, with every message unchanged", async () => {
    const bad = (url: string, call: (request: NextRequest) => Promise<Response>) =>
      call(new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }));
    const categories = await bad("/api/categories", categoriesPost);
    expect([categories.status, errorTextOf(await categories.json())]).toEqual([400, "Request body must be valid JSON."]);
    const items = await bad("/api/medications", medicationsPost);
    expect([items.status, errorTextOf(await items.json())]).toEqual([400, "Request body must be valid JSON."]);
    const sheet = await bad("/api/order-sheet/xlsx", exportPost);
    expect([sheet.status, errorTextOf(await sheet.json())]).toEqual([400, "The request body must be valid JSON."]);
  });

  it.each([
    ["not a number", "abc"],
    ["empty", ""],
    ["negative", "-5"],
    ["a decimal", "12.5"],
  ])("ignores a Content-Length that is %s and measures the body once it is read", async (_label, header) => {
    const request = new NextRequest("http://localhost/api/medications", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": header },
      body: JSON.stringify({ barcode: "ODD-LENGTH-1" }),
    });
    expect((await medicationsPost(request)).status).toBe(201);
  });

  it("only the three POST routes are guarded: PUT needs a CORS preflight in a browser anyway and keeps its behavior", async () => {
    const put = new NextRequest(`http://localhost/api/medications/${itemId}`, { method: "PUT", body: JSON.stringify({ stock: 5 }) });
    const res = await medicationPut(put, { params: Promise.resolve({ id: String(itemId) }) });
    expect(res.status).toBe(200);
    expect((await bodyRecord(res)).stock).toBe(5);
  });

  it("the routes this work did not touch are NOT covered (documented): CSV import still accepts the content type it always did", async () => {
    const csv = new NextRequest("http://localhost/api/import", { method: "POST", body: "name,barcode,stock\nGuard CSV,GUARD-CSV,3\n" });
    expect((await importPost(csv)).status).toBe(200);
  });

  it("the routes this work did not touch are NOT covered (documented): a cross-site text/plain POST can still record a stock change", async () => {
    // Known gap, left as it was on purpose: /api/transactions, /api/import and /api/upload were not changed by this work. If this
    // test starts failing, the guard was extended to /api/transactions (every page that calls it already sends application/json):
    // update this note and the handoff report deliberately.
    const before = fake.dump("medications").find((row) => row.id === itemId)?.stock;
    const attack = new NextRequest("http://localhost/api/transactions", {
      method: "POST",
      headers: { "content-type": "text/plain", "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      body: JSON.stringify({ medication_id: itemId, type: "receive", quantity: 1 }),
    });
    expect((await transactionsPost(attack)).status).toBe(201);
    expect(fake.dump("medications").find((row) => row.id === itemId)?.stock).toBe(Number(before) + 1);
  });
});

describe("which routes use the guard", () => {
  const used = (file: string): boolean => /rejectUnsafeRequest/.test(readFileSync(path.join(REPO_ROOT, file), "utf8"));

  it.each(["app/api/categories/route.ts", "app/api/medications/route.ts", "app/api/order-sheet/xlsx/route.ts"])("%s uses the shared guard", (file) => {
    expect(used(file)).toBe(true);
  });

  it.each(["app/api/transactions/route.ts", "app/api/import/route.ts", "app/api/upload/route.ts", "app/api/analytics/route.ts"])(
    "%s is untouched by this work and does not use it",
    (file) => {
      expect(used(file)).toBe(false);
    }
  );
});
