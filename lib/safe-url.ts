// Web addresses (the vendor link and the photo of an item) are only ever http or https.
//
// Three questions, answered by three functions that must not be merged:
//   safeHttpUrl      DISPLAY: "may this stored text become a link?" It is forgiving about what is already in the database
//                    (a bare "shop.example.com/reorder" is read as https) and never throws.
//   isHttpUrlText    WRITE, photo address: "may this text be stored as an address?" It is strict: a real http:// or https://
//                    address, because the browser requests the stored text as it is (a bare domain would be read as a path
//                    on this site and show a broken picture).
//   isVendorLinkText WRITE, vendor link: the strict form, or a bare "shop.example.com/reorder", which every screen already
//                    turns into an https link and which staff have always been able to type there. Every other scheme
//                    (javascript:, data:, file:, mailto:, ...) is refused.
// Existing stored values are never rewritten by any of them.

/**
 * A link target that is safe to put in href: only http(s). A bare "shop.example.com/reorder" is read as https.
 * Anything else (javascript:, mailto:, plain text) yields null and the row shows no link.
 */
// "shop.example.com" or "shop.example.com/reorder?item=1": dotted host names, then an optional path. No scheme, no colon.
const BARE_ADDRESS = /^[\w-]+(\.[\w-]+)+(\/\S*)?$/;

export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    // not an absolute URL; try the bare-domain form below
  }
  if (BARE_ADDRESS.test(text)) {
    try {
      return new URL(`https://${text}`).toString();
    } catch {
      return null;
    }
  }
  return null;
}

// Tab, line feed and carriage return are silently dropped by the URL parser, so "https://a.example/<line break>.evil" would be
// stored as typed but requested as something else. Every other control character (Unicode category Cc) is refused too.
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * True when `text` (already trimmed) is an absolute http:// or https:// address with a host. Rejects other schemes
 * (javascript:, data:, file:, ftp:, ...), scheme-less text, "http:host" without the two slashes, and control characters.
 */
export function isHttpUrlText(text: string): boolean {
  if (!/^https?:\/\/[^/?#\s]/i.test(text)) return false;
  if (CONTROL_CHARACTER.test(text)) return false;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * True when `text` (already trimmed) may be stored as a vendor link: a real http(s) address (isHttpUrlText), or a bare
 * "shop.example.com/reorder" that safeHttpUrl turns into an https link. Everything else is refused, including every other
 * scheme and text with control characters.
 */
export function isVendorLinkText(text: string): boolean {
  if (isHttpUrlText(text)) return true;
  return BARE_ADDRESS.test(text) && !CONTROL_CHARACTER.test(text) && safeHttpUrl(text) !== null;
}
