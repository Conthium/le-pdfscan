from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import cv2
import numpy as np
import pypdfium2 as pdfium
from pypdf import PdfReader, PdfWriter


MARKER_COLORS = ("red", "green", "blue", "pink", "orange_marker")
ALL_OUTPUT_COLORS = MARKER_COLORS + ("orange_lamp",)

SHARED_MARKER_FILTER = {
    "min_area": 18,
    "min_density": 0.10,
    "max_aspect": 8.0,
    "max_side": 260,
    "require_text_under_area": 2200,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Analyze survey marker colors in a PDF page range and create a "
            "red-priority sorted PDF plus CSV summary."
        )
    )
    parser.add_argument("pdf", type=Path, help="Input PDF path")
    parser.add_argument("--start-page", type=int, default=1019, help="1-based start page")
    parser.add_argument("--end-page", type=int, default=1115, help="1-based end page")
    parser.add_argument("--scale", type=float, default=2.0, help="PDF render scale for analysis")
    parser.add_argument("--output-dir", type=Path, default=Path("output/pdf"))
    parser.add_argument(
        "--summary-name",
        default="color_priority_summary_1019_1115.csv",
        help="CSV filename inside output dir",
    )
    parser.add_argument(
        "--pdf-name",
        default="red_priority_sorted_pages_1019_1115.pdf",
        help="Sorted PDF filename inside output dir",
    )
    parser.add_argument(
        "--debug-json",
        default="color_priority_summary_1019_1115.json",
        help="JSON filename inside output dir",
    )
    return parser.parse_args()


def color_masks(rgb: np.ndarray, pink_hue_max: int = 176) -> dict[str, np.ndarray]:
    # OpenCV hue is 0-179. Red/orange are deliberately split with RGB ratios
    # because orange lighting markers often render close to the red hue wrap.
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    r = rgb[:, :, 0].astype("float32")
    g = rgb[:, :, 1].astype("float32")
    b = rgb[:, :, 2].astype("float32")
    gr = g / np.maximum(1, r)
    br = b / np.maximum(1, r)

    red = (
        (r >= 115)
        & (s >= 65)
        & (v >= 85)
        & (((h <= 10) | (h >= 170)))
        & (gr <= 0.35)
        & (br <= 0.78)
    )
    orange = (
        (r >= 130)
        & (s >= 45)
        & (v >= 100)
        & (gr > 0.34)
        & (gr <= 0.88)
        & (br <= 0.55)
        & (((h <= 35) | (h >= 170)))
    )
    green = (h >= 32) & (h <= 98) & (s >= 24) & (v >= 66)
    blue = (h >= 86) & (h <= 140) & (s >= 30) & (v >= 58)
    pink = (h >= 132) & (h <= pink_hue_max) & (s >= 26) & (v >= 78) & ~red & ~orange
    red_broad = (
        (r >= 115)
        & (s >= 65)
        & (v >= 85)
        & (((h <= 12) | (h >= 168)))
        & (gr <= 0.44)
        & (br <= 0.82)
        & ~orange
    )
    return {
        "red": red.astype("uint8"),
        "red_broad_clean": red_broad.astype("uint8"),
        "orange": orange.astype("uint8"),
        "green": green.astype("uint8"),
        "blue": blue.astype("uint8"),
        "pink": pink.astype("uint8"),
    }


def dark_compact_count(dark_region: np.ndarray) -> int:
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(
        dark_region.astype("uint8"), 8
    )
    height, width = dark_region.shape
    compact = 0
    for idx in range(1, count):
        _x, _y, w, h, area = (int(v) for v in stats[idx])
        if area < 3 or area > 180:
            continue
        if w > 0.75 * width or h > 0.75 * height:
            continue
        aspect = max(w / max(1, h), h / max(1, w))
        if aspect > 5:
            continue
        compact += 1
    return compact


def component_stats(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=1)
    closed = cv2.dilate(closed, np.ones((2, 2), np.uint8), iterations=1)
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(closed, 8)
    return [(int(x), int(y), int(w), int(h), int(area)) for x, y, w, h, area in stats[1:]]


def accepts_marker_component(
    original_area: int,
    density: float,
    aspect: float,
    text_count: int,
    width: int,
    height: int,
) -> bool:
    cfg = SHARED_MARKER_FILTER
    if original_area < cfg["min_area"]:
        return False
    if density < cfg["min_density"]:
        return False
    if aspect > cfg["max_aspect"]:
        return False
    if max(width, height) > cfg["max_side"]:
        return False
    if min(width, height) < 3:
        return False
    if original_area < cfg["require_text_under_area"] and text_count < 1:
        return False
    if density > 0.90 and original_area > 2600:
        return False
    return True


def marker_pattern_score(
    area: int,
    density: float,
    aspect: float,
    text_count: int,
    width: int,
    height: int,
) -> float:
    """Score a colored component using the human-counted marker pattern.

    The red source truth taught us that useful markers are colored boxes with
    compact black text inside. This reusable filter keeps the same visual
    pattern for every selectable priority color.
    """
    if text_count < 1:
        return 0.0
    if area < 18:
        return 0.0
    if min(width, height) < 4:
        return 0.0
    if max(width, height) > 260:
        return 0.0
    if aspect > 7.5:
        return 0.0
    if density < 0.018:
        return 0.0
    if density > 0.88 and area > 2200:
        return 0.0

    score = 1.0
    if 0.06 <= density <= 0.72:
        score += 0.25
    if aspect <= 3.5:
        score += 0.20
    score += min(text_count, 4) * 0.12
    score += min(area / 900.0, 1.8) * 0.10
    return round(score, 4)


def analyze_page(
    pdf: pdfium.PdfDocument,
    page_number: int,
    scale: float,
    priority_color: str = "red",
) -> dict[str, float | int]:
    page = pdf[page_number - 1]
    image = page.render(scale=scale).to_pil().convert("RGB")
    rgb = np.array(image)
    return analyze_rgb(rgb, page_number, priority_color)


def analyze_rgb(
    rgb: np.ndarray,
    page_number: int,
    priority_color: str = "red",
) -> dict[str, float | int]:
    dark = ((rgb[:, :, 0] < 90) & (rgb[:, :, 1] < 90) & (rgb[:, :, 2] < 90)).astype("uint8")

    row: dict[str, float | int] = {"page": page_number}
    for color in ALL_OUTPUT_COLORS:
        row[f"{color}_area"] = 0
        row[f"{color}_components"] = 0
    for color in MARKER_COLORS:
        row[f"{color}_marker_count"] = 0
        row[f"{color}_marker_area"] = 0
        row[f"{color}_marker_score"] = 0.0

    masks = color_masks(rgb, pink_hue_max=166 if priority_color == "pink" else 176)
    for color_name in ("red", "green", "blue", "pink", "orange"):
        mask = masks[color_name]
        for x, y, w, h, _closed_area in component_stats(mask):
            original_area = int(mask[y : y + h, x : x + w].sum())
            if original_area < 25:
                continue

            density = original_area / max(1, w * h)
            aspect = max(w / max(1, h), h / max(1, w))
            if aspect > 8:
                continue

            text_count = dark_compact_count(dark[y : y + h, x : x + w])
            if color_name == "orange":
                red_overlap = int(masks["red_broad_clean"][y : y + h, x : x + w].sum()) / max(
                    1, original_area
                )
                green_overlap = int(masks["green"][y : y + h, x : x + w].sum()) / max(
                    1, original_area
                )
                if aspect >= 2.1 and max(w, h) >= 18:
                    key = "orange_lamp"
                elif density < 0.28:
                    key = "orange_lamp"
                elif red_overlap > 0.30 or green_overlap > 0.30:
                    key = "orange_lamp"
                elif text_count >= 1 and original_area >= 40 and aspect <= 2.1:
                    key = "orange_marker"
                else:
                    key = "orange_lamp"
            else:
                key = color_name

            if key in MARKER_COLORS and not accepts_marker_component(
                original_area,
                density,
                aspect,
                text_count,
                w,
                h,
            ):
                continue

            row[f"{key}_area"] = int(row[f"{key}_area"]) + original_area
            row[f"{key}_components"] = int(row[f"{key}_components"]) + 1
            if key in MARKER_COLORS:
                marker_score = marker_pattern_score(
                    original_area,
                    density,
                    aspect,
                    text_count,
                    w,
                    h,
                )
                if marker_score > 0:
                    row[f"{key}_marker_count"] = int(row[f"{key}_marker_count"]) + 1
                    row[f"{key}_marker_area"] = int(row[f"{key}_marker_area"]) + original_area
                    row[f"{key}_marker_score"] = round(
                        float(row[f"{key}_marker_score"]) + marker_score,
                        4,
                    )

    marker_total = sum(int(row[f"{color}_area"]) for color in MARKER_COLORS)
    row["marker_total_area"] = marker_total
    for color in MARKER_COLORS:
        area = int(row[f"{color}_area"])
        row[f"{color}_pct"] = round((100.0 * area / marker_total), 4) if marker_total else 0.0

    issue_area = int(row["red_area"]) + int(row["orange_marker_area"])
    row["issue_priority_area"] = issue_area
    row["issue_priority_pct"] = round((100.0 * issue_area / marker_total), 4) if marker_total else 0.0
    row["issue_priority_components"] = int(row["red_components"]) + int(row["orange_marker_components"])
    row["red_priority_pct"] = row["red_pct"]
    row["red_priority_area"] = row["red_area"]
    row["red_priority_components"] = row["red_components"]
    row["red_marker_estimate"] = max(
        int(row["red_components"]),
        int(round(int(row["red_area"]) / 550.0)),
    )
    return row


def write_summary_csv(rows: list[dict[str, float | int]], output_path: Path) -> None:
    fieldnames = [
        "rank",
        "page",
        "issue_priority_pct",
        "issue_priority_area",
        "issue_priority_components",
        "red_priority_pct",
        "red_priority_area",
        "red_priority_components",
        "red_marker_estimate",
        "red_pct",
        "green_pct",
        "blue_pct",
        "pink_pct",
        "orange_marker_pct",
        "marker_total_area",
    ]
    for color in ALL_OUTPUT_COLORS:
        fieldnames.extend([f"{color}_components", f"{color}_area"])

    with output_path.open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for rank, row in enumerate(rows, 1):
            csv_row = {"rank": rank, **row}
            writer.writerow({name: csv_row.get(name, "") for name in fieldnames})


def write_sorted_pdf(input_pdf: Path, rows: list[dict[str, float | int]], output_path: Path) -> None:
    reader = PdfReader(str(input_pdf))
    writer = PdfWriter()
    for row in rows:
        writer.add_page(reader.pages[int(row["page"]) - 1])
    with output_path.open("wb") as fh:
        writer.write(fh)


def main() -> None:
    args = parse_args()
    if args.start_page < 1 or args.end_page < args.start_page:
        raise SystemExit("Invalid page range.")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    pdfium_doc = pdfium.PdfDocument(str(args.pdf))
    total_pages = len(pdfium_doc)
    if args.end_page > total_pages:
        raise SystemExit(f"End page {args.end_page} exceeds PDF page count {total_pages}.")

    rows = [
        analyze_page(pdfium_doc, page_number, args.scale)
        for page_number in range(args.start_page, args.end_page + 1)
    ]
    rows.sort(
        key=lambda row: (
            int(row["red_marker_estimate"]),
            int(row["red_priority_components"]),
            int(row["red_priority_area"]),
            float(row["red_priority_pct"]),
        ),
        reverse=True,
    )

    summary_path = args.output_dir / args.summary_name
    pdf_path = args.output_dir / args.pdf_name
    debug_path = args.output_dir / args.debug_json

    write_summary_csv(rows, summary_path)
    write_sorted_pdf(args.pdf, rows, pdf_path)
    debug_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote {pdf_path}")
    print(f"Wrote {summary_path}")
    print(f"Wrote {debug_path}")
    print("Top 10 pages by red workload:")
    for rank, row in enumerate(rows[:10], 1):
        print(
            f"{rank:02d}. page {int(row['page'])}: "
            f"red_marker_estimate={int(row['red_marker_estimate'])} "
            f"red_components={int(row['red_priority_components'])} "
            f"red_area={int(row['red_priority_area'])} "
            f"red={float(row['red_priority_pct']):.2f}% "
        )


if __name__ == "__main__":
    main()
