from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from sklearn.base import clone
from sklearn.ensemble import ExtraTreesRegressor, GradientBoostingRegressor
from sklearn.model_selection import StratifiedGroupKFold, StratifiedKFold

from detector_count_features import detector_count_feature_names, detector_count_feature_vector


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train detector-only count estimator from source truth."
    )
    parser.add_argument(
        "--features",
        type=Path,
        default=Path("output/pdf/opencv_truth_retrained_current/truth_calibrated_red_box_debug_1019_1115.json"),
    )
    parser.add_argument("--truth", type=Path, default=Path("countedvalues.txt"))
    parser.add_argument("--output", type=Path, default=Path("model/detector_count_estimator.joblib"))
    parser.add_argument("--metadata", type=Path, default=Path("model/detector_count_estimator_metrics.json"))
    parser.add_argument("--algorithm", choices=("gbr", "extra_trees"), default="gbr")
    parser.add_argument("--n-estimators", type=int, default=160)
    parser.add_argument("--learning-rate", type=float, default=0.1)
    parser.add_argument("--max-depth", type=int, default=3, help="Use 0 for unlimited tree depth.")
    parser.add_argument("--min-samples-leaf", type=int, default=4)
    parser.add_argument("--subsample", type=float, default=0.8)
    parser.add_argument("--max-features", default="sqrt")
    parser.add_argument("--random-state", type=int, default=3)
    parser.add_argument(
        "--group-holdout",
        action="store_true",
        help="Use source_page groups and score holdout only on original rows.",
    )
    return parser.parse_args()


def build_estimator(args: argparse.Namespace) -> Any:
    max_depth = None if args.max_depth == 0 else args.max_depth
    if args.algorithm == "extra_trees":
        return ExtraTreesRegressor(
            n_estimators=args.n_estimators,
            max_depth=max_depth,
            min_samples_leaf=args.min_samples_leaf,
            max_features=args.max_features,
            random_state=args.random_state,
            n_jobs=-1,
        )
    return GradientBoostingRegressor(
        n_estimators=args.n_estimators,
        learning_rate=args.learning_rate,
        max_depth=max_depth,
        min_samples_leaf=args.min_samples_leaf,
        subsample=args.subsample,
        random_state=args.random_state,
    )


def estimator_metadata(args: argparse.Namespace) -> dict[str, Any]:
    max_depth = None if args.max_depth == 0 else args.max_depth
    if args.algorithm == "extra_trees":
        return {
            "algorithm": "sklearn.ensemble.ExtraTreesRegressor",
            "n_estimators": args.n_estimators,
            "max_depth": max_depth,
            "min_samples_leaf": args.min_samples_leaf,
            "max_features": args.max_features,
            "random_state": args.random_state,
        }
    return {
        "algorithm": "sklearn.ensemble.GradientBoostingRegressor",
        "n_estimators": args.n_estimators,
        "learning_rate": args.learning_rate,
        "max_depth": max_depth,
        "min_samples_leaf": args.min_samples_leaf,
        "subsample": args.subsample,
        "random_state": args.random_state,
    }


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


def metrics(predicted: np.ndarray, actual: np.ndarray) -> dict[str, float | int]:
    rounded = np.rint(np.maximum(0.0, predicted))
    errors = np.abs(rounded - actual)
    tolerance = np.maximum(1.0, actual * 0.05)
    total_actual = float(actual.sum())
    return {
        "mae": round(float(errors.mean()), 4),
        "rmse": round(float(math.sqrt(np.mean(errors * errors))), 4),
        "max_error": int(errors.max()),
        "exact_pages": int((errors == 0).sum()),
        "within_5_percent_pages": int((errors <= tolerance).sum()),
        "within_5_marks_pages": int((errors <= 5).sum()),
        "total_actual": int(total_actual),
        "total_predicted": int(rounded.sum()),
        "total_error_pct": round(float(((rounded.sum() - total_actual) / total_actual) * 100.0), 4)
        if total_actual
        else 0.0,
        "pairwise_rank_agreement_pct": round(pairwise_rank_agreement(rounded, actual), 4),
    }


def main() -> None:
    args = parse_args()
    rows = json.loads(args.features.read_text(encoding="utf-8"))
    truth = read_truth(args.truth)
    rows = [row for row in rows if int(row.get("source_page", row["page"])) in truth]
    actual = np.array([truth[int(row.get("source_page", row["page"]))] for row in rows], dtype=float)
    feature_names = detector_count_feature_names("red")
    matrix = np.array([detector_count_feature_vector(row, "red") for row in rows], dtype=float)
    groups = np.array([int(row.get("source_page", row["page"])) for row in rows], dtype=int)
    original_mask = np.array([str(row.get("augmentation", "original")) == "original" for row in rows], dtype=bool)

    estimator = build_estimator(args)
    bins = np.digitize(actual, [1, 10, 20, 50, 100])
    holdout_predicted = np.zeros(len(rows), dtype=float)
    holdout_original_indices: list[int] = []
    if args.group_holdout:
        splitter = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=42)
        for train_index, test_index in splitter.split(matrix, bins, groups):
            fold_estimator = clone(estimator)
            fold_estimator.fit(matrix[train_index], actual[train_index])
            holdout_predicted[test_index] = fold_estimator.predict(matrix[test_index])
            holdout_original_indices.extend([int(index) for index in test_index if original_mask[index]])
    else:
        splitter = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
        for train_index, test_index in splitter.split(matrix, bins):
            fold_estimator = clone(estimator)
            fold_estimator.fit(matrix[train_index], actual[train_index])
            holdout_predicted[test_index] = fold_estimator.predict(matrix[test_index])
        holdout_original_indices = [int(index) for index in range(len(rows)) if original_mask[index]]

    estimator.fit(matrix, actual)
    in_sample_predicted = estimator.predict(matrix)
    original_indices = np.array([int(index) for index in range(len(rows)) if original_mask[index]], dtype=int)
    holdout_original_indices_array = np.array(sorted(holdout_original_indices), dtype=int)
    metadata: dict[str, Any] = {
        "kind": "detector_tree_ensemble_estimator",
        "source_truth": str(args.truth),
        "source_features": str(args.features),
        "source_range": "1019-1115",
        "notes": (
            "Trained from detector-derived features only. Page id and source-truth "
            "lookup tables are not model inputs."
        ),
        "estimator": estimator_metadata(args),
        "feature_count": len(feature_names),
        "feature_names": feature_names,
        "training_rows": len(rows),
        "training_pages": len(set(int(group) for group in groups)),
        "augmentations": sorted({str(row.get("augmentation", "original")) for row in rows}),
        "in_sample": metrics(in_sample_predicted, actual),
        "in_sample_original": metrics(in_sample_predicted[original_indices], actual[original_indices]),
        "holdout_5_fold": metrics(holdout_predicted, actual),
        "holdout_5_fold_original": metrics(
            holdout_predicted[holdout_original_indices_array],
            actual[holdout_original_indices_array],
        ),
        "holdout_mode": "stratified_group_by_source_page" if args.group_holdout else "stratified_rows",
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {
            "kind": "detector_tree_ensemble_estimator",
            "estimator": estimator,
            "metadata": metadata,
        },
        args.output,
    )
    args.metadata.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
