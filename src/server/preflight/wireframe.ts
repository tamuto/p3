import { deflateSync } from "node:zlib";

/**
 * 箱だけのワイヤーフレームの PNG（Mock とデモ用。文字は描かない）。決まった入力からいつも同じ画像になる。
 * 箱は [x, y, 幅, 高さ, 色]（色は 0xRRGGBB）
 */
export type Box = [number, number, number, number, number];

export function wireframePng(width: number, height: number, boxes: Box[], background = 0xffffff): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  const fill = (x0: number, y0: number, w: number, h: number, c: number) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const o = y * row + 1 + x * 3;
        raw[o] = (c >> 16) & 0xff;
        raw[o + 1] = (c >> 8) & 0xff;
        raw[o + 2] = c & 0xff;
      }
    }
  };
  fill(0, 0, width, height, background);
  for (const [x, y, w, h, c] of boxes) fill(x, y, w, h, c);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // ビットの深さ
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 一覧画面のワイヤーフレーム（見出し・絞り込み欄・ボタン・表の行） */
export function listScreenPng(rows = 5): Buffer {
  const line = 0xcbd5e1;
  const boxes: Box[] = [
    [24, 24, 320, 28, 0x1e293b],
    [24, 72, 240, 32, line],
    [276, 72, 160, 32, line],
    [448, 72, 96, 32, 0x4f46e5],
    [24, 124, 976, 36, 0xe2e8f0],
  ];
  for (let i = 0; i < rows; i++) boxes.push([24, 164 + i * 40, 976, 1, line], [40, 176 + i * 40, 200 + ((i * 53) % 160), 14, 0x94a3b8]);
  return wireframePng(1024, 200 + rows * 40, boxes);
}
