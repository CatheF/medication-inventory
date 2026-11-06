// The Order sheet's data hooks (app/order-sheet/hooks.ts), rendered by the real React with a fake `fetch`.
//
// What matters here:
//  * React Strict Mode (development only) runs every effect, undoes it and runs it again straight away. The first load must
//    be shared by both runs: ONE request per list, and nothing aborted (the browser reports an aborted request as
//    net::ERR_ABORTED, which showed up on every visit in development).
//  * A request nobody waits for any more (the page was left, or Retry started a newer attempt) is ignored when it answers.
//  * A failed request is an error with the server's own text, never an empty list; Retry asks again exactly once.
import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Category, Medication } from "@/lib/db";
import { STALE_AFTER_MS, useCategories, useMedications } from "@/app/order-sheet/hooks";

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

type Call = {
  url: string;
  signal: AbortSignal | null | undefined;
  answered: boolean;
  resolve: (response: FakeResponse) => void;
  reject: (reason: unknown) => void;
};

function med(id: number, name = `Item ${id}`): Medication {
  return {
    id,
    name,
    barcode: String(id).padStart(12, "0"),
    photo_url: null,
    stock: 5,
    threshold: 10,
    vendor_url: null,
    unit: "units",
    notes: null,
    category_id: null,
    supplier_order_number: null,
    is_unnamed: false,
    created_at: "2026-08-11T16:00:00+00:00",
    updated_at: "2026-10-28T16:02:00+00:00",
  };
}

function cat(id: string, name = `Category ${id}`): Category {
  return { id, name, created_at: null };
}

function reply(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A `fetch` that records every call and answers only when the test says so. */
function installFetch() {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const call: Call = {
        url,
        signal: init?.signal,
        answered: false,
        resolve: (response) => {
          call.answered = true;
          resolve(response as unknown as Response);
        },
        reject: (reason) => {
          call.answered = true;
          reject(reason);
        },
      };
      calls.push(call);
      // Like a browser: an aborted request fails with the reason the signal was aborted with (a TimeoutError for AbortSignal.timeout).
      init?.signal?.addEventListener("abort", () =>
        call.reject(init.signal?.reason instanceof DOMException ? init.signal.reason : new DOMException("The operation was aborted.", "AbortError"))
      );
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const urls = () => calls.map((call) => call.url);
  const pending = (url: string) => calls.filter((call) => call.url === url && !call.answered);
  return { calls, fetchMock, urls, pending };
}

type Hooks = { meds: ReturnType<typeof useMedications>; cats: ReturnType<typeof useCategories> };

const roots: Array<{ unmount(): void }> = [];

function mountProbe(options: { strict: boolean }) {
  const renders: Hooks[] = [];
  function Probe() {
    const meds = useMedications();
    const cats = useCategories();
    renders.push({ meds, cats });
    return null;
  }
  // React DOM only needs something that looks like an element: the probe renders null, so no DOM node is ever created.
  const container = { nodeType: 1, tagName: "DIV", addEventListener() {}, removeEventListener() {}, ownerDocument: null } as unknown as Element;
  const root = createRoot(container);
  roots.push(root);
  return {
    renders,
    get latest(): Hooks {
      return renders[renders.length - 1];
    },
    render: () =>
      act(async () => {
        root.render(options.strict ? createElement(StrictMode, null, createElement(Probe)) : createElement(Probe));
      }),
    unmount: () =>
      act(async () => {
        root.unmount();
      }),
  };
}

/** Lets every pending promise continuation run (the hook awaits fetch, then response.json(), then sets state). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function answer(call: Call | undefined, status: number, body: unknown) {
  expect(call, "a request was waiting for an answer").toBeDefined();
  await act(async () => {
    call!.resolve(reply(status, body));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The hooks listen for "the person came back to this tab" on the document and the window.
  vi.stubGlobal("window", Object.assign(new EventTarget(), { HTMLIFrameElement: class {} }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    try {
      await act(async () => {
        root.unmount();
      });
    } catch {
      // already unmounted
    }
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("first load", () => {
  it("React Strict Mode runs the effect twice, but each list is requested ONCE and nothing is aborted", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();

    expect(net.urls().sort()).toEqual(["/api/categories", "/api/medications"]);
    for (const call of net.calls) expect(call.signal?.aborted ?? false, call.url).toBe(false);
    expect(view.latest.meds.state).toEqual({ status: "loading" });
    expect(view.latest.cats.state).toEqual({ status: "loading" });

    await answer(net.pending("/api/medications")[0], 200, [med(1), med(2)]);
    await answer(net.pending("/api/categories")[0], 200, [cat("a")]);
    expect(net.calls).toHaveLength(2); // still two requests in total
    const meds = view.latest.meds.state;
    expect(meds.status).toBe("ready");
    if (meds.status === "ready") {
      expect(meds.data.map((m) => m.id)).toEqual([1, 2]);
      expect(typeof meds.loadedAt).toBe("number");
    }
    expect(view.latest.cats.state).toMatchObject({ status: "ready", data: [{ id: "a" }] });
    for (const call of net.calls) expect(call.signal?.aborted ?? false, call.url).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it("without Strict Mode (production) it is the same: one request per list", async () => {
    const net = installFetch();
    const view = mountProbe({ strict: false });
    await view.render();
    expect(net.urls().sort()).toEqual(["/api/categories", "/api/medications"]);
    await answer(net.pending("/api/medications")[0], 200, [med(7)]);
    expect(view.latest.meds.state).toMatchObject({ status: "ready", data: [{ id: 7 }] });
  });

  it("asks the server for fresh data: no cache, JSON", async () => {
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    const init = net.fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual({ Accept: "application/json" });
    expect(init.method).toBeUndefined(); // a plain read
  });
});

describe("a request nobody waits for any more is ignored, never applied", () => {
  it("leaving the page before the answer arrives: the late answer changes nothing and raises no error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    const rendersBefore = view.renders.length;
    await view.unmount();

    await answer(net.pending("/api/medications")[0], 200, [med(1)]);
    await answer(net.pending("/api/categories")[0], 500, { error: "Unexpected database error." });
    expect(view.renders.length).toBe(rendersBefore); // no state update reached the (gone) component
    expect(net.calls).toHaveLength(2); // and nothing was asked again
    expect(errors).not.toHaveBeenCalled();
  });

  it("Retry while an older request is still on its way: only the newer answer counts, even if the older one arrives last", async () => {
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    const older = net.pending("/api/medications")[0];

    await act(async () => {
      view.latest.meds.reload();
    });
    expect(view.latest.meds.state).toEqual({ status: "loading" });
    const newer = net.pending("/api/medications").find((call) => call !== older);
    expect(newer, "Retry made a new request").toBeDefined();

    await answer(newer, 200, [med(2, "From the newer request")]);
    expect(view.latest.meds.state).toMatchObject({ status: "ready", data: [{ id: 2, name: "From the newer request" }] });
    await answer(older, 200, [med(1, "From the older request")]); // slow answer to the attempt that was replaced
    expect(view.latest.meds.state).toMatchObject({ status: "ready", data: [{ id: 2, name: "From the newer request" }] });
  });
});

describe("failures are errors with the server's words, never an empty list", () => {
  it.each<[string, number, unknown, string]>([
    ["the server's own error text", 500, { error: "Unexpected database error.", code: "XX000" }, "Unexpected database error."],
    [
      "the database being unreachable",
      503,
      { error: "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused." },
      "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused.",
    ],
    ["an error without JSON text", 502, "<html>Bad gateway</html>", "The server answered with an error (HTTP 502). Try again."],
    ["a blank error text", 500, { error: "   " }, "The server answered with an error (HTTP 500). Try again."],
    ["a list that is not a list", 200, { not: "a list" }, "The server sent data this page doesn’t understand. Try again."],
    ["a list with an entry this page cannot read (nothing is silently dropped)", 200, [med(1), { id: "x" }], "The server sent data this page doesn’t understand. Try again."],
  ])("%s", async (_label, status, body, message) => {
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    await answer(net.pending("/api/medications")[0], status, body);
    expect(view.latest.meds.state).toEqual({ status: "error", message });
    // the categories list is separate: it is still loading
    expect(view.latest.cats.state).toEqual({ status: "loading" });
  });

  it("a network failure says so (and is not an empty inventory)", async () => {
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    await act(async () => {
      net.pending("/api/medications")[0].reject(new TypeError("Failed to fetch"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.latest.meds.state).toEqual({ status: "error", message: "Can’t reach the server. Check your internet connection and try again." });
  });

  it("Retry shows the loading state, asks exactly once more, and recovers", async () => {
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    await answer(net.pending("/api/medications")[0], 500, { error: "Unexpected database error." });
    expect(view.latest.meds.state.status).toBe("error");
    const before = net.urls().filter((url) => url === "/api/medications").length;
    expect(before).toBe(1);

    await act(async () => {
      view.latest.meds.reload();
    });
    expect(view.latest.meds.state).toEqual({ status: "loading" });
    expect(net.urls().filter((url) => url === "/api/medications")).toHaveLength(2);

    await answer(net.pending("/api/medications")[0], 200, [med(3)]);
    expect(view.latest.meds.state).toMatchObject({ status: "ready", data: [{ id: 3 }] });
    expect(net.urls().filter((url) => url === "/api/medications")).toHaveLength(2); // no extra request appeared
    for (const call of net.calls) expect(call.signal?.aborted ?? false, call.url).toBe(false);
  });

  it("Retry after a failure of the SECOND attempt works the same way (each attempt is its own request)", async () => {
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    await answer(net.pending("/api/medications")[0], 500, { error: "first" });
    await act(async () => {
      view.latest.meds.reload();
    });
    await answer(net.pending("/api/medications")[0], 500, { error: "second" });
    expect(view.latest.meds.state).toEqual({ status: "error", message: "second" });
    await act(async () => {
      view.latest.meds.reload();
    });
    await answer(net.pending("/api/medications")[0], 200, [med(9)]);
    expect(view.latest.meds.state).toMatchObject({ status: "ready", data: [{ id: 9 }] });
    expect(net.urls().filter((url) => url === "/api/medications")).toHaveLength(3);
  });
});

describe("refresh (Refresh button and coming back to the tab)", () => {
  async function readyView() {
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    await answer(net.pending("/api/medications")[0], 200, [med(1, "Before")]);
    await answer(net.pending("/api/categories")[0], 200, []);
    return { net, view };
  }

  it("fetches again without the loading state and replaces the list; resolves true", async () => {
    const { net, view } = await readyView();
    let outcome: Promise<boolean> | undefined;
    await act(async () => {
      outcome = view.latest.meds.refresh();
    });
    expect(view.latest.meds.refreshing).toBe(true);
    expect(view.latest.meds.state.status).toBe("ready"); // the old list stays on screen
    await answer(net.pending("/api/medications")[0], 200, [med(1, "After")]);
    await expect(outcome).resolves.toBe(true);
    expect(view.latest.meds.refreshing).toBe(false);
    expect(view.latest.meds.state).toMatchObject({ status: "ready", data: [{ name: "After" }] });
  });

  it("a failed refresh keeps the old list and resolves false", async () => {
    const { net, view } = await readyView();
    let outcome: Promise<boolean> | undefined;
    await act(async () => {
      outcome = view.latest.meds.refresh();
    });
    await answer(net.pending("/api/medications")[0], 503, { error: "Can’t reach the database." });
    await expect(outcome).resolves.toBe(false);
    expect(view.latest.meds.state).toMatchObject({ status: "ready", data: [{ name: "Before" }] });
    expect(view.latest.meds.refreshing).toBe(false);
  });

  it("a second refresh while one is running joins it (one request)", async () => {
    const { net, view } = await readyView();
    const before = net.calls.length;
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    await act(async () => {
      first = view.latest.meds.refresh();
      second = view.latest.meds.refresh();
    });
    expect(second).toBe(first);
    expect(net.calls.length).toBe(before + 1);
    await answer(net.pending("/api/medications")[0], 200, [med(1)]);
    await expect(first).resolves.toBe(true);
  });

  it("coming back to the tab re-reads the inventory only after it has been away for 30 seconds", async () => {
    const { net, view } = await readyView();
    const medsRequests = () => net.urls().filter((url) => url === "/api/medications").length;
    expect(medsRequests()).toBe(1);
    const readyAt = view.latest.meds.state.status === "ready" ? view.latest.meds.state.loadedAt : 0;
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(readyAt + STALE_AFTER_MS - 1_000); // 29 s: an alt-tab does not cost a request
    await act(async () => {
      (window as unknown as EventTarget).dispatchEvent(new Event("focus"));
    });
    expect(medsRequests()).toBe(1);

    now.mockReturnValue(readyAt + STALE_AFTER_MS + 1_000); // 31 s: read again
    await act(async () => {
      (window as unknown as EventTarget).dispatchEvent(new Event("focus"));
    });
    expect(medsRequests()).toBe(2);
    await answer(net.pending("/api/medications")[0], 200, [med(1, "Fresh")]);
    expect(view.latest.meds.state).toMatchObject({ status: "ready", data: [{ name: "Fresh" }] });
    await settle();
  });
});

// ── A request that never answers ──────────────────────────────────────────────────────────────────────────────────
// The Home page and Admin give up on a read after 30 seconds (AbortSignal.timeout) and show an error with Retry. A paused or
// half-reachable database is exactly the case where a request is accepted and then never answered: without a limit the
// Order sheet would say "Loading the inventory…" for ever, with no Retry.
describe("a request that never answers (30-second limit)", () => {
  /** AbortSignal.timeout under the test's control: it records the delay it was asked for and runs out only when told to. */
  function installTimeLimits() {
    const limits: Array<{ ms: number; signal: AbortSignal; expire(): void }> = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      limits.push({
        ms,
        signal: controller.signal,
        expire: () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
      });
      return controller.signal;
    });
    return {
      limits,
      /** The time limit of one request runs out (what the browser does 30 seconds after the request was sent). */
      async expire(call: Call | undefined) {
        const limit = limits.find((candidate) => candidate.signal === call?.signal);
        expect(limit, `${call?.url ?? "the request"} was sent with a time limit`).toBeDefined();
        await act(async () => {
          limit?.expire();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      },
    };
  }

  const TOO_SLOW_INVENTORY = "The server took too long to answer while loading the inventory.";

  it("both lists are read with a 30-second time limit, ONE limit per request even though React Strict Mode runs the effect twice", async () => {
    const time = installTimeLimits();
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();

    expect(net.calls).toHaveLength(2);
    for (const call of net.calls) expect(call.signal, `${call.url} carries a time limit`).toBeInstanceOf(AbortSignal);
    expect(time.limits.map((limit) => limit.ms)).toEqual([30_000, 30_000]);
    for (const call of net.calls) expect(call.signal?.aborted ?? false, `${call.url} is not aborted by React`).toBe(false);
  });

  it("a request nobody answers ends in the plain 'took too long' error (not a spinner for ever), the categories are unaffected, and Retry asks once more and recovers", async () => {
    const time = installTimeLimits();
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    expect(view.latest.meds.state).toEqual({ status: "loading" });

    await time.expire(net.pending("/api/medications")[0]);
    expect(view.latest.meds.state).toEqual({ status: "error", message: TOO_SLOW_INVENTORY });
    expect(view.latest.cats.state).toEqual({ status: "loading" }); // its own request, its own limit

    await act(async () => {
      view.latest.meds.reload();
    });
    expect(view.latest.meds.state).toEqual({ status: "loading" });
    expect(net.urls().filter((url) => url === "/api/medications")).toHaveLength(2);
    await answer(net.pending("/api/medications")[0], 200, [med(4)]);
    expect(view.latest.meds.state).toMatchObject({ status: "ready", data: [{ id: 4 }] });
    expect(net.urls().filter((url) => url === "/api/medications")).toHaveLength(2); // Retry made exactly one more request
  });

  it("a categories list nobody answers ends in an error as well, so the page stops waiting for category names", async () => {
    const time = installTimeLimits();
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    await time.expire(net.pending("/api/categories")[0]);
    expect(view.latest.cats.state).toEqual({ status: "error", message: "The server took too long to answer while loading the category list." });
    expect(view.latest.meds.state).toEqual({ status: "loading" });
  });

  it("an answer whose body never finishes arriving is a timeout too (not 'data this page doesn’t understand')", async () => {
    const time = installTimeLimits();
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    const call = net.pending("/api/medications")[0];
    await act(async () => {
      call.resolve({
        ok: true,
        status: 200,
        // The headers came, the body stalls; the browser fails the read when the signal runs out.
        json: () =>
          new Promise<unknown>((_resolve, reject) => {
            call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
          }),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.latest.meds.state).toEqual({ status: "loading" });
    await time.expire(call);
    expect(view.latest.meds.state).toEqual({ status: "error", message: TOO_SLOW_INVENTORY });
  });

  it("a request the browser aborts (AbortError) is an error too: the page never keeps loading", async () => {
    installTimeLimits();
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    await act(async () => {
      net.pending("/api/medications")[0].reject(new DOMException("The user aborted a request.", "AbortError"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.latest.meds.state).toEqual({ status: "error", message: TOO_SLOW_INVENTORY });
  });

  it("where the browser has no AbortSignal.timeout (an old browser) the request is simply sent without a limit, like on the Home page, and everything else works", async () => {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    Reflect.deleteProperty(AbortSignal, "timeout");
    try {
      expect("timeout" in AbortSignal).toBe(false);
      const net = installFetch();
      const view = mountProbe({ strict: true });
      await view.render();
      expect(net.calls).toHaveLength(2);
      for (const call of net.calls) expect(call.signal ?? null, `${call.url} is sent without a time limit`).toBeNull();
      await answer(net.pending("/api/medications")[0], 200, [med(1)]);
      expect(view.latest.meds.state).toMatchObject({ status: "ready", data: [{ id: 1 }] });
    } finally {
      if (original) Object.defineProperty(AbortSignal, "timeout", original);
    }
  });

  it("a refresh that runs out of time resolves false, keeps the list that is on screen and is no longer 'refreshing' (the Refresh button works again)", async () => {
    const time = installTimeLimits();
    const net = installFetch();
    const view = mountProbe({ strict: true });
    await view.render();
    await answer(net.pending("/api/medications")[0], 200, [med(1, "Before")]);
    await answer(net.pending("/api/categories")[0], 200, []);

    let outcome: Promise<boolean> | undefined;
    await act(async () => {
      outcome = view.latest.meds.refresh();
    });
    expect(view.latest.meds.refreshing).toBe(true);
    await time.expire(net.pending("/api/medications")[0]);
    await expect(outcome).resolves.toBe(false);
    expect(view.latest.meds.refreshing).toBe(false);
    expect(view.latest.meds.state).toMatchObject({ status: "ready", data: [{ name: "Before" }] });

    // and the next refresh is a fresh request with its own limit (it did not join the one that ran out)
    await act(async () => {
      void view.latest.meds.refresh();
    });
    expect(net.pending("/api/medications")).toHaveLength(1);
  });
});
