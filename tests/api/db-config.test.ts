// Requirement-driven tests: how the app finds its database, lib/db.ts (SPEC 2.1; TASK.md section 7 lists "environment/
// database mismatches" as a way inventory can seem to disappear; the owner said the Vercel integration with Supabase
// will be used, and that integration may expose the public key under either of two names).
//
// Every other API test replaces '@/lib/db' with the in-memory fake, so without this file nothing would notice if the app
// stopped reading the key the hosting integration provides, or started without a key and failed later and obscurely.
//
// Contract checked here (no real Supabase project is contacted: '@supabase/supabase-js' is replaced by a spy):
//   * the client is created from NEXT_PUBLIC_SUPABASE_URL and a PUBLIC key, nothing else;
//   * the key is NEXT_PUBLIC_SUPABASE_ANON_KEY, or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY when the first is not set;
//   * when the URL or the key is missing the app refuses to start with a message that names the missing settings,
//     creates no half-configured client, and never prints a URL or key value.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createClientSpy = vi.hoisted(() => vi.fn());
vi.mock("@supabase/supabase-js", () => ({ createClient: createClientSpy }));

const URL_VARIABLE = "NEXT_PUBLIC_SUPABASE_URL";
const ANON_KEY_VARIABLE = "NEXT_PUBLIC_SUPABASE_ANON_KEY";
const PUBLISHABLE_KEY_VARIABLE = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";
const PROJECT_URL = "https://synthetic-project-ref.example.invalid";
const ANON_KEY = "synthetic-anon-key-AAAA";
const PUBLISHABLE_KEY = "synthetic-publishable-key-BBBB";

type Settings = { url?: string; anon?: string; publishable?: string };

/** Sets exactly these three variables (an omitted one is removed from the environment, "" is set but empty). */
function setEnvironment({ url, anon, publishable }: Settings): void {
  vi.stubEnv(URL_VARIABLE, url);
  vi.stubEnv(ANON_KEY_VARIABLE, anon);
  vi.stubEnv(PUBLISHABLE_KEY_VARIABLE, publishable);
}

/** Loads lib/db.ts afresh (it creates its client while it is being imported). */
async function loadDb(): Promise<typeof import("@/lib/db")> {
  vi.resetModules();
  return import("@/lib/db");
}

/** The message lib/db.ts refuses to start with ("" if it did start). */
async function startupError(): Promise<string> {
  try {
    await loadDb();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

beforeEach(() => {
  vi.unstubAllEnvs();
  createClientSpy.mockReset();
  createClientSpy.mockReturnValue({ synthetic: "client" });
});

afterEach(() => {
  vi.unstubAllEnvs(); // leave the environment as it was found, whatever runs next in this process
});

describe("lib/db.ts reads the public Supabase settings", () => {
  it("connects with the project URL and NEXT_PUBLIC_SUPABASE_ANON_KEY", async () => {
    setEnvironment({ url: PROJECT_URL, anon: ANON_KEY });
    await loadDb();
    expect(createClientSpy).toHaveBeenCalledTimes(1);
    expect(createClientSpy).toHaveBeenCalledWith(PROJECT_URL, ANON_KEY);
  });

  it("connects with NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, the name the Supabase/Vercel integration may use, when no anon key is set", async () => {
    setEnvironment({ url: PROJECT_URL, publishable: PUBLISHABLE_KEY });
    await loadDb();
    expect(createClientSpy).toHaveBeenCalledWith(PROJECT_URL, PUBLISHABLE_KEY);
  });

  it("treats an EMPTY anon key (a variable that exists but has no value) as not set and uses the publishable key", async () => {
    setEnvironment({ url: PROJECT_URL, anon: "", publishable: PUBLISHABLE_KEY });
    await loadDb();
    expect(createClientSpy).toHaveBeenCalledWith(PROJECT_URL, PUBLISHABLE_KEY);
  });

  it("uses the anon key when both names are set, so a deployment that has always worked keeps working", async () => {
    setEnvironment({ url: PROJECT_URL, anon: ANON_KEY, publishable: PUBLISHABLE_KEY });
    await loadDb();
    expect(createClientSpy).toHaveBeenCalledWith(PROJECT_URL, ANON_KEY);
  });

  it("exports the client it created, so every API route talks to the configured project", async () => {
    setEnvironment({ url: PROJECT_URL, anon: ANON_KEY });
    const client = { synthetic: "the one and only client" };
    createClientSpy.mockReturnValue(client);
    const { supabase } = await loadDb();
    expect(supabase).toBe(client);
  });

  it.each(["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY", "SUPABASE_SECRET_KEY"])(
    "never runs with a secret key, even when %s is in the environment: the app uses the public key and the database's row-level security rules",
    async (secretName) => {
      setEnvironment({ url: PROJECT_URL, anon: ANON_KEY });
      vi.stubEnv(secretName, "synthetic-SECRET-key-CCCC");
      await loadDb();
      expect(createClientSpy).toHaveBeenCalledWith(PROJECT_URL, ANON_KEY);
      expect(JSON.stringify(createClientSpy.mock.calls)).not.toContain("SECRET");
    }
  );

  it("never falls back to a secret key when the public key is missing: it refuses to start instead", async () => {
    setEnvironment({ url: PROJECT_URL });
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-SECRET-key-CCCC");
    expect(await startupError()).not.toBe("");
    expect(createClientSpy).not.toHaveBeenCalled();
  });
});

describe("lib/db.ts refuses to start when the settings are missing (a loud failure, not an app that fails later and obscurely)", () => {
  it.each([
    ["no key at all", { url: PROJECT_URL }],
    ["empty key variables", { url: PROJECT_URL, anon: "", publishable: "" }],
  ])("%s: the error names BOTH key variables, so whoever fixes the deployment knows what to set", async (_label, settings) => {
    setEnvironment(settings);
    const message = await startupError();
    expect(message).toContain(ANON_KEY_VARIABLE);
    expect(message).toContain(PUBLISHABLE_KEY_VARIABLE);
  });

  it.each([
    ["no URL at all", { anon: ANON_KEY }],
    ["an empty URL", { url: "", anon: ANON_KEY }],
    ["no URL when only the publishable key is set", { publishable: PUBLISHABLE_KEY }],
  ])("%s: the error names the URL variable", async (_label, settings) => {
    setEnvironment(settings);
    expect(await startupError()).toContain(URL_VARIABLE);
  });

  it("nothing at all is set: it refuses to start, and says where the settings belong", async () => {
    setEnvironment({});
    const message = await startupError();
    expect(message).toMatch(/Missing/);
    expect(message).toContain(URL_VARIABLE);
    expect(message).toMatch(/\.env\.local|hosting environment/);
  });

  it.each([
    ["no key", { url: PROJECT_URL }],
    ["no URL", { anon: ANON_KEY }],
    ["nothing", {}],
  ])("creates no database client when there is %s (never a client pointing at 'undefined')", async (_label, settings) => {
    setEnvironment(settings);
    expect(await startupError()).not.toBe("");
    expect(createClientSpy).not.toHaveBeenCalled();
  });

  it("does not repeat the URL or the key value in the error message (credentials must not reach logs or the screen)", async () => {
    setEnvironment({ url: PROJECT_URL });
    expect(await startupError()).not.toContain("synthetic-project-ref");

    setEnvironment({ anon: ANON_KEY });
    expect(await startupError()).not.toContain("synthetic-anon-key");

    setEnvironment({ publishable: PUBLISHABLE_KEY });
    expect(await startupError()).not.toContain("synthetic-publishable-key");
  });
});
