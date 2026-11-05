// Shared Tailwind class strings for the Order sheet page, so every control has the same size (44px high), the
// same visible keyboard focus and the same colors as the rest of the app (blue-700 primary buttons, white
// rounded-xl bordered cards). Plain strings: Tailwind finds the class names because they are written out in full.

export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

export const CARD = "rounded-xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6";
export const H2 = "text-lg font-semibold text-gray-900";
export const LABEL = "mb-1.5 block text-sm font-medium text-gray-800";
export const HELP = "mt-1.5 text-sm text-gray-600";

// The trailing "!" on the placeholder color is deliberate: app/globals.css has an older, unlayered `::placeholder`
// rule (#9ca3af, 2.5:1 on white) that otherwise beats this layered utility. gray-500 is 4.8:1, which passes WCAG AA.
export const INPUT =
  "min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 " +
  "placeholder:text-gray-500! focus-visible:border-blue-600 focus-visible:outline-2 focus-visible:outline-offset-0 " +
  "focus-visible:outline-blue-600";

/** Same as INPUT with a red border, for a value that is not valid (the message next to it says why). */
export const INPUT_INVALID =
  "min-h-11 w-full rounded-lg border border-red-600 bg-white px-3 py-2 text-base text-gray-900 " +
  "placeholder:text-gray-500! focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-red-600";

/**
 * For a <Notice> that has buttons (Retry, Dismiss). On a narrow screen the buttons would squeeze the message into a very
 * tall, narrow column; this lets them wrap onto their own line below it. The message keeps at least 10rem, so nothing
 * overflows at 320px. Wide screens are unchanged (everything fits on one line).
 */
export const WRAP_ACTIONS = "flex-wrap [&>div:first-of-type]:min-w-40";

const BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold " +
  "transition-colors disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-blue-600";

export const BTN_PRIMARY = `${BUTTON} bg-blue-700 text-white hover:bg-blue-800 disabled:bg-gray-200 disabled:text-gray-600 disabled:hover:bg-gray-200`;
export const BTN_SECONDARY = `${BUTTON} border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 disabled:text-gray-500 disabled:hover:bg-white`;
export const BTN_DANGER = `${BUTTON} border border-red-300 bg-white text-red-700 hover:bg-red-50 disabled:border-gray-300 disabled:text-gray-500 disabled:hover:bg-white`;
export const BTN_DANGER_SOLID = `${BUTTON} bg-red-700 text-white hover:bg-red-800`;
