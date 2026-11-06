// Playwright helper: when a browser test FAILS while the app's own page shows the Next.js development error overlay (a build
// error, a failed compile or a runtime error), say so. Without this, a half-edited source file on a shared dev server looks
// like a product failure ("element not found") and the real cause is only visible in a screenshot or error-context.md.
//
// It only ever speaks after a failure, so a passing run is never affected. It never throws on its own account: a page that is
// already closed, or that cannot be asked, simply says nothing.
import { test as base, type BrowserContext, type Page } from "@playwright/test";

/** The headings of the Next.js development overlay. A production build never renders any of them. */
const OVERLAY_HEADING = /Build Error|Failed to compile|Module not found|Unhandled Runtime Error|Runtime Error/;

/** How long a failing test may spend asking its pages; the explanation is a courtesy and must never hang a run. */
const ASK_TIMEOUT_MS = 3_000;

/**
 * The text of the Next.js error overlay on this page (first 300 characters), or null when the page has none.
 * The overlay lives inside the shadow roots of <nextjs-portal> elements, so ordinary text queries do not see it.
 */
export async function describeOverlay(page: Page): Promise<string | null> {
  if (page.isClosed()) return null;
  const ask = page.evaluate((source) => {
    const heading = new RegExp(source);
    const texts: string[] = [];
    for (const portal of Array.from(document.querySelectorAll("nextjs-portal"))) {
      const text = portal.shadowRoot?.textContent ?? "";
      if (heading.test(text)) texts.push(text.replace(/\s+/g, " ").trim());
    }
    return texts.length > 0 ? texts.join(" | ").slice(0, 300) : null;
  }, OVERLAY_HEADING.source);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ASK_TIMEOUT_MS));
  try {
    return await Promise.race([ask, timeout]);
  } catch {
    return null;
  }
}

/** The first overlay found on any page of the context, with the page's address, or null. */
export async function describeServerProblem(context: BrowserContext): Promise<string | null> {
  for (const page of context.pages()) {
    const overlay = await describeOverlay(page);
    if (overlay !== null) return `${page.url()} shows the Next.js error overlay: ${overlay}`;
  }
  return null;
}

/**
 * `test` with one automatic fixture: after a FAILED test it adds a second, clearly named error when the app server was
 * showing its error overlay, so the report says "the app server is broken" instead of leaving it to be guessed.
 */
export const test = base.extend<{ serverGuard: void }>({
  serverGuard: [
    async ({ context }, use, testInfo) => {
      await use();
      if (testInfo.status === testInfo.expectedStatus) return;
      const problem = await describeServerProblem(context);
      if (problem !== null) {
        throw new Error(
          `The app server itself reported a problem, so this failure is probably not about the behavior under test: ${problem}`
        );
      }
    },
    { auto: true },
  ],
});
