from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Callable

import cv2
import joblib
import numpy as np
import pypdfium2 as pdfium

from detector_count_features import detector_count_feature_vector
from detector_features import page_features_from_rgb


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate detector count robustness on unseen scan-like transforms."
    )
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--truth", type=Path, default=Path("countedvalues.txt"))
    parser.add_argument("--model", type=Path, default=Path("model/detector_count_estimator.joblib"))
    parser.add_argument("--start-page", type=int, default=1019)
    parser.add_argument("--end-page", type=int, default=1115)
    parser.add_argument("--scale", type=float, default=2.0)
    parser.add_argument("--priority-color", default="red")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("output/pdf/detector_robustness/robustness_metrics_1019_1115.json"),
    )
    return parser.parse_args()


def read_truth(path: Path) -> dict[int, int]:
    truth: dict[int, int] = {}
    pattern = re.compile(r"^\s*(\d+)\s*=\s*(\d+)\s*$")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            truth[int(match.group(1))] = int(match.group(2))
    return truth


def clip_rgb(image: np.ndarray) -> np.ndarray:
    return np.clip(image, 0, 255).astype("uint8")


def gamma_transform(gamma: float) -> Callable[[np.ndarray], np.ndarray]:
    table = np.array([((value / 255.0) ** gamma) * 255 for value in range(256)]).astype("uint8")

    def transform(image: np.ndarray) -> np.ndarray:
        return cv2.LUT(image, table)

    return transform


def contrast(alpha: float, beta: float) -> Callable[[np.ndarray], np.ndarray]:
    def transform(image: np.ndarray) -> np.ndarray:
        return clip_rgb(image.astype("float32") * alpha + beta)

    return transform


def sharpen(image: np.ndarray) -> np.ndarray:
    blurred = cv2.GaussianBlur(image, (0, 0), 1.0)
    return clip_rgb(image.astype("float32") * 1.55 - blurred.astype("float32") * 0.55)


def mild_noise(image: np.ndarray) -> np.ndarray:
    rng = np.random.default_rng(12345)
    noise = rng.normal(0, 4.5, image.shape).astype("float32")
    return clip_rgb(image.astype("float32") + noise)


def erode_color_bleed(image: np.ndarray) -> np.ndarray:
    blurred = cv2.GaussianBlur(image, (3, 3), 0)
    return cv2.addWeighted(image, 0.72, blurred, 0.28, 0)


TRANSFORMS: list[tuple[str, Callable[[np.ndarray], np.ndarray]]] = [
    ("original", lambda image: image),
    ("gamma_dark_unseen", gamma_transform(1.18)),
    ("gamma_light_unseen", gamma_transform(0.86)),
    ("contrast_low_unseen", contrast(0.86, 12.0)),
    ("contrast_high_unseen", contrast(1.16, -10.0)),
    ("mild_noise_unseen", mild_noise),
    ("sharpen_unseen", sharpen),
    ("color_bleed_unseen", erode_color_bleed),
]


def pairwise_rank_agreement(predicted: np.ndarray, actual: np.ndarray) -> float:
    agree = 0.0
    total = 0
    for left in range(len(actual)):
        for right in range(left + 1, len(actual)):
            if actual[left] == actual[right]:
                continue
            total += 1
            direction = (predicted[left] - predicted[right]) * (actual[left] - actual[right])
            if direction > 0:
                agree += 1.0
            elif predicted[left] == predicted[right]:
                agree += 0.5
    return (agree / total) * 100.0 if total else 100.0


def metrics(records: list[dict[str, int | float | str]]) -> dict[str, float | int]:
    actual = np.array([float(row["actual_count"]) for row in records], dtype=float)
    predicted = np.array([float(row["predicted_count"]) for row in records], dtype=float)
    errors = np.abs(predicted - actual)
    tolerance = np.maximum(1.0, actual * 0.05)
    total_actual = float(actual.sum())
    return {
        "pages": len(records),
        "mae": round(float(errors.mean()), 4),
        "rmse": round(float(math.sqrt(np.mean(errors * errors))), 4),
        "max_error": int(errors.max()) if len(errors) else 0,
        "exact_pages": int((errors == 0).sum()),
        "within_5_percent_pages": int((errors <= tolerance).sum()),
        "within_5_marks_pages": int((errors <= 5).sum()),
        "total_actual": int(total_actual),
        "total_predicted": int(predicted.sum()),
        "total_error_pct": round(float(((predicted.sum() - total_actual) / total_actual) * 100.0), 4)
        if total_actual
        else 0.0,
        "pairwise_rank_agreement_pct": round(pairwise_rank_agreement(predicted, actual), 4),
    }


def main() -> None:
    args = parse_args()
    truth = read_truth(args.truth)
    model = joblib.load(args.model)
    estimator = model["estimator"]
    pdf = pdfium.PdfDocument(str(args.pdf))
    results: dict[str, object] = {
        "model": str(args.model),
        "source_range": f"{args.start_page}-{args.end_page}",
        "transforms": {},
    }
    try:
        rendered_pages = {
            page_number: np.array(pdf[page_number - 1].render(scale=args.scale).to_pil().convert("RGB"))
            for page_number in range(args.start_page, args.end_page + 1)
            if page_number in truth
        }
        for transform_name, transform in TRANSFORMS:
            records: list[dict[str, int | float | str]] = []
            for page_number, rgb in rendered_pages.items():
                row = page_features_from_rgb(transform(rgb), page_number, args.priority_color)
                vector = detector_count_feature_vector(row, args.priority_color)
                raw = float(estimator.predict([vector])[0])
                predicted = int(max(0, round(raw)))
                actual = int(truth[page_number])
                records.append(
                    {
                        "page": page_number,
                        "actual_count": actual,
                        "predicted_count": predicted,
                        "error": predicted - actual,
                        "abs_error": abs(predicted - actual),
                    }
                )
            transform_result = {
                "metrics": metrics(records),
                "failures": [
                    row
                    for row in records
                    if float(row["abs_error"]) > max(1.0, float(row["actual_count"]) * 0.05)
                ],
            }
            results["transforms"][transform_name] = transform_result
            print(json.dumps({transform_name: transform_result["metrics"]}, ensure_ascii=False), flush=True)
    finally:
        if hasattr(pdf, "close"):
            pdf.close()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
