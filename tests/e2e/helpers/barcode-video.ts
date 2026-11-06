// Builds a tiny video of a barcode that Chromium can play as a SYNTHETIC camera
// (--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file>.y4m). It lets the browser tests drive the
// app's real camera path (getUserMedia -> <video> -> @zxing/browser decoding) without any camera hardware.
// Pure Node, no tools or packages: the file is YUV4MPEG2 (raw 4:2:0 frames after a text header).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const L_CODES = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
/** Right-hand digits are the bitwise complement of the left-hand (odd parity) ones; "G" digits are those, reversed. */
const R_CODES = L_CODES.map((code) => [...code].map((bit) => (bit === "0" ? "1" : "0")).join(""));
const G_CODES = R_CODES.map((code) => [...code].reverse().join(""));
/** Which left-hand code set (L or G) each of digits 2-7 uses, chosen by the first digit. */
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** The EAN-13 check digit for the first twelve digits. */
export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error("EAN-13 needs exactly 12 digits to compute a check digit");
  const sum = [...first12].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

/** The 95 modules (1 = bar, 0 = space) of a valid EAN-13 code. */
export function ean13Modules(code: string): string {
  if (!/^\d{13}$/.test(code)) throw new Error("EAN-13 needs exactly 13 digits");
  if (Number(code[12]) !== ean13CheckDigit(code.slice(0, 12))) throw new Error(`Wrong EAN-13 check digit in ${code}`);
  const parity = PARITY[Number(code[0])];
  let modules = "101";
  for (let i = 0; i < 6; i += 1) {
    const digit = Number(code[i + 1]);
    modules += parity[i] === "L" ? L_CODES[digit] : G_CODES[digit];
  }
  modules += "01010";
  for (let i = 0; i < 6; i += 1) modules += R_CODES[Number(code[i + 7])];
  modules += "101";
  return modules;
}

/**
 * Writes a looping Y4M video (white page, one large black-on-white EAN-13 barcode, generous quiet zones) and returns its path.
 * The same code always produces the same file name, so repeated calls reuse it.
 */
export function writeBarcodeVideo(code: string): string {
  const width = 640;
  const height = 480;
  const frames = 6;
  const moduleWidth = 4;
  const modules = ean13Modules(code);
  const file = path.join(os.tmpdir(), `medinventory-fake-camera-ean13-${code}.y4m`);

  const luma = Buffer.alloc(width * height, 235); // white
  const left = Math.floor((width - modules.length * moduleWidth) / 2);
  const top = Math.floor(height / 2) - 110;
  for (let y = top; y < top + 220; y += 1) {
    for (let m = 0; m < modules.length; m += 1) {
      if (modules[m] !== "1") continue;
      for (let x = 0; x < moduleWidth; x += 1) luma[y * width + left + m * moduleWidth + x] = 16; // black
    }
  }
  const chroma = Buffer.alloc((width / 2) * (height / 2), 128); // neutral gray: no color
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420mpeg2 XYSCSS=420MPEG2\n`, "ascii");
  const frameTag = Buffer.from("FRAME\n", "ascii");
  const parts: Buffer[] = [header];
  for (let i = 0; i < frames; i += 1) parts.push(frameTag, luma, chroma, chroma);
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}
