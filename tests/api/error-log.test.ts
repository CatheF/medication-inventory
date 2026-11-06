// The browser gets plain words; the facts for whoever looks after the app are in the `technical` field AND in the server log
// line the routes write for a 403 or a 5xx. Without this test, a change that dropped the technical text from the item routes'
// log line would pass every other test, so this pins it for the item routes (the categories route has its own check).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFake, type FakeSupabase } from "../helpers/fake-supabase";
import { seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

let logged: string[];
let fake: FakeSupabase;

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map((arg) => String(arg)).join(" "));
  });
  fake = installFake();
  seedStandard(fake);
});

describe("the log line of a refused or failed item request carries the technical facts", () => {
  it("a refusal by row-level security (403): the route, the status, the code and the technical sentence", async () => {
    fake.failNext({ code: "42501", message: 'new row violates row-level security policy for table "medications"', details: "" }, { table: "medications", op: "insert" });
    const res = await api.createItem({ barcode: "LOG-403", name: "Log probe" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; technical?: string };
    expect(body.technical, "the browser answer carries the technical field").toBeTruthy();
    expect(body.error).not.toBe(body.technical);
    const line = logged.find((text) => text.includes("403"));
    expect(line, `a log line for the 403 (saw: ${JSON.stringify(logged)})`).toBeTruthy();
    expect(line).toContain("42501");
    expect(line).toContain(body.technical as string);
  });

  it("a database that cannot be reached (503): the technical sentence is in the log line", async () => {
    fake.failNext({ code: "", message: "TypeError: fetch failed", details: "" }, { table: "medications", op: "insert" });
    const res = await api.createItem({ barcode: "LOG-503", name: "Log probe" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = (await res.json()) as { technical?: string };
    expect(body.technical, "the browser answer carries the technical field").toBeTruthy();
    const line = logged.find((text) => text.includes(String(res.status)));
    expect(line, `a log line for the ${res.status} (saw: ${JSON.stringify(logged)})`).toBeTruthy();
    expect(line).toContain(body.technical as string);
  });
});
