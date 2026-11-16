"""Regenerate the three synthetic presets in sample-dumps/.

Dev-only dependency: Pillow (see scripts/requirements-dev.txt). Output is deterministic.
Usage: python scripts/generate_presets.py
"""

from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SEED = 1994
OUT = Path(__file__).resolve().parent.parent / "sample-dumps"

BRANCHES = ["N001", "N002", "S001", "S002", "E001", "W001"]
LEDGER_NAMES = [
    "Cash On Hand", "Trade Debtors", "Inventory Control", "Prepaid Rent", "Office Equipment",
    "Trade Creditors", "Accrued Wages", "Sales Revenue", "Cost Of Goods", "Freight Expense",
    "Utilities Expense", "Depreciation", "Retained Earnings", "Loan Payable", "Petty Cash",
    "Insurance Prepaid", "Bank Charges", "Returns Allowance", "Supplies Expense", "Suspense",
]
PRODUCT_NAMES = [
    "Rice 5kg", "Cooking Oil 2L", "Sugar 1kg", "Flour 1kg", "Canned Tuna", "Instant Noodles",
    "Soy Sauce", "Frozen Chicken", "Frozen Prawns", "Fresh Milk 1L", "Cheddar Slice", "Butter Block",
    "Mineral Water 6pk", "Orange Juice", "Tea Bags 100", "Ground Coffee", "Biscuit Assorted",
    "Chocolate Bar", "Potato Chips", "Dish Soap", "Paper Towels", "Trash Bags", "Salt 500g", "Curry Paste",
]


def money(value: float) -> str:
    return f"{value:.2f}"


def build_ledger(rng: random.Random) -> str:
    # Layout: type(2) id(6) name(20) branch(4) balance(12) | JE: type(2) id(6) acct(6) date(8) amount(12) memo(14)
    # Record types have different widths on purpose, so schema_archaeologist must split by prefix.
    lines: list[str] = []
    acct_ids = [f"A{1000 + i * 10:05d}" for i in range(len(LEDGER_NAMES))]
    for i, aid in enumerate(acct_ids):
        balance = rng.uniform(500, 90000)
        if LEDGER_NAMES[i] == "Suspense":
            balance = -rng.uniform(100, 900)
        lines.append(f"AC{aid:<6}{LEDGER_NAMES[i]:<20}{BRANCHES[i % 3]:<4}{money(balance):>12}")
    for n in range(1, 121):
        aid = rng.choice(acct_ids)
        if n in (37, 88):
            aid = "A09990"
        day = 1 + (n * 3) % 28
        month = 1 + (n // 12) % 12
        amount = rng.uniform(20, 15000) * rng.choice([1, 1, 1, -1])
        memo = rng.choice(["BATCH POST", "MANUAL ADJ", "RECON", "ACCRUAL", "REVERSAL"])
        lines.append(f"JE{n:06d}{aid:<6}1994{month:02d}{day:02d}{money(amount):>12}{memo:<14}")
    for n in (14, 15):
        # Byte-for-byte duplicate of an earlier entry except for its id.
        src = lines[len(LEDGER_NAMES) + 4]
        lines.append(f"JE{900 + n:06d}{src[8:]}")
    return "\n".join(lines) + "\n"


def build_pos(rng: random.Random) -> str:
    # Pipe-delimited so the 2-char prefix is the first field; field counts differ per record type.
    out: list[str] = []
    branch_codes = BRANCHES
    for code in branch_codes:
        out.append(f"BR|{code}|Warehouse {code}|{rng.choice(['DRY', 'CHILL', 'FROZEN'])}")
    skus = [f"SKU{1000 + i}" for i in range(len(PRODUCT_NAMES))]
    for sku, name in zip(skus, PRODUCT_NAMES):
        out.append(f"PR|{sku}|{name}|{money(rng.uniform(0.8, 24))}")
    stock_id = 0
    for sku in skus:
        for code in rng.sample(branch_codes, 2):
            stock_id += 1
            qty = rng.randint(10, 600)
            out.append(f"ST|{stock_id:05d}|{sku}|{code}|{qty}")
    out.append(f"ST|{stock_id + 1:05d}|{skus[3]}|N001|-48")
    out.append(f"ST|{stock_id + 2:05d}|{skus[9]}|S002|-120")
    out.append(f"ST|{stock_id + 3:05d}|{skus[5]}||75")
    out.append(f"ST|{stock_id + 4:05d}|SKU9999|E001|40")
    for n in range(1, 161):
        sku = rng.choice(skus)
        code = rng.choice(branch_codes)
        if n in (50, 51, 120):
            code = ""
        if n in (77, 140):
            sku = "SKU8888"
        out.append(f"SL|{n:06d}|{sku}|{code}|199{rng.randint(4, 5)}{rng.randint(1, 12):02d}{rng.randint(1, 28):02d}|{rng.randint(1, 12)}")
    return "\n".join(out) + "\n"


def _font(size: int) -> ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


def build_manifest(rng: random.Random) -> Image.Image:
    cols = ["ITEM", "DESCRIPTION", "QTY", "UNIT", "TOTAL"]
    widths = [150, 420, 150, 200, 240]
    rows = [
        ["1001", "RICE 5KG", "40", "12.50", "500.00"],
        ["1002", "COOKING OIL 2L", "25", "8.90", "222.50"],
        ["1003", "SUGAR 1KG", "60", "2.10", "126.00"],
        ["1004", "SOY SAUCE", "30", "3.40", "102.00"],
        ["1005", "CANNED TUNA", "80", "1.75", "140.00"],
        ["1006", "FLOUR 1KG", "45", "1.90", "85.50"],
        ["", "GRAND TOTAL", "", "", "1176.00"],
    ]
    left, top, row_h = 60, 170, 80
    width = left * 2 + sum(widths)
    height = top + row_h * (len(rows) + 1) + 90
    img = Image.new("L", (width, height), 236)
    px = img.load()
    for y in range(height):
        for x in range(width):
            px[x, y] = 236 + rng.randint(-6, 6)
    d = ImageDraw.Draw(img)
    ink, faint = 70, 150
    d.text((left, 50), "SHIPPING MANIFEST  NO. M-0042", font=_font(44), fill=ink)
    d.text((left, 110), "DEPOT NORTH  TO  DEPOT SOUTH", font=_font(26), fill=faint)

    xs = [left]
    for w in widths:
        xs.append(xs[-1] + w)
    ys = [top + i * row_h for i in range(len(rows) + 2)]
    for y in ys:
        d.line([(xs[0], y), (xs[-1], y)], fill=faint, width=2)
    for x in xs:
        d.line([(x, ys[0]), (x, ys[-1])], fill=faint, width=2)

    font = _font(34)
    all_rows = [cols] + rows
    for r, row in enumerate(all_rows):
        for c, text in enumerate(row):
            if not text:
                continue
            tx = xs[c] + 16
            if c == 2 and r in (3, 4):
                tx += 80  # misaligned column: two QTY cells drift right of their column
            fill = ink if r else ink - 20
            d.text((tx, ys[r] + 20), text, font=font, fill=fill)

    # Smudged digit: blur and blot the last digit of the row-2 UNIT cell.
    sx0, sy0 = xs[3] + 16 + 46, ys[2] + 12
    box = (sx0 - 4, sy0, sx0 + 32, sy0 + 58)
    patch = img.crop(box).filter(ImageFilter.GaussianBlur(7))
    img.paste(patch, box)
    d = ImageDraw.Draw(img)
    d.ellipse((sx0 - 2, sy0 + 12, sx0 + 30, sy0 + 46), fill=170)
    img.paste(img.crop(box).filter(ImageFilter.GaussianBlur(3)), box)

    # Torn total: jagged tear erases the bottom-right corner of the TOTAL grid contour and part of the value.
    tx0, ty0 = xs[4], ys[len(rows) - 1]
    d = ImageDraw.Draw(img)
    zig = []
    for i in range(0, 9):
        zig.append((tx0 + 20 + i * 28 + rng.randint(-4, 4), ty0 + 30 + (18 if i % 2 else -6)))
    poly = [(xs[4] - 6, ys[-2] - 4)] + zig + [(xs[5] + 8, ty0 + 32), (xs[5] + 8, ys[-1] + 8), (xs[4] - 6, ys[-1] + 8)]
    d.polygon([(x, y) for x, y in poly], fill=236)
    d.line(zig, fill=ink, width=2)
    d.text((xs[4] + 16, ys[len(rows)] + 20), "11", font=font, fill=ink)

    d.text((left, ys[-1] + 30), "RECEIVED BY: ____________   DATE: ____/____/94", font=_font(26), fill=faint)

    # Fade ribbon streaks and low-ink dropout, seeded.
    for _ in range(900):
        x, y = rng.randrange(width), rng.randrange(height)
        d.point((x, y), fill=236)
    for y in range(0, height, 6):
        d.line([(0, y), (width, y)], fill=236 if rng.random() < 0.5 else 232, width=1)
    img = img.point(lambda v: int(v * 0.85 + 36))
    return img.convert("RGB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    rng = random.Random(SEED)
    (OUT / "1994_mainframe_ledger_dump.dat").write_text(build_ledger(rng), encoding="ascii", newline="\n")
    (OUT / "corrupted_fnb_warehouse_pos_batch.txt").write_text(build_pos(rng), encoding="ascii", newline="\n")
    # No pnginfo is passed, so Pillow writes no text chunks; there is no EXIF in PNG output.
    build_manifest(rng).save(OUT / "faded_dotmatrix_manifest.png", format="PNG", optimize=True)


if __name__ == "__main__":
    main()
