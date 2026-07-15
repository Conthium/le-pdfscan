from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Tune detector-derived count estimators with source-truth and holdout metrics."
    )
    parser.add_argument(
        "--features",
        type=Path,
        default=Path("output/pdf/opencv_truth_retrained_current/truth_calibrated_red_box_debug_1019_1115.json"),
    )
    parser.add_argument("--truth", type=Path, default=Path("countedvalues.txt"))
    parser.add_argument("--top", type=int, default=25)
    return parser.parse_args()


def read_truth(path: Path) -> dict[int, int]:
    truth: dict[int, int] = {}
    pattern = re.compile(r"^\s*(\d+)\s*=\s*(\d+)\s*$")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            truth[int(match.group(1))] = int(match.group(2))
    return truth


def value(row: dict[str, Any], key: str) -> float:
    try:
        return float(row.get(key, 0) or 0)
    except (TypeError, ValueError):
        return 0.0


def pairwise_rank_agreement(pred: np.ndarray, truth: np.ndarray) -> float:
    agree = 0.0
    total = 0
    for i in range(len(truth)):
        for j in range(i + 1, len(truth)):
            if truth[i] == truth[j]:
                continue
            total += 1
            direction = (pred[i] - pred[j]) * (truth[i] - truth[j])
            if direction > 0:
                agree += 1.0
            elif pred[i] == pred[j]:
                agree += 0.5
    return (agree / total) * 100.0 if total else 100.0


def metrics(predicted: np.ndarray, actual: np.ndarray) -> dict[str, float | int]:
    rounded = np.rint(np.maximum(0.0, predicted))
    errors = np.abs(rounded - actual)
    tolerance = np.maximum(1.0, actual * 0.05)
    total_actual = float(actual.sum())
    return {
        "mae": round(float(errors.mean()), 4),
        "rmse": round(float(math.sqrt(np.mean(errors * errors))), 4),
        "max_error": int(errors.max()),
        "within_5_percent_pages": int((errors <= tolerance).sum()),
        "within_5_marks_pages": int((errors <= 5).sum()),
        "exact_pages": int((errors == 0).sum()),
        "total_error_pct": round(float(((rounded.sum() - total_actual) / total_actual) * 100.0), 4)
        if total_actual
        else 0.0,
        "pairwise_rank_agreement_pct": round(pairwise_rank_agreement(rounded, actual), 4),
    }


def build_matrix(rows: list[dict[str, Any]], keys: list[tuple[str, float]], transforms: tuple[str, ...]) -> np.ndarray:
    columns = [np.ones(len(rows), dtype=float)]
    for key, scale in keys:
        raw = np.array([value(row, key) / scale for row in rows], dtype=float)
        nonnegative = np.maximum(raw, 0.0)
        if "raw" in transforms:
            columns.append(raw)
        if "sqrt" in transforms:
            columns.append(np.sqrt(nonnegative))
        if "log" in transforms:
            columns.append(np.log1p(nonnegative))
    return np.column_stack(columns)


def fit_ridge(x: np.ndarray, y: np.ndarray, ridge_lambda: float) -> np.ndarray:
    penalty = ridge_lambda * np.eye(x.shape[1])
    penalty[0, 0] = 0.0
    return np.linalg.pinv(x.T @ x + penalty) @ x.T @ y


def low_signal_gate(rows: list[dict[str, Any]], params: tuple[float, float, float, float]) -> np.ndarray:
    avg_text_area_min, text_count_min, marker_area_max, cal_priority_max = params
    mask = np.zeros(len(rows), dtype=bool)
    for idx, row in enumerate(rows):
        text_count = value(row, "text_red_text_box_count")
        text_area = value(row, "text_accepted_red_area")
        avg_text_area = text_area / max(1.0, text_count)
        marker_area = value(row, "color_red_marker_area")
        cal_priority = value(row, "cal_priority_score")
        marker_count = value(row, "color_red_marker_count")
        if text_count >= text_count_min and avg_text_area < avg_text_area_min and marker_area <= marker_area_max:
            mask[idx] = True
        if cal_priority <= cal_priority_max and marker_count <= 1:
            mask[idx] = True
    return mask


def main() -> None:
    args = parse_args()
    rows = json.loads(args.features.read_text(encoding="utf-8"))
    truth = read_truth(args.truth)
    rows = [row for row in rows if int(row["page"]) in truth]
    actual = np.array([truth[int(row["page"])] for row in rows], dtype=float)
    order = np.argsort(actual)
    folds = [order[index::5] for index in range(5)]

    key_sets = {
        "core": [
            ("color_red_marker_area", 1000.0),
            ("color_red_marker_count", 1.0),
            ("color_red_marker_score", 1.0),
            ("text_red_text_box_count", 1.0),
            ("text_accepted_red_regions", 1.0),
            ("cal_red_marker_count", 1.0),
            ("cal_red_marker_score", 1.0),
            ("cal_priority_score", 100.0),
            ("cal_large_false_red_count", 1.0),
            ("cal_hatch_like_count", 1.0),
        ],
        "all": [
            ("color_red_marker_area", 1000.0),
            ("color_red_marker_count", 1.0),
            ("color_red_marker_score", 1.0),
            ("color_red_area", 1000.0),
            ("color_red_components", 1.0),
            ("text_red_text_box_count", 1.0),
            ("text_accepted_red_regions", 1.0),
            ("text_accepted_red_area", 1000.0),
            ("cal_red_marker_count", 1.0),
            ("cal_red_marker_score", 1.0),
            ("cal_weighted_red_area", 1000.0),
            ("cal_priority_score", 100.0),
            ("cal_large_false_red_count", 1.0),
            ("cal_hatch_like_count", 1.0),
            ("text_large_rejected_regions", 1.0),
        ],
    }
    gate_params = [
        (0.0, 999.0, 0.0, -1.0),
        (60.0, 20.0, 800.0, -1.0),
        (80.0, 20.0, 1500.0, 25.0),
        (100.0, 30.0, 3000.0, 50.0),
    ]
    results: list[tuple[tuple[float, ...], dict[str, Any]]] = []
    for key_name, keys in key_sets.items():
        for transforms in [("raw",), ("raw", "sqrt"), ("raw", "log"), ("raw", "sqrt", "log")]:
            matrix = build_matrix(rows, keys, transforms)
            for ridge_lambda in [0.1, 1.0, 3.0, 10.0, 30.0, 100.0, 300.0, 1000.0, 3000.0]:
                coefficients = fit_ridge(matrix, actual, ridge_lambda)
                fitted = matrix @ coefficients
                for gate in gate_params:
                    mask = low_signal_gate(rows, gate)
                    gated = fitted.copy()
                    gated[mask] = 0.0
                    in_sample = metrics(gated, actual)

                    cv_pred = np.zeros(len(rows), dtype=float)
                    for fold in folds:
                        train = np.setdiff1d(np.arange(len(rows)), fold)
                        cv_coefficients = fit_ridge(matrix[train], actual[train], ridge_lambda)
                        cv_pred[fold] = matrix[fold] @ cv_coefficients
                    cv_masked = cv_pred.copy()
                    cv_masked[mask] = 0.0
                    holdout = metrics(cv_masked, actual)
                    score = (
                        -float(holdout["pairwise_rank_agreement_pct"]),
                        float(holdout["mae"]),
                        -float(in_sample["within_5_percent_pages"]),
                        float(in_sample["mae"]),
                    )
                    results.append(
                        (
                            score,
                            {
                                "key_set": key_name,
                                "transforms": transforms,
                                "ridge_lambda": ridge_lambda,
                                "gate": gate,
                                "in_sample": in_sample,
                                "holdout": holdout,
                            },
                        )
                    )

    for _score, result in sorted(results)[: args.top]:
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
