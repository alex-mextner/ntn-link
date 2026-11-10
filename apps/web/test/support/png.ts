/**
 * Just enough PNG for rendered-image tests: decode an 8-bit RGB/RGBA image (what the card
 * renderer emits) to pixels, and encode a flat-colour RGBA image to feed in as a picture icon.
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row by row. */
  rgba: Uint8Array;
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface Header {
  width: number;
  height: number;
  channels: number;
}

function readHeader(view: DataView, body: Uint8Array): Header {
  const depth = body[8];
  const colour = body[9];
  if (depth !== 8 || (colour !== 2 && colour !== 6) || body[12] !== 0) {
    throw new Error(`unsupported PNG (depth ${depth}, colour ${colour})`);
  }
  return { width: view.getUint32(16), height: view.getUint32(20), channels: colour === 6 ? 4 : 3 };
}

/** The IHDR fields and the concatenated IDAT payload of a PNG. */
function readChunks(png: Uint8Array): { header: Header; data: Buffer } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let header: Header | null = null;
  const data: Uint8Array[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = readHeader(view, body);
    if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  if (header === null) throw new Error('PNG without IHDR');
  return { header, data: Buffer.concat(data) };
}

/** One scanline with its PNG filter undone, given the already decoded line above it. */
function unfilterLine(
  filter: number,
  line: Uint8Array,
  previous: Uint8Array,
  channels: number,
): Uint8Array {
  const current = new Uint8Array(line.length);
  for (let i = 0; i < line.length; i++) {
    const left = i >= channels ? (current[i - channels] ?? 0) : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= channels ? (previous[i - channels] ?? 0) : 0;
    const predictors = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)];
    current[i] = ((line[i] ?? 0) + (predictors[filter] ?? 0)) & 0xff;
  }
  return current;
}

export function decodePng(png: Uint8Array): Pixels {
  if (!SIGNATURE.every((byte, i) => png[i] === byte)) throw new Error('not a PNG');
  const { header, data } = readChunks(png);
  const { width, height, channels } = header;
  const raw = inflateSync(data);
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let previous: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const current = unfilterLine(
      raw[start] ?? 0,
      raw.subarray(start + 1, start + 1 + stride),
      previous,
      channels,
    );
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4;
      rgba.set(current.subarray(x * channels, x * channels + 3), target);
      rgba[target + 3] = channels === 4 ? (current[x * channels + 3] ?? 255) : 255;
    }
    previous = current;
  }
  return { width, height, rgba };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pixels of `image` inside `box` for which `test(r, g, b)` holds. */
export function countPixels(
  image: Pixels,
  box: Box,
  test: (r: number, g: number, b: number) => boolean,
): number {
  let count = 0;
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      const i = (y * image.width + x) * 4;
      if (test(image.rgba[i] ?? 0, image.rgba[i + 1] ?? 0, image.rgba[i + 2] ?? 0)) count++;
    }
  }
  return count;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** A `size` x `size` PNG of one opaque colour. */
export function solidPng(size: number, [r, g, b]: [number, number, number]): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8);
  const line = new Uint8Array(1 + size * 4);
  for (let x = 0; x < size; x++) line.set([r, g, b, 255], 1 + x * 4);
  const raw = new Uint8Array(line.length * size);
  for (let y = 0; y < size; y++) raw.set(line, y * line.length);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
