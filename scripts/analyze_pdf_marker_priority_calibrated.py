from __future__ import annotations

import argparse
import csv
import json
import math
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter


DEFAULT_PDF = Path("รายงานตรวจวัดสภาพแวดล้อมในการทำงาน สำนัก.pdf")


@dataclass
class MarkerCandidate:
    x: int
    y: int
    w: int
    h: int
    red_area: int
    density: float
    aspect: float
    dark_compact: int
    edge_ratio: float
    source: str
    score: float
    reject_reason: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Calibrated marker-priority PDF sorter focused on red survey markers."
    )
    parser.add_argument("pdf", nargs="?", type=Path, default=DEFAULT_PDF)
    parser.add_argument("--start-page", type=int, default=1019)
    parser.add_argument("--end-page", type=int, default=1115)
    parser.add_argument("--scale", type=float, default=2.0)
    parser.add_argument("--output-dir", type=Path, default=Path("output/pdf/opencv_calibrated"))
    parser.add_argument("--debug-pages", default="1034,1050,1051,1055,1087,1098,1114")
    return parser.parse_args()


def render_page(pdf: pdfium.PdfDocument, page_number: int, scale: float) -> np.ndarray:
    return np.array(pdf[page_number - 1].render(scale=scale).to_pil().convert("RGB"))


def color_masks(rgb: np.ndarray) -> dict[str, np.ndarray]:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    r = rgb[:, :, 0].astype("float32")
    g = rgb[:, :, 1].astype("float32")
    b = rgb[:, :, 2].astype("float32")
    gr = g / np.maximum(1, r)
    br = b / np.maximum(1, r)

    hue_red = (h <= 13) | (h >= 168)
    strict_red = (
        (r >= 120)
        & (s >= 58)
        & (v >= 80)
        & hue_red
        & (gr <= 0.45)
        & (br <= 0.82)
    )
    relaxed_red = (
        (r >= 96)
        & (s >= 34)
        & (v >= 72)
        & (((h <= 16) | (h >= 160)) | ((h >= 136) & (h <= 171) & (gr <= 0.68)))
        & (gr <= 0.58)
        & (br <= 0.92)
    )
    orange = (
        (r >= 128)
        & (s >= 38)
        & (v >= 95)
        & (gr > 0.38)
        & (gr <= 0.95)
        & (br <= 0.62)
        & ((h <= 38) | (h >= 170))
    )
    green = (h >= 32) & (h <= 98) & (s >= 24) & (v >= 66)
    blue = (h >= 86) & (h <= 140) & (s >= 30) & (v >= 58)
    pink = (h >= 132) & (h <= 166) & (s >= 26) & (v >= 78) & ~relaxed_red
    return {
        "strict_red": strict_red.astype("uint8"),
        "relaxed_red": relaxed_red.astype("uint8"),
        "orange": orange.astype("uint8"),
        "green": green.astype("uint8"),
        "blue": blue.astype("uint8"),
        "pink": pink.astype("uint8"),
    }


def target_color_masks(
    rgb: np.ndarray,
    priority_color: str,
    masks: dict[str, np.ndarray],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    r = rgb[:, :, 0].astype("float32")
    g = rgb[:, :, 1].astype("float32")
    b = rgb[:, :, 2].astype("float32")
    gr = g / np.maximum(1, r)
    br = b / np.maximum(1, r)
    empty = np.zeros_like(h, dtype="uint8")

    if priority_color == "red":
        strict_mask = masks["strict_red"]
        relaxed_mask = masks["relaxed_red"]
        overlap_mask = masks["orange"]
    elif priority_color == "green":
        strict_mask = masks["green"]
        relaxed_mask = ((h >= 32) & (h <= 98) & (s >= 24) & (v >= 66)).astype("uint8")
        overlap_mask = empty
    elif priority_color == "blue":
        strict_mask = masks["blue"]
        relaxed_mask = ((h >= 86) & (h <= 140) & (s >= 30) & (v >= 58)).astype("uint8")
        overlap_mask = empty
    elif priority_color == "pink":
        strict_mask = masks["pink"]
        relaxed_mask = (
            (h >= 132)
            & (h <= 166)
            & (s >= 26)
            & (v >= 78)
            & ~masks["relaxed_red"].astype(bool)
        ).astype("uint8")
        overlap_mask = empty
    elif priority_color == "orange_marker":
        strict_mask = (masks["orange"].astype(bool) & ~masks["relaxed_red"].astype(bool)).astype("uint8")
        relaxed_mask = (
            (r >= 112)
            & (s >= 30)
            & (v >= 82)
            & (gr > 0.28)
            & (gr <= 1.02)
            & (br <= 0.70)
            & ((h <= 42) | (h >= 168))
            & ~masks["relaxed_red"].astype(bool)
        ).astype("uint8")
        overlap_mask = empty
    else:
        raise ValueError(f"Unsupported marker color: {priority_color}")

    return strict_mask, relaxed_mask, overlap_mask


def dark_compact_count(dark_region: np.ndarray) -> int:
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(
        dark_region.astype("uint8"), 8
    )
    height, width = dark_region.shape
    compact = 0
    for idx in range(1, count):
        _x, _y, w, h, area = (int(v) for v in stats[idx])
        if area < 3 or area > 220:
            continue
        if w > 0.8 * width or h > 0.8 * height:
            continue
        aspect = max(w / max(1, h), h / max(1, w))
        if aspect > 5.5:
            continue
        compact += 1
    return compact


def connected_boxes(mask: np.ndarray, source: str) -> list[tuple[int, int, int, int, int, str]]:
    if source == "strict":
        kernel = np.ones((5, 5), np.uint8)
        closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
        closed = cv2.dilate(closed, np.ones((2, 2), np.uint8), iterations=1)
    else:
        closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 5), np.uint8), iterations=1)
        closed = cv2.dilate(closed, np.ones((3, 2), np.uint8), iterations=1)
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(closed, 8)
    boxes: list[tuple[int, int, int, int, int, str]] = []
    for x, y, w, h, area in stats[1:]:
        boxes.append((int(x), int(y), int(w), int(h), int(area), source))
    return boxes


def edge_ratio(mask_crop: np.ndarray) -> float:
    if mask_crop.size == 0:
        return 0.0
    edge = np.zeros_like(mask_crop, dtype=bool)
    pad = max(2, min(mask_crop.shape[:2]) // 8)
    edge[:pad, :] = True
    edge[-pad:, :] = True
    edge[:, :pad] = True
    edge[:, -pad:] = True
    total = int(mask_crop.sum())
    return float(mask_crop[edge].sum() / max(1, total))


def score_candidate(
    mask: np.ndarray,
    strict_mask: np.ndarray,
    orange_mask: np.ndarray,
    dark: np.ndarray,
    x: int,
    y: int,
    w: int,
    h: int,
    source: str,
) -> MarkerCandidate | None:
    original_area = int(mask[y : y + h, x : x + w].sum())
    if original_area < 10:
        return None

    box_area = max(1, w * h)
    density = original_area / box_area
    aspect = max(w / max(1, h), h / max(1, w))
    dark_count = dark_compact_count(dark[y : y + h, x : x + w])
    border_ratio = edge_ratio(mask[y : y + h, x : x + w])
    strict_overlap = int(strict_mask[y : y + h, x : x + w].sum())
    orange_overlap = int(orange_mask[y : y + h, x : x + w].sum())
    orange_ratio = orange_overlap / max(1, original_area)
    strict_ratio = strict_overlap / max(1, original_area)
    score = 1.0
    reject = ""

    if min(w, h) < 4:
        reject = "too_thin"
    elif aspect > 8.5:
        reject = "line_like"
    elif max(w, h) > 190 or box_area > 15000:
        reject = "too_large"
    elif density < 0.012:
        reject = "too_sparse"
    elif source == "relaxed" and orange_ratio > 0.55 and strict_ratio < 0.35:
        reject = "orange_overlap"

    if reject:
        return MarkerCandidate(x, y, w, h, original_area, density, aspect, dark_count, border_ratio, source, 0.0, reject)

    if 8 <= w <= 105 and 6 <= h <= 70:
        score *= 1.25
    elif 5 <= min(w, h) and max(w, h) <= 145:
        score *= 0.8
    else:
        score *= 0.45

    if 1 <= dark_count <= 4:
        score *= 1.25
    elif dark_count == 0:
        score *= 0.45 if original_area < 180 else 0.65
    else:
        score *= 0.38

    if 0.025 <= density <= 0.58:
        score *= 1.15
    elif density > 0.70:
        score *= 0.45
    elif density < 0.02:
        score *= 0.55

    if border_ratio >= 0.45:
        score *= 1.12
    elif border_ratio < 0.18 and density > 0.45:
        score *= 0.65

    if aspect > 4.8:
        score *= 0.55
    if original_area > 1100 and density > 0.25:
        score *= 0.22
    if original_area > 2300:
        score *= 0.16

    if source == "relaxed":
        score *= 0.78
        if orange_ratio > 0.25 and strict_ratio < 0.55:
            score *= 0.35
    elif orange_ratio > 0.35 and strict_ratio < 0.70:
        score *= 0.55
    return MarkerCandidate(x, y, w, h, original_area, density, aspect, dark_count, border_ratio, source, score)


def iou(a: MarkerCandidate, b: MarkerCandidate) -> float:
    ax2, ay2 = a.x + a.w, a.y + a.h
    bx2, by2 = b.x + b.w, b.y + b.h
    ix1, iy1 = max(a.x, b.x), max(a.y, b.y)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    return inter / max(1, a.w * a.h + b.w * b.h - inter)


def dedupe_candidates(candidates: list[MarkerCandidate]) -> list[MarkerCandidate]:
    kept: list[MarkerCandidate] = []
    for candidate in sorted(candidates, key=lambda c: c.score, reverse=True):
        if candidate.score <= 0:
            kept.append(candidate)
            continue
        overlaps = False
        for existing in kept:
            if existing.score <= 0:
                continue
            if iou(candidate, existing) > 0.35:
                overlaps = True
                break
        if not overlaps:
            kept.append(candidate)
    return kept


def extract_candidates(rgb: np.ndarray) -> tuple[dict[str, np.ndarray], list[MarkerCandidate]]:
    return extract_candidates_for_color(rgb, "red")


def extract_candidates_for_color(
    rgb: np.ndarray,
    priority_color: str,
) -> tuple[dict[str, np.ndarray], list[MarkerCandidate]]:
    masks = color_masks(rgb)
    dark = ((rgb[:, :, 0] < 88) & (rgb[:, :, 1] < 88) & (rgb[:, :, 2] < 88)).astype("uint8")
    strict_mask, relaxed_mask, overlap_mask = target_color_masks(rgb, priority_color, masks)

    candidates: list[MarkerCandidate] = []
    for source, mask in (("strict", strict_mask), ("relaxed", relaxed_mask)):
        for x, y, w, h, _closed_area, source_name in connected_boxes(mask, source):
            candidate = score_candidate(
                mask,
                strict_mask,
                overlap_mask,
                dark,
                x,
                y,
                w,
                h,
                source_name,
            )
            if candidate is not None:
                candidates.append(candidate)
    return masks, dedupe_candidates(candidates)


def component_count(mask: np.ndarray, min_area: int = 25) -> tuple[int, int]:
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=1)
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(closed, 8)
    components = 0
    area_total = 0
    for _x, _y, w, h, area in stats[1:]:
        if int(area) < min_area:
            continue
        aspect = max(int(w) / max(1, int(h)), int(h) / max(1, int(w)))
        if aspect > 12:
            continue
        components += 1
        area_total += int(area)
    return components, area_total


def analyze_page(pdf: pdfium.PdfDocument, page_number: int, scale: float) -> dict[str, Any]:
    rgb = render_page(pdf, page_number, scale)
    return analyze_rgb(rgb, page_number)


def analyze_rgb(rgb: np.ndarray, page_number: int) -> dict[str, Any]:
    return analyze_rgb_for_color(rgb, page_number, "red")


def analyze_rgb_for_color(rgb: np.ndarray, page_number: int, priority_color: str) -> dict[str, Any]:
    masks, candidates = extract_candidates_for_color(rgb, priority_color)
    accepted = [c for c in candidates if c.score > 0]
    red_marker_score = sum(c.score for c in accepted)
    red_marker_count = sum(1 for c in accepted if c.score >= 0.45)
    weighted_red_area = sum(min(c.red_area, 950) * max(c.score, 0) for c in accepted)
    large_false_red_count = sum(
        1
        for c in candidates
        if c.score == 0 and c.reject_reason == "too_large" and c.red_area > 800
    )
    hatch_like_count = sum(
        1
        for c in accepted
        if c.red_area > 900 and c.dark_compact >= 5 and c.density > 0.22
    )
    green_components, green_area = component_count(masks["green"])
    blue_components, blue_area = component_count(masks["blue"])
    pink_components, pink_area = component_count(masks["pink"])
    orange_components, orange_area = component_count(masks["orange"])

    # The final score is intentionally count-first. Area is capped so a single
    # fire/stair block cannot outrank many small survey boxes.
    priority_score = (
        red_marker_score * 10.0
        + math.sqrt(max(0.0, weighted_red_area)) * 0.40
        + red_marker_count * 1.6
        - large_false_red_count * 2.5
        - hatch_like_count * 2.0
    )
    if red_marker_count <= 3 and large_false_red_count >= 2:
        priority_score *= 0.55
    if red_marker_count == 0:
        priority_score = 0.0

    marker_area_total = green_area + blue_area + pink_area + orange_area + int(weighted_red_area)
    return {
        "page": page_number,
        "priority_score": round(priority_score, 4),
        "red_marker_score": round(red_marker_score, 4),
        "red_marker_count": red_marker_count,
        "weighted_red_area": round(weighted_red_area, 2),
        "large_false_red_count": large_false_red_count,
        "hatch_like_count": hatch_like_count,
        "green_components": green_components,
        "green_area": green_area,
        "blue_components": blue_components,
        "blue_area": blue_area,
        "pink_components": pink_components,
        "pink_area": pink_area,
        "orange_components": orange_components,
        "orange_area": orange_area,
        "marker_area_total": int(marker_area_total),
        "red_marker_pct": round(100.0 * weighted_red_area / marker_area_total, 4)
        if marker_area_total
        else 0.0,
        "accepted_candidates": [asdict(c) for c in accepted],
        "all_candidates": [asdict(c) for c in candidates],
    }


def write_csv(rows: list[dict[str, Any]], output_path: Path) -> None:
    fields = [
        "rank",
        "page",
        "priority_score",
        "red_marker_score",
        "red_marker_count",
        "weighted_red_area",
        "red_marker_pct",
        "large_false_red_count",
        "hatch_like_count",
        "green_components",
        "blue_components",
        "pink_components",
        "orange_components",
        "marker_area_total",
    ]
    with output_path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        for rank, row in enumerate(rows, 1):
            writer.writerow({field: (rank if field == "rank" else row.get(field, "")) for field in fields})


def write_pdf(input_pdf: Path, rows: list[dict[str, Any]], output_path: Path) -> None:
    reader = PdfReader(str(input_pdf))
    writer = PdfWriter()
    for row in rows:
        writer.add_page(reader.pages[int(row["page"]) - 1])
    with output_path.open("wb") as fh:
        writer.write(fh)


def draw_debug(rgb: np.ndarray, row: dict[str, Any], output_path: Path) -> None:
    image = Image.fromarray(rgb).convert("RGB")
    draw = ImageDraw.Draw(image)
    for raw in row["all_candidates"]:
        x, y, w, h = (int(raw[key]) for key in ("x", "y", "w", "h"))
        score = float(raw["score"])
        if score <= 0:
            color = (150, 150, 150)
            width = 1
            label = str(raw["reject_reason"])
        elif score >= 0.85:
            color = (220, 0, 0)
            width = 3
            label = f"{score:.1f}"
        else:
            color = (255, 170, 0)
            width = 2
            label = f"{score:.1f}"
        draw.rectangle((x, y, x + w, y + h), outline=color, width=width)
        if score > 0:
            draw.text((x, max(0, y - 14)), label, fill=color)
    draw.text(
        (20, 20),
        f"page {row['page']} score {row['priority_score']} count {row['red_marker_count']}",
        fill=(0, 0, 0),
    )
    image.thumbnail((1500, 1900), Image.Resampling.LANCZOS)
    image.save(output_path, optimize=True)


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
            float(row["priority_score"]),
            float(row["red_marker_score"]),
            int(row["red_marker_count"]),
            float(row["weighted_red_area"]),
        ),
        reverse=True,
    )

    csv_path = args.output_dir / "calibrated_marker_priority_summary_1019_1115.csv"
    pdf_path = args.output_dir / "calibrated_marker_priority_sorted_pages_1019_1115.pdf"
    json_path = args.output_dir / "calibrated_marker_priority_debug_1019_1115.json"
    write_csv(rows, csv_path)
    write_pdf(args.pdf, rows, pdf_path)
    json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    debug_dir = args.output_dir / "debug_pages"
    debug_dir.mkdir(exist_ok=True)
    debug_pages = {int(part.strip()) for part in args.debug_pages.split(",") if part.strip()}
    by_page = {int(row["page"]): row for row in rows}
    for page in sorted(debug_pages):
        if page in by_page:
            draw_debug(render_page(pdf, page, args.scale), by_page[page], debug_dir / f"page_{page}_calibrated.png")

    print(f"Wrote {pdf_path}")
    print(f"Wrote {csv_path}")
    print(f"Wrote {json_path}")
    print("Top 20 calibrated pages:")
    for rank, row in enumerate(rows[:20], 1):
        print(
            f"{rank:02d}. page {row['page']} score={row['priority_score']} "
            f"count={row['red_marker_count']} red_score={row['red_marker_score']}"
        )


if __name__ == "__main__":
    main()
