"""ファビコン一式を作る（標準ライブラリだけで動く）。

使い方（リポジトリのルートで）:
    python tools/make_favicon.py

出力:
    favicon.svg           モダンなブラウザ用（拡大しても崩れない）
    favicon.ico           SVG に対応しないブラウザ用（16・32・48px の PNG を格納）
    apple-touch-icon.png  iPhone・iPad のホーム画面用（180px、角丸なしの不透明。角丸は OS が付ける）

デザイン：サイトのアクセント色の角丸の正方形に、横書きの行を表す 3 本の線と、
1 行目の上にルビを表す短い線を置く。文字は環境でフォントが変わり小さいサイズで潰れるので使わない。
"""

import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

SIZE = 64  # 設計上の座標系（64 × 64）
BACKGROUND = (0x3C, 0x5A, 0x8A)  # style.css の --accent
INK = (0xFD, 0xFC, 0xF8)  # style.css の --bg（生成り色）
CORNER = 14

# (x0, y0, x1, y1, 角の半径)
# 座標は 4 の倍数にそろえる。16px 表示では 4 単位がちょうど 1 画素になり、
# 線と線のすき間（4 単位）が 1 画素として残るので、タブの小さなアイコンでも線がつながらない
SHAPES = [
    (12, 12, 28, 16, 2),  # ルビ
    (12, 20, 52, 28, 4),  # 1 行目
    (12, 32, 52, 40, 4),  # 2 行目
    (12, 44, 40, 52, 4),  # 3 行目（段落の終わりで短い）
]


def inside(x, y, rect):
    x0, y0, x1, y1, r = rect
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    dx = max(x0 + r - x, 0, x - (x1 - r))
    dy = max(y0 + r - y, 0, y - (y1 - r))
    return dx * dx + dy * dy <= r * r


def render(pixels, rounded=True):
    """pixels × pixels の RGBA を返す。1 画素を 4 × 4 点で調べて縁を滑らかにする。"""
    samples = 4
    scale = SIZE / pixels
    background = (0, 0, SIZE, SIZE, CORNER if rounded else 0)
    rows = []
    for py in range(pixels):
        row = bytearray()
        for px in range(pixels):
            covered = ink = 0
            for sy in range(samples):
                for sx in range(samples):
                    x = (px + (sx + 0.5) / samples) * scale
                    y = (py + (sy + 0.5) / samples) * scale
                    if inside(x, y, background):
                        covered += 1
                        if any(inside(x, y, shape) for shape in SHAPES):
                            ink += 1
            total = samples * samples
            if covered == 0:
                row += bytes(4)
                continue
            t = ink / covered
            color = [round(b + (i - b) * t) for b, i in zip(BACKGROUND, INK)]
            row += bytes(color + [round(255 * covered / total)])
        rows.append(bytes(row))
    return rows


def png(rows):
    height, width = len(rows), len(rows[0]) // 4

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    raw = b"".join(b"\x00" + row for row in rows)
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def ico(images):
    """PNG を格納した ICO（Windows Vista 以降・各ブラウザが対応）を作る。"""
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for size, data in images:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return header + entries + b"".join(data for _, data in images)


def svg():
    def hex_color(rgb):
        return "#" + "".join(f"{c:02x}" for c in rgb)

    shapes = "\n".join(
        f'  <rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{r}" fill="{hex_color(INK)}"/>'
        for x0, y0, x1, y1, r in SHAPES
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}">\n'
        f'  <rect width="{SIZE}" height="{SIZE}" rx="{CORNER}" fill="{hex_color(BACKGROUND)}"/>\n'
        f"{shapes}\n</svg>\n"
    )


def main():
    (ROOT / "favicon.svg").write_text(svg(), encoding="utf-8")
    (ROOT / "favicon.ico").write_bytes(ico([(size, png(render(size))) for size in (16, 32, 48)]))
    (ROOT / "apple-touch-icon.png").write_bytes(png(render(180, rounded=False)))
    print("favicon.svg・favicon.ico・apple-touch-icon.png を書き出しました")


if __name__ == "__main__":
    main()
