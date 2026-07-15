from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter


DEFAULT_PDF = Path("รายงานตรวจวัดสภาพแวดล้อมในการทำงาน สำนัก.pdf")


@dataclass
class TextAnchor:
    x: int
    y: int
    w: int
    h: int
    dark_area: int
    nearby_red_area: int
    score: float


@dataclass
class RedRegion:
    x: int
    y: int
    w: int
    h: int
    red_area: int
    density: float
    aspect: float
    text_anchor_count: int
    text_anchors: list[TextAnchor]
    reject_reason: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build a detector-assisted source truth from red marker boxes that "
            "contain black text anchors."
        )
    )
    parser.add_argument("pdf", nargs="?", type=Path, default=DEFAULT_PDF)
    parser.add_argument("--start-page", type=int, default=1019)
    parser.add_argument("--end-page", type=int, default=1115)
    parser.add_argument("--scale", type=float, default=3.0)
    parser.add_argument("--output-dir", type=Path, default=Path("output/pdf/source_truth_text_anchored"))
    parser.add_argument("--debug-pages", default="1034,1050,1055,1078,1080,1092,1114")
    return parser.parse_args()


def render_page(pdf: pdfium.PdfDocument, page_number: int, scale: float) -> np.ndarray:
    return np.array(pdf[page_number - 1].render(scale=scale).to_pil().convert("RGB"))


def red_mask(rgb: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    r = rgb[:, :, 0].astype("float32")
    g = rgb[:, :, 1].astype("float32")
    b = rgb[:, :, 2].astype("float32")
    gr = g / np.maximum(1, r)
    br = b / np.maximum(1, r)

    true_red = (
        (r >= 110)
        & (s >= 50)
        & (v >= 72)
        & ((h <= 14) | (h >= 166))
        & (gr <= 0.43)
        & (br <= 0.90)
    )
    faded_pink_red = (
        (r >= 110)
        & (s >= 34)
        & (v >= 75)
        & (h >= 145)
        & (h <= 176)
        & (gr <= 0.62)
        & (br <= 0.96)
    )
    dark_red = (
        (r >= 95)
        & (s >= 42)
        & (v >= 58)
        & ((h <= 10) | (h >= 170))
        & (gr <= 0.48)
        & (br <= 0.82)
    )
    return (true_red | faded_pink_red | dark_red).astype("uint8")


def target_color_mask(rgb: np.ndarray, priority_color: str) -> np.ndarray:
    red = red_mask(rgb)
    if priority_color == "red":
        return red

    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    r = rgb[:, :, 0].astype("float32")
    g = rgb[:, :, 1].astype("float32")
    b = rgb[:, :, 2].astype("float32")
    gr = g / np.maximum(1, r)
    br = b / np.maximum(1, r)

    if priority_color == "green":
        mask = (h >= 32) & (h <= 98) & (s >= 24) & (v >= 66)
    elif priority_color == "blue":
        mask = (h >= 86) & (h <= 140) & (s >= 30) & (v >= 58)
    elif priority_color == "pink":
        mask = (h >= 132) & (h <= 166) & (s >= 26) & (v >= 78) & ~red.astype(bool)
    elif priority_color == "orange_marker":
        mask = (
            (r >= 112)
            & (s >= 30)
            & (v >= 82)
            & (gr > 0.28)
            & (gr <= 1.02)
            & (br <= 0.70)
            & ((h <= 42) | (h >= 168))
            & ~red.astype(bool)
        )
    else:
        raise ValueError(f"Unsupported marker color: {priority_color}")
    return mask.astype("uint8")


def black_text_mask(rgb: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    # Local contrast matters because many source pages are scanned and uneven.
    adaptive = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        14,
    )
    dark_rgb = (
        (rgb[:, :, 0] < 115)
        & (rgb[:, :, 1] < 115)
        & (rgb[:, :, 2] < 115)
        & ((rgb.max(axis=2) - rgb.min(axis=2)) < 75)
    )
    return ((adaptive > 0) & dark_rgb).astype("uint8")


def connected_regions(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), iterations=1)
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(closed, 8)
    return [(int(x), int(y), int(w), int(h), int(area)) for x, y, w, h, area in stats[1:]]


def text_anchors_for_region(
    red: np.ndarray,
    dark: np.ndarray,
    x: int,
    y: int,
    w: int,
    h: int,
    pad: int,
) -> list[TextAnchor]:
    height, width = red.shape
    x1 = max(0, x - pad)
    y1 = max(0, y - pad)
    x2 = min(width, x + w + pad)
    y2 = min(height, y + h + pad)
    red_crop = red[y1:y2, x1:x2]
    dark_crop = dark[y1:y2, x1:x2]
    red_zone = cv2.dilate(red_crop, np.ones((max(3, pad), max(3, pad)), np.uint8), iterations=1)

    text_seed = (dark_crop & red_zone).astype("uint8")
    # Remove plan lines and hatch strokes before grouping character clusters.
    char_count, labels, stats, _centroids = cv2.connectedComponentsWithStats(text_seed, 8)
    char_mask = np.zeros_like(text_seed)
    for idx in range(1, char_count):
        cx, cy, cw, ch, area = (int(v) for v in stats[idx])
        if area < 3 or area > 420:
            continue
        aspect = max(cw / max(1, ch), ch / max(1, cw))
        if aspect > 8:
            continue
        if cw > 0.65 * (x2 - x1) or ch > 0.80 * (y2 - y1):
            continue
        char_mask[labels == idx] = 1

    grouped = cv2.dilate(char_mask, np.ones((5, 11), np.uint8), iterations=1)
    group_count, group_labels, group_stats, _ = cv2.connectedComponentsWithStats(grouped, 8)
    anchors: list[TextAnchor] = []
    for idx in range(1, group_count):
        gx, gy, gw, gh, garea = (int(v) for v in group_stats[idx])
        if garea < 8:
            continue
        if gw < 3 or gh < 3:
            continue
        aspect = max(gw / max(1, gh), gh / max(1, gw))
        if aspect > 9:
            continue
        group_mask = group_labels == idx
        dark_area = int(char_mask[group_mask].sum())
        nearby_red_area = int(red_zone[group_mask].sum())
        if nearby_red_area < 8:
            continue
        if dark_area < 3:
            continue
        score = min(1.0, dark_area / 18.0) * min(1.0, nearby_red_area / 24.0)
        anchors.append(
            TextAnchor(
                x=x1 + gx,
                y=y1 + gy,
                w=gw,
                h=gh,
                dark_area=dark_area,
                nearby_red_area=nearby_red_area,
                score=round(score, 4),
            )
        )
    return anchors


def region_from_component(red: np.ndarray, dark: np.ndarray, box: tuple[int, int, int, int, int]) -> RedRegion:
    x, y, w, h, _area = box
    red_area = int(red[y : y + h, x : x + w].sum())
    density = red_area / max(1, w * h)
    aspect = max(w / max(1, h), h / max(1, w))
    reject = ""
    if red_area < 18:
        reject = "tiny_red"
    elif aspect > 14:
        reject = "line_like"
    elif density < 0.08:
        reject = "sparse_red_stroke"
    elif max(w, h) > 260 and density > 0.18:
        reject = "large_fill"
    elif max(w, h) > 140 and density < 0.38:
        reject = "large_sparse_annotation"
    anchors = text_anchors_for_region(red, dark, x, y, w, h, pad=10)
    if not anchors and not reject:
        reject = "no_black_text_anchor"
    return RedRegion(
        x=x,
        y=y,
        w=w,
        h=h,
        red_area=red_area,
        density=round(density, 5),
        aspect=round(aspect, 4),
        text_anchor_count=0 if reject else len(anchors),
        text_anchors=anchors,
        reject_reason=reject,
    )


def analyze_page(pdf: pdfium.PdfDocument, page_number: int, scale: float) -> dict[str, Any]:
    rgb = render_page(pdf, page_number, scale)
    return analyze_rgb(rgb, page_number)


def analyze_rgb(rgb: np.ndarray, page_number: int) -> dict[str, Any]:
    return analyze_rgb_for_color(rgb, page_number, "red")


def analyze_rgb_for_color(rgb: np.ndarray, page_number: int, priority_color: str) -> dict[str, Any]:
    red = target_color_mask(rgb, priority_color)
    dark = black_text_mask(rgb)
    regions = [region_from_component(red, dark, box) for box in connected_regions(red)]
    accepted = [region for region in regions if not region.reject_reason and region.text_anchor_count > 0]
    large_rejected = [region for region in regions if region.reject_reason == "large_fill"]
    anchors = [anchor for region in accepted for anchor in region.text_anchors]
    anchor_dark_areas = [float(anchor.dark_area) for anchor in anchors]
    anchor_nearby_areas = [float(anchor.nearby_red_area) for anchor in anchors]
    anchor_scores = [float(anchor.score) for anchor in anchors]
    region_areas = [float(region.red_area) for region in accepted]
    region_densities = [float(region.density) for region in accepted]
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    color_ratio_g: list[float] = []
    color_ratio_b: list[float] = []
    color_saturation: list[float] = []
    color_value: list[float] = []
    for region in accepted:
        x, y, w, h = region.x, region.y, region.w, region.h
        region_mask = red[y : y + h, x : x + w].astype(bool)
        if not region_mask.any():
            continue
        rgb_crop = rgb[y : y + h, x : x + w]
        hsv_crop = hsv[y : y + h, x : x + w]
        pixels = rgb_crop[region_mask].astype("float32")
        hsv_pixels = hsv_crop[region_mask].astype("float32")
        color_ratio_g.extend((pixels[:, 1] / np.maximum(1.0, pixels[:, 0])).tolist())
        color_ratio_b.extend((pixels[:, 2] / np.maximum(1.0, pixels[:, 0])).tolist())
        color_saturation.extend(hsv_pixels[:, 1].tolist())
        color_value.extend(hsv_pixels[:, 2].tolist())

    # Each black text anchor inside a valid red region is treated as one red box.
    # This is deliberately source-truth oriented, not final production scoring.
    text_box_count = sum(region.text_anchor_count for region in accepted)
    red_region_count = len(accepted)
    red_area = sum(region.red_area for region in accepted)
    confidence = 0.55
    if text_box_count >= 20 and red_region_count >= 8:
        confidence = 0.82
    elif text_box_count >= 6:
        confidence = 0.72
    elif text_box_count == 0:
        confidence = 0.92
    if large_rejected and text_box_count < 8:
        confidence -= 0.18

    return {
        "page": page_number,
        "red_text_box_count": text_box_count,
        "accepted_red_regions": red_region_count,
        "accepted_red_area": red_area,
        "large_rejected_regions": len(large_rejected),
        "anchor_score_sum": round(sum(anchor_scores), 4),
        "anchor_score_mean": round(statistics.fmean(anchor_scores), 4) if anchor_scores else 0.0,
        "strong_anchor_count": sum(1 for score in anchor_scores if score >= 0.8),
        "weak_anchor_count": sum(1 for score in anchor_scores if score < 0.45),
        "anchor_dark_area_sum": int(sum(anchor_dark_areas)),
        "anchor_dark_area_mean": round(statistics.fmean(anchor_dark_areas), 4)
        if anchor_dark_areas
        else 0.0,
        "anchor_dark_area_median": round(statistics.median(anchor_dark_areas), 4)
        if anchor_dark_areas
        else 0.0,
        "anchor_nearby_area_sum": int(sum(anchor_nearby_areas)),
        "anchor_nearby_area_mean": round(statistics.fmean(anchor_nearby_areas), 4)
        if anchor_nearby_areas
        else 0.0,
        "anchor_nearby_area_median": round(statistics.median(anchor_nearby_areas), 4)
        if anchor_nearby_areas
        else 0.0,
        "accepted_region_area_mean": round(statistics.fmean(region_areas), 4) if region_areas else 0.0,
        "accepted_region_density_mean": round(statistics.fmean(region_densities), 4)
        if region_densities
        else 0.0,
        "accepted_color_gr_mean": round(statistics.fmean(color_ratio_g), 4)
        if color_ratio_g
        else 0.0,
        "accepted_color_br_mean": round(statistics.fmean(color_ratio_b), 4)
        if color_ratio_b
        else 0.0,
        "accepted_color_saturation_mean": round(statistics.fmean(color_saturation), 4)
        if color_saturation
        else 0.0,
        "accepted_color_value_mean": round(statistics.fmean(color_value), 4)
        if color_value
        else 0.0,
        "confidence": round(max(0.2, min(0.98, confidence)), 4),
        "regions": [asdict(region) for region in regions],
    }


def write_csv(rows: list[dict[str, Any]], output_path: Path) -> None:
    fields = [
        "rank",
        "page",
        "red_text_box_count",
        "accepted_red_regions",
        "accepted_red_area",
        "large_rejected_regions",
        "anchor_score_sum",
        "anchor_score_mean",
        "strong_anchor_count",
        "weak_anchor_count",
        "anchor_dark_area_sum",
        "anchor_dark_area_mean",
        "anchor_dark_area_median",
        "anchor_nearby_area_sum",
        "anchor_nearby_area_mean",
        "anchor_nearby_area_median",
        "accepted_region_area_mean",
        "accepted_region_density_mean",
        "accepted_color_gr_mean",
        "accepted_color_br_mean",
        "accepted_color_saturation_mean",
        "accepted_color_value_mean",
        "confidence",
    ]
    with output_path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        for rank, row in enumerate(rows, 1):
            writer.writerow({"rank": rank, **{field: row.get(field, "") for field in fields if field != "rank"}})


def write_pdf(input_pdf: Path, rows: list[dict[str, Any]], output_path: Path) -> None:
    reader = PdfReader(str(input_pdf))
    writer = PdfWriter()
    for row in rows:
        writer.add_page(reader.pages[int(row["page"]) - 1])
    with output_path.open("wb") as fh:
        writer.write(fh)


def draw_overlay(rgb: np.ndarray, row: dict[str, Any], output_path: Path) -> None:
    image = Image.fromarray(rgb).convert("RGB")
    draw = ImageDraw.Draw(image)
    for region in row["regions"]:
        x, y, w, h = (int(region[key]) for key in ("x", "y", "w", "h"))
        if region["reject_reason"]:
            color = (150, 150, 150)
            width = 1
        else:
            color = (220, 0, 0)
            width = 3
        draw.rectangle((x, y, x + w, y + h), outline=color, width=width)
        if not region["reject_reason"]:
            draw.text((x, max(0, y - 18)), f"red boxes {region['text_anchor_count']}", fill=color)
        for anchor in region["text_anchors"]:
            ax, ay, aw, ah = (int(anchor[key]) for key in ("x", "y", "w", "h"))
            draw.rectangle((ax, ay, ax + aw, ay + ah), outline=(0, 170, 210), width=2)
    draw.text(
        (24, 24),
        f"page {row['page']} text-box count {row['red_text_box_count']} regions {row['accepted_red_regions']}",
        fill=(0, 0, 0),
    )
    image.thumbnail((1600, 2100), Image.Resampling.LANCZOS)
    image.save(output_path, optimize=True)


def make_contact_sheet(pdf_path: Path, rows: list[dict[str, Any]], output_path: Path, count: int = 60) -> None:
    pdf = pdfium.PdfDocument(str(pdf_path))
    cols = 4
    cell_w, cell_h = 470, 610
    sheet = Image.new("RGB", (cols * cell_w, math.ceil(count / cols) * cell_h), "white")
    for index, row in enumerate(rows[:count]):
        page = int(row["page"])
        image = pdf[page - 1].render(scale=0.42).to_pil().convert("RGB")
        image.thumbnail((cell_w - 24, cell_h - 80), Image.Resampling.LANCZOS)
        panel = Image.new("RGB", (cell_w, cell_h), "white")
        draw = ImageDraw.Draw(panel)
        draw.rectangle((0, 0, cell_w - 1, cell_h - 1), outline=(190, 190, 190), width=2)
        draw.text((10, 10), f"rank {index + 1} / page {page}", fill=(0, 0, 0))
        draw.text(
            (10, 32),
            f"text boxes {row['red_text_box_count']} regions {row['accepted_red_regions']} conf {row['confidence']}",
            fill=(150, 0, 0),
        )
        panel.paste(image, ((cell_w - image.width) // 2, 70))
        sheet.paste(panel, ((index % cols) * cell_w, (index // cols) * cell_h))
    sheet.save(output_path, optimize=True)


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    pdf = pdfium.PdfDocument(str(args.pdf))
    rows = [
        analyze_page(pdf, page_number, args.scale)
        for page_number in range(args.start_page, args.end_page + 1)
    ]
    rows.sort(
        key=lambda row: (
            int(row["red_text_box_count"]),
            int(row["accepted_red_regions"]),
            int(row["accepted_red_area"]),
        ),
        reverse=True,
    )

    csv_path = args.output_dir / "text_anchored_source_truth_1019_1115.csv"
    json_path = args.output_dir / "text_anchored_source_truth_1019_1115.json"
    pdf_path = args.output_dir / "text_anchored_source_truth_sorted_pages_1019_1115.pdf"
    write_csv(rows, csv_path)
    write_pdf(args.pdf, rows, pdf_path)
    json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    make_contact_sheet(args.pdf, rows, args.output_dir / "text_anchored_top60_check.png", count=60)

    debug_dir = args.output_dir / "debug_pages"
    debug_dir.mkdir(exist_ok=True)
    debug_pages = {int(part.strip()) for part in args.debug_pages.split(",") if part.strip()}
    by_page = {int(row["page"]): row for row in rows}
    for page in sorted(debug_pages):
        if page in by_page:
            draw_overlay(render_page(pdf, page, args.scale), by_page[page], debug_dir / f"page_{page}_text_anchors.png")

    print(f"Wrote {pdf_path}")
    print(f"Wrote {csv_path}")
    print(f"Wrote {json_path}")
    print("Top 30 text-anchored source truth candidates:")
    for rank, row in enumerate(rows[:30], 1):
        print(
            f"{rank:02d}. page {row['page']} "
            f"text_boxes={row['red_text_box_count']} regions={row['accepted_red_regions']} "
            f"conf={row['confidence']}"
        )


if __name__ == "__main__":
    main()
