from __future__ import annotations

import argparse
import json
import math
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

import joblib
import numpy as np

from detector_count_features import detector_count_feature_vector


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate a trained detector model on feature JSON.")
    parser.add_argument("features", type=Path)
    parser.add_argument("--truth", type=Path, default=Path("countedvalues.txt"))
    parser.add_argument("--model", type=Path, default=Path("model/detector_count_estimator.joblib"))
    parser.add_argument("--output", type=Path, default=Path("output/pdf/detector_feature_eval/feature_metrics.json"))
    return parser.parse_args()


def read_truth(path: Path) -> dict[int, int]:
    truth: dict[int, int] = {}
    pattern = re.compile(r"^\s*(\d+)\s*=\s*(\d+)\s*$")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            truth[int(match.group(1))] = int(match.group(2))
    return truth


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


def metrics(records: list[dict[str, Any]]) -> dict[str, float | int]:
    actual = np.array([float(row["actual_count"]) for row in records], dtype=float)
    predicted = np.array([float(row["predicted_count"]) for row in records], dtype=float)
    errors = np.abs(predicted - actual)
    tolerance = np.maximum(1.0, actual * 0.05)
    total_actual = float(actual.sum())
    return {
        "rows": len(records),
        "mae": round(float(errors.mean()), 4) if len(errors) else 0.0,
        "rmse": round(float(math.sqrt(np.mean(errors * errors))), 4) if len(errors) else 0.0,
        "max_error": int(errors.max()) if len(errors) else 0,
        "exact_rows": int((errors == 0).sum()),
        "within_5_percent_rows": int((errors <= tolerance).sum()),
        "within_5_marks_rows": int((errors <= 5).sum()),
        "total_actual": int(total_actual),
        "total_predicted": int(predicted.sum()) if len(predicted) else 0,
        "total_error_pct": round(float(((predicted.sum() - total_actual) / total_actual) * 100.0), 4)
        if total_actual
        else 0.0,
        "pairwise_rank_agreement_pct": round(pairwise_rank_agreement(predicted, actual), 4)
        if len(records)
        else 100.0,
    }


def main() -> None:
    args = parse_args()
    rows = json.loads(args.features.read_text(encoding="utf-8"))
    truth = read_truth(args.truth)
    model = joblib.load(args.model)
    estimator = model["estimator"]
    if hasattr(estimator, "n_jobs"):
        estimator.n_jobs = 1
    records: list[dict[str, Any]] = []
    by_augmentation: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        page = int(row.get("source_page", row["page"]))
        if page not in truth:
            continue
        augmentation = str(row.get("augmentation", "original"))
        raw = float(estimator.predict([detector_count_feature_vector(row, "red")])[0])
        predicted = int(max(0, round(raw)))
        actual = int(truth[page])
        record = {
            "page": page,
            "augmentation": augmentation,
            "actual_count": actual,
            "predicted_count": predicted,
            "error": predicted - actual,
            "abs_error": abs(predicted - actual),
        }
        records.append(record)
        by_augmentation[augmentation].append(record)

    result = {
        "model": str(args.model),
        "features": str(args.features),
        "overall": metrics(records),
        "by_augmentation": {
            name: metrics(items) for name, items in sorted(by_augmentation.items())
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result["by_augmentation"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
