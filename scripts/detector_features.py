from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pypdfium2 as pdfium

import analyze_pdf_color_priority as color_detector
import analyze_pdf_marker_priority_calibrated as marker_detector
import create_text_anchored_source_truth as text_detector

DETECTOR_VERSION = "red-source-truth-detectors-2026-06-20"


def scalar_numeric(value: Any) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, int | float):
        return float(value)
    return None


def add_numeric_features(target: dict[str, Any], prefix: str, source: dict[str, Any]) -> None:
    for key, item in source.items():
        if key in {"page", "accepted_candidates", "all_candidates", "regions", "text_anchors"}:
            continue
        numeric = scalar_numeric(item)
        if numeric is not None:
            target[f"{prefix}_{key}"] = numeric


def page_features_from_rgb(
    rgb: np.ndarray,
    page_number: int,
    priority_color: str = "red",
) -> dict[str, Any]:
    color = color_detector.analyze_rgb(rgb, page_number, priority_color)
    marker = marker_detector.analyze_rgb_for_color(rgb, page_number, priority_color)
    text = text_detector.analyze_rgb_for_color(rgb, page_number, priority_color)

    features: dict[str, Any] = {
        "page": page_number,
        "color_debug": color,
        "marker_debug": {
            key: item
            for key, item in marker.items()
            if key not in {"accepted_candidates", "all_candidates"}
        },
        "text_debug": {
            key: item
            for key, item in text.items()
            if key != "regions"
        },
    }
    add_numeric_features(features, "color", color)
    add_numeric_features(features, "cal", marker)
    add_numeric_features(features, "text", text)
    return features


def scanner_workers(page_count: int) -> int:
    configured = os.environ.get("SCANNER_WORKERS", "").strip()
    if configured:
        try:
            return max(1, min(int(configured), page_count))
        except ValueError:
            pass
    return max(1, min(4, os.cpu_count() or 1, page_count))


def scan_rows(
    input_pdf: Path,
    start_page: int,
    end_page: int,
    scale: float,
    priority_color: str = "red",
    progress_callback: Callable[[int, int, int], None] | None = None,
) -> list[dict[str, Any]]:
    workers = scanner_workers(end_page - start_page + 1)
    batch_size = max(1, workers * 2)
    pdf = pdfium.PdfDocument(str(input_pdf))
    rows: list[dict[str, Any]] = []
    completed = 0
    total = end_page - start_page + 1
    try:
        for batch_start in range(start_page, end_page + 1, batch_size):
            batch_end = min(end_page, batch_start + batch_size - 1)
            rendered = [
                (
                    page_number,
                    np.array(pdf[page_number - 1].render(scale=scale).to_pil().convert("RGB")),
                )
                for page_number in range(batch_start, batch_end + 1)
            ]
            if workers == 1 or len(rendered) == 1:
                batch_rows = (
                    page_features_from_rgb(rgb, page_number, priority_color)
                    for page_number, rgb in rendered
                )
            else:
                with ThreadPoolExecutor(max_workers=min(workers, len(rendered))) as executor:
                    batch_rows = executor.map(
                        lambda item: page_features_from_rgb(item[1], item[0], priority_color),
                        rendered,
                    )
                    for row in batch_rows:
                        rows.append(row)
                        completed += 1
                        if progress_callback:
                            progress_callback(int(row["page"]), completed, total)
                    continue

            for row in batch_rows:
                rows.append(row)
                completed += 1
                if progress_callback:
                    progress_callback(int(row["page"]), completed, total)
    finally:
        if hasattr(pdf, "close"):
            pdf.close()
    return rows
