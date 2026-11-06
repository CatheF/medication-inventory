// A box with a maxLength stops accepting characters when it is full, and a paste is cut without a sound. This note says so, so
// nothing a person typed or pasted disappears without an explanation.

/** True once a box holds as many characters as it can (maxLength counts the same units as `value.length`). */
export function atLimit(value: string, limit: number): boolean {
  return value.length >= limit;
}

type LimitNoteProps = {
  /** The element id the box points at with aria-describedby (only while the note has text). */
  id: string;
  testId: string;
  value: string;
  limit: number;
  /** Smaller text, for a narrow table cell. */
  compact?: boolean;
};

/**
 * The message under a box that has reached its limit. The element is ALWAYS in the page and empty while there is room: a screen
 * reader that is already watching a polite live region speaks the text when it appears, which is what happens when someone types
 * or pastes past the end. Empty, it has no height, so it takes no room and nothing jumps.
 */
export function LimitNote({ id, testId, value, limit, compact = false }: LimitNoteProps) {
  const reached = atLimit(value, limit);
  const size = compact ? "text-xs" : "text-sm";
  return (
    <p id={id} data-testid={testId} role="status" className={reached ? `mt-1 ${size} font-medium text-amber-900` : undefined}>
      {reached ? `Limit: ${limit.toLocaleString("en-US")} characters. Anything more is cut off.` : null}
    </p>
  );
}
