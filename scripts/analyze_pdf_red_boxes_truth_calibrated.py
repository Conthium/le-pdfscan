from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pypdfium2 as pdfium
from pypdf import PdfReader, PdfWriter

import analyze_pdf_color_priority as color_detector
import analyze_pdf_marker_priority_calibrated as marker_detector
import create_text_anchored_source_truth as text_detector

DETECTOR_VERSION = "red-source-truth-detectors-2026-06-20"


NON_FEATURE_KEYS = {
    "page",
    "actual_count",
    "predicted_count",
    "predicted_raw",
    "error",
    "abs_error",
    "color_debug",
    "marker_debug",
    "text_debug",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Fuse OpenCV red-marker features and calibrate them against "
            "countedvalues.txt for the 1019-1115 source-truth set."
        )
    )
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--truth", type=Path, default=Path("countedvalues.txt"))
    parser.add_argument("--start-page", type=int, default=1019)
    parser.add_argument("--end-page", type=int, default=1115)
    parser.add_argument("--scale", type=float, default=2.0)
    parser.add_argument("--output-dir", type=Path, default=Path("output/pdf/opencv_truth_calibrated"))
    parser.add_argument("--lambda", dest="ridge_lambda", type=float, default=0.0)
    return parser.parse_args()


def read_truth(path: Path) -> dict[int, int]:
    truth: dict[int, int] = {}
    pattern = re.compile(r"^\s*(\d+)\s*=\s*(\d+)\s*$")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            truth[int(match.group(1))] = int(match.group(2))
    if not truth:
        raise SystemExit(f"No truth values found in {path}")
    return truth


def num(row: dict[str, Any], key: str) -> float:
    try:
        return float(row.get(key, 0) or 0)
    except (TypeError, ValueError):
        return 0.0


def scalar_numeric(value: Any) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, int | float):
        return float(value)
    return None


def add_numeric_features(target: dict[str, Any], prefix: str, source: dict[str, Any]) -> None:
    for key, value in source.items():
        if key in {"page", "accepted_candidates", "all_candidates", "regions", "text_anchors"}:
            continue
        numeric = scalar_numeric(value)
        if numeric is not None:
            target[f"{prefix}_{key}"] = numeric


def page_features(
    color_pdf: pdfium.PdfDocument,
    marker_pdf: pdfium.PdfDocument,
    text_pdf: pdfium.PdfDocument,
    page_number: int,
    scale: float,
) -> dict[str, Any]:
    # Each detector has different morphology and filtering. Keeping the raw
    # signals separate lets the truth calibration learn which signal to trust.
    rgb = np.array(color_pdf[page_number - 1].render(scale=scale).to_pil().convert("RGB"))
    return page_features_from_rgb(rgb, page_number)


def page_features_from_rgb(
    rgb: np.ndarray,
    page_number: int,
    priority_color: str = "red",
) -> dict[str, Any]:
    # Each detector has different morphology and filtering. Keeping the raw
    # signals separate lets the truth calibration learn which signal to trust.
    color = color_detector.analyze_rgb(rgb, page_number)
    marker = marker_detector.analyze_rgb_for_color(rgb, page_number, priority_color)
    text = text_detector.analyze_rgb_for_color(rgb, page_number, priority_color)

    features: dict[str, Any] = {
        "page": page_number,
        "color_debug": color,
        "marker_debug": {
            key: value
            for key, value in marker.items()
            if key not in {"accepted_candidates", "all_candidates"}
        },
        "text_debug": {
            key: value
            for key, value in text.items()
            if key != "regions"
        },
    }
    add_numeric_features(features, "color", color)
    add_numeric_features(features, "cal", marker)
    add_numeric_features(features, "text", text)
    return features


def feature_names(rows: list[dict[str, Any]]) -> list[str]:
    names: set[str] = set()
    for row in rows:
        for key, value in row.items():
            if key in NON_FEATURE_KEYS:
                continue
            if scalar_numeric(value) is not None:
                names.add(key)
    return sorted(names)


def design_matrix(rows: list[dict[str, Any]], names: list[str]) -> np.ndarray:
    columns = [np.ones(len(rows), dtype=float)]
    for name in names:
        values = np.array([float(row.get(name, 0) or 0) for row in rows], dtype=float)
        nonnegative = np.maximum(values, 0.0)
        columns.extend(
            [
                values,
                np.sqrt(nonnegative),
                np.log1p(nonnegative),
            ]
        )
    return np.column_stack(columns)


def fit_counts(
    rows: list[dict[str, Any]],
    truth: dict[int, int],
    ridge_lambda: float,
    names: list[str],
) -> np.ndarray:
    x = design_matrix(rows, names)
    y = np.array([truth[int(row["page"])] for row in rows], dtype=float)
    penalty = ridge_lambda * np.eye(x.shape[1])
    penalty[0, 0] = 0.0
    return np.linalg.pinv(x.T @ x + penalty) @ x.T @ y


def predict_counts(rows: list[dict[str, Any]], coefficients: np.ndarray, names: list[str]) -> None:
    raw = design_matrix(rows, names) @ coefficients
    for row, value in zip(rows, raw):
        row["predicted_raw"] = round(float(value), 6)
        row["predicted_count"] = int(max(0, round(float(value))))


def rank_map(values: dict[int, float]) -> dict[int, int]:
    return {
        page: rank
        for rank, (page, _count) in enumerate(
            sorted(values.items(), key=lambda item: (item[1], item[0]), reverse=True),
            1,
        )
    }


def spearman(truth: dict[int, int], rows: list[dict[str, Any]]) -> float:
    pages = [int(row["page"]) for row in rows]
    truth_rank = rank_map({page: float(truth[page]) for page in pages})
    pred_rank = rank_map({int(row["page"]): float(row["predicted_count"]) for row in rows})
    n = len(pages)
    if n < 2:
        return 0.0
    d2 = sum((truth_rank[page] - pred_rank[page]) ** 2 for page in pages)
    return 1.0 - (6.0 * d2) / (n * (n * n - 1))


def add_errors(rows: list[dict[str, Any]], truth: dict[int, int]) -> dict[str, Any]:
    abs_errors: list[float] = []
    sq_errors: list[float] = []
    for row in rows:
        actual = truth[int(row["page"])]
        predicted = int(row["predicted_count"])
        error = predicted - actual
        row["actual_count"] = actual
        row["error"] = error
        row["abs_error"] = abs(error)
        abs_errors.append(abs(error))
        sq_errors.append(error * error)

    return {
        "pages": len(rows),
        "total_actual": sum(truth[int(row["page"])] for row in rows),
        "total_predicted": sum(int(row["predicted_count"]) for row in rows),
        "mae": round(sum(abs_errors) / len(abs_errors), 4),
        "rmse": round(math.sqrt(sum(sq_errors) / len(sq_errors)), 4),
        "exact_pages": sum(1 for row in rows if int(row["abs_error"]) == 0),
        "within_2_pages": sum(1 for row in rows if int(row["abs_error"]) <= 2),
        "within_5_pages": sum(1 for row in rows if int(row["abs_error"]) <= 5),
        "spearman_rank": round(spearman(truth, rows), 4),
    }


def write_csv(rows: list[dict[str, Any]], output_path: Path, names: list[str]) -> None:
    fields = [
        "rank",
        "page",
        "actual_count",
        "predicted_count",
        "predicted_raw",
        "error",
        "abs_error",
        *names,
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


def main() -> None:
    args = parse_args()
    if args.start_page < 1 or args.end_page < args.start_page:
        raise SystemExit("Invalid page range")

    truth = read_truth(args.truth)
    missing = [page for page in range(args.start_page, args.end_page + 1) if page not in truth]
    if missing:
        raise SystemExit(f"Missing truth values for pages: {missing[:10]}")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    rows = scan_rows(args.pdf, args.start_page, args.end_page, args.scale)
    names = feature_names(rows)
    coefficients = fit_counts(rows, truth, args.ridge_lambda, names)
    predict_counts(rows, coefficients, names)
    metrics = add_errors(rows, truth)

    sorted_rows = sorted(
        rows,
        key=lambda row: (int(row["predicted_count"]), float(row["predicted_raw"]), int(row["page"])),
        reverse=True,
    )

    csv_path = args.output_dir / "truth_calibrated_red_box_counts_1019_1115.csv"
    pdf_path = args.output_dir / "truth_calibrated_red_box_sorted_pages_1019_1115.pdf"
    json_path = args.output_dir / "truth_calibrated_red_box_debug_1019_1115.json"
    metrics_path = args.output_dir / "truth_calibrated_red_box_metrics_1019_1115.json"
    model_path = args.output_dir / "red_box_calibration_model_1019_1115.json"

    write_csv(sorted_rows, csv_path, names)
    write_pdf(args.pdf, sorted_rows, pdf_path)
    json_path.write_text(json.dumps(sorted_rows, ensure_ascii=False, indent=2), encoding="utf-8")
    model = {
        "kind": "red_box_count_linear_calibration",
        "trained_pdf": str(args.pdf),
        "truth_file": str(args.truth),
        "detector_version": DETECTOR_VERSION,
        "train_start_page": args.start_page,
        "train_end_page": args.end_page,
        "scale": args.scale,
        "feature_names": names,
        "coefficients": [float(value) for value in coefficients],
        "ridge_lambda": args.ridge_lambda,
    }
    metrics_path.write_text(
        json.dumps({**metrics, **model}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    model_path.write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote {pdf_path}")
    print(f"Wrote {csv_path}")
    print(f"Wrote {json_path}")
    print(f"Wrote {metrics_path}")
    print(f"Wrote {model_path}")
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    print("Worst 12 pages:")
    for row in sorted(rows, key=lambda item: int(item["abs_error"]), reverse=True)[:12]:
        print(
            f"page {row['page']}: actual={row['actual_count']} "
            f"pred={row['predicted_count']} error={row['error']}"
        )
    print("Top 15 predicted priority pages:")
    for rank, row in enumerate(sorted_rows[:15], 1):
        print(
            f"{rank:02d}. page {row['page']} pred={row['predicted_count']} "
            f"actual={row['actual_count']} error={row['error']}"
        )


if __name__ == "__main__":
    main()
