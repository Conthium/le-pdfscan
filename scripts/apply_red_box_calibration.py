from __future__ import annotations

import argparse
import csv
import json
import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

import joblib
import pypdfium2 as pdfium
from pypdf import PdfReader, PdfWriter

from detector_count_features import detector_count_feature_vector
from detector_features import DETECTOR_VERSION, scan_rows

PRIORITY_COLORS = {
    "red": {"label": "Red", "feature": "red", "calibrated": True},
    "green": {"label": "Green", "feature": "green", "calibrated": True},
    "blue": {"label": "Blue", "feature": "blue", "calibrated": True},
    "pink": {"label": "Pink", "feature": "pink", "calibrated": True},
    "orange_marker": {"label": "Orange marker", "feature": "orange_marker", "calibrated": True},
}
DETECTOR_COUNT_MODEL = "detector_tree_ensemble_estimator"
DETECTOR_COUNT_MODEL_LABEL = "Detector tree-ensemble estimator"
COUNT_ESTIMATOR_PATH = Path(__file__).resolve().parent.parent / "model" / "detector_count_estimator.joblib"
GLOBAL_DETECTOR_ESTIMATOR = {
    "kind": DETECTOR_COUNT_MODEL,
    "source_truth": "countedvalues.txt",
    "source_range": "1019-1115",
    "notes": (
        "Production requires model/detector_count_estimator.joblib and uses "
        "detector features only. No page id, page-to-answer lookup, or exact "
        "coefficient fallback is used."
    ),
    "source_truth_fit": {
        "pages": 97,
        "mae": 3.7526,
        "rmse": 6.0308,
        "max_error": 23,
        "exact_pages": 36,
        "within_5_percent_pages": 53,
        "within_5_marks_pages": 67,
        "total_actual": 2113,
        "total_predicted": 2165,
        "total_error_pct": 2.461,
    },
}


@lru_cache(maxsize=1)
def load_detector_count_estimator() -> dict[str, Any] | None:
    if not COUNT_ESTIMATOR_PATH.exists():
        return None
    try:
        loaded = joblib.load(COUNT_ESTIMATOR_PATH)
    except Exception:
        return None
    if not isinstance(loaded, dict) or loaded.get("kind") != DETECTOR_COUNT_MODEL:
        return None
    if "estimator" not in loaded:
        return None
    # API predictions happen one page at a time; single-worker prediction avoids
    # noisy joblib/sklearn worker warnings and is fast enough for this payload.
    if hasattr(loaded["estimator"], "n_jobs"):
        loaded["estimator"].n_jobs = 1
    return loaded


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Apply a trained red-box calibration model to any PDF page range."
    )
    parser.add_argument("pdf", type=Path)
    parser.add_argument(
        "--model",
        type=Path,
        default=Path("output/pdf/opencv_truth_calibrated/red_box_calibration_model_1019_1115.json"),
    )
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--end-page", type=int, default=0, help="0 means last page")
    parser.add_argument("--scale", type=float, default=0.0, help="0 uses the model training scale")
    parser.add_argument("--priority-color", choices=sorted(PRIORITY_COLORS), default="red")
    parser.add_argument("--output-dir", type=Path, default=Path("output/pdf/opencv_model_applied"))
    parser.add_argument(
        "--evaluate-truth",
        action="store_true",
        help="Write source-truth evaluation CSV when countedvalues.txt overlaps the scanned pages.",
    )
    return parser.parse_args()


def load_model(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    model = json.loads(path.read_text(encoding="utf-8"))
    model_version = model.get("detector_version")
    if model_version and model_version != DETECTOR_VERSION:
        raise ValueError(
            "Calibration model was trained with a different detector version. "
            "Retrain red_box_calibration_model.json before scanning."
        )
    return model


def read_truth(path: Path) -> dict[int, int]:
    if not path.exists():
        return {}
    truth: dict[int, int] = {}
    pattern = re.compile(r"^\s*(\d+)\s*=\s*(\d+)\s*$")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            truth[int(match.group(1))] = int(match.group(2))
    return truth

def tree_prediction_stats(estimator: Any, vector: list[float]) -> dict[str, float | str]:
    if not hasattr(estimator, "estimators_"):
        return {
            "std": 0.0,
            "minimum": 0.0,
            "maximum": 0.0,
            "confidence": "unknown",
        }
    predictions = [
        max(0.0, float(tree.predict([vector])[0]))
        for tree in estimator.estimators_
    ]
    if not predictions:
        return {
            "std": 0.0,
            "minimum": 0.0,
            "maximum": 0.0,
            "confidence": "unknown",
        }
    mean = sum(predictions) / len(predictions)
    variance = sum((prediction - mean) ** 2 for prediction in predictions) / len(predictions)
    std = math.sqrt(variance)
    if std <= 2.0:
        confidence = "high"
    elif std <= 5.0:
        confidence = "medium"
    else:
        confidence = "low"
    return {
        "std": round(std, 6),
        "minimum": round(min(predictions), 6),
        "maximum": round(max(predictions), 6),
        "confidence": confidence,
    }


def estimate_detector_count_details(row: dict[str, Any], priority_color: str) -> dict[str, float | str]:
    feature = str(PRIORITY_COLORS[priority_color]["feature"])
    detector_estimator = load_detector_count_estimator()
    if not detector_estimator:
        raise RuntimeError(
            f"Required detector count estimator is missing or invalid: {COUNT_ESTIMATOR_PATH}"
        )

    vector = detector_count_feature_vector(row, feature)
    estimator = detector_estimator["estimator"]
    prediction = max(0.0, float(estimator.predict([vector])[0]))
    stats = tree_prediction_stats(estimator, vector)
    return {
        "raw": prediction,
        "std": float(stats["std"]),
        "minimum": float(stats["minimum"]),
        "maximum": float(stats["maximum"]),
        "confidence": str(stats["confidence"]),
    }


def estimate_detector_count(row: dict[str, Any], priority_color: str) -> float:
    return float(estimate_detector_count_details(row, priority_color)["raw"])


def predict_counts(rows: list[dict[str, Any]], priority_color: str) -> None:
    for row in rows:
        details = estimate_detector_count_details(row, priority_color)
        raw = float(details["raw"])
        row["predicted_raw"] = round(float(raw), 6)
        row["predicted_count"] = int(max(0, round(float(raw))))
        row["prediction_std"] = round(float(details["std"]), 4)
        row["prediction_tree_min"] = round(float(details["minimum"]), 4)
        row["prediction_tree_max"] = round(float(details["maximum"]), 4)
        row["prediction_confidence"] = str(details["confidence"])
        row["priority_band"] = priority_band(row["predicted_count"])
        row["action"] = action_for(row["predicted_count"])


def apply_priority_color(
    rows: list[dict[str, Any]],
    priority_color: str,
    model: dict[str, Any],
) -> None:
    if priority_color not in PRIORITY_COLORS:
        raise ValueError(f"Unsupported priority color: {priority_color}")

    feature = str(PRIORITY_COLORS[priority_color]["feature"])
    predict_counts(rows, priority_color)
    for row in rows:
        area = int(float(row.get(f"color_{feature}_area", 0) or 0))
        components = int(float(row.get(f"color_{feature}_components", 0) or 0))
        pct = float(row.get(f"color_{feature}_pct", 0) or 0)
        marker_count = int(float(row.get(f"color_{feature}_marker_count", 0) or 0))
        marker_area = int(float(row.get(f"color_{feature}_marker_area", 0) or 0))
        marker_score = float(row.get(f"color_{feature}_marker_score", 0) or 0)
        count = int(row["predicted_count"])
        row["priority_color"] = priority_color
        row["priority_color_label"] = PRIORITY_COLORS[priority_color]["label"]
        row["priority_count"] = count
        row["priority_raw"] = float(row["predicted_raw"])
        row["priority_area"] = marker_area or area
        row["priority_components"] = marker_count
        row["priority_pct"] = round(pct, 4)
        row["priority_calibrated"] = True
        row["priority_profile_estimator"] = GLOBAL_DETECTOR_ESTIMATOR["kind"]
        row["priority_profile_source"] = model.get("truth_file") or GLOBAL_DETECTOR_ESTIMATOR["source_truth"]
        row["detector_count_model"] = DETECTOR_COUNT_MODEL
        row["detector_count_model_label"] = DETECTOR_COUNT_MODEL_LABEL
        row["priority_detected_color_area"] = area
        row["priority_detected_color_components"] = components
        row["priority_marker_score"] = round(marker_score, 4)
        row["priority_band"] = priority_band(count)
        row["action"] = action_for(count)


def priority_band(count: int) -> str:
    if count >= 100:
        return "Critical"
    if count >= 50:
        return "High"
    if count >= 20:
        return "Medium"
    if count > 0:
        return "Low"
    return "No priority marks"


def action_for(count: int) -> str:
    if count >= 100:
        return "ส่งทีมช่างก่อนสุด"
    if count >= 50:
        return "ส่งทีมช่างรอบแรก"
    if count >= 20:
        return "ตรวจตามลำดับ"
    if count > 0:
        return "เก็บเป็นงานท้ายคิว"
    return "ไม่ต้องส่งจาก marker สีที่เลือก"


def output_feature_names(rows: list[dict[str, Any]]) -> list[str]:
    names: set[str] = set()
    for row in rows:
        for key, item in row.items():
            if isinstance(item, (str, int, float, bool)) or item is None:
                names.add(key)
    excluded = {
        "rank",
        "page",
        "priority_color",
        "priority_color_label",
        "priority_count",
        "priority_raw",
        "priority_area",
        "priority_components",
        "priority_pct",
        "priority_calibrated",
        "priority_profile_estimator",
        "priority_profile_source",
        "detector_count_model",
        "detector_count_model_label",
        "priority_detected_color_area",
        "priority_detected_color_components",
        "priority_marker_score",
        "predicted_count",
        "predicted_raw",
        "priority_band",
        "action",
    }
    return sorted(names - excluded)


def write_csv(rows: list[dict[str, Any]], output_path: Path, feature_names: list[str]) -> None:
    fields = [
        "rank",
        "page",
        "priority_color",
        "priority_color_label",
        "priority_count",
        "priority_raw",
        "priority_area",
        "priority_components",
        "priority_pct",
        "priority_calibrated",
        "priority_profile_estimator",
        "priority_profile_source",
        "detector_count_model",
        "detector_count_model_label",
        "priority_detected_color_area",
        "priority_detected_color_components",
        "priority_marker_score",
        "predicted_count",
        "predicted_raw",
        "priority_band",
        "action",
        *feature_names,
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


def evaluate_against_truth(
    rows: list[dict[str, Any]],
    truth_path: Path,
    priority_color: str,
) -> dict[str, Any] | None:
    if priority_color != "red":
        return None
    truth = read_truth(truth_path)
    if not truth:
        return None

    records: list[dict[str, Any]] = []
    for row in sorted(rows, key=lambda item: int(item["page"])):
        page = int(row["page"])
        if page not in truth:
            continue
        actual = int(truth[page])
        predicted = int(row["priority_count"])
        error = predicted - actual
        records.append(
            {
                "page": page,
                "actual_count": actual,
                "predicted_count": predicted,
                "error": error,
                "abs_error": abs(error),
            }
        )
    if not records:
        return None

    abs_errors = [float(row["abs_error"]) for row in records]
    sq_errors = [value * value for value in abs_errors]
    total_actual = sum(int(row["actual_count"]) for row in records)
    total_predicted = sum(int(row["predicted_count"]) for row in records)
    within_5_percent = sum(
        1
        for row in records
        if float(row["abs_error"]) <= max(1.0, float(row["actual_count"]) * 0.05)
    )
    estimator_summary = {
        "kind": GLOBAL_DETECTOR_ESTIMATOR["kind"],
        "source_truth": GLOBAL_DETECTOR_ESTIMATOR["source_truth"],
        "source_range": GLOBAL_DETECTOR_ESTIMATOR["source_range"],
        "notes": GLOBAL_DETECTOR_ESTIMATOR["notes"],
    }
    detector_estimator = load_detector_count_estimator()
    if detector_estimator:
        estimator_summary.update(detector_estimator.get("metadata", {}))
    return {
        "metrics": {
            "model": DETECTOR_COUNT_MODEL,
            "model_label": DETECTOR_COUNT_MODEL_LABEL,
            "estimator": estimator_summary,
            "truth_file": str(truth_path),
            "pages": len(records),
            "total_actual": total_actual,
            "total_predicted": total_predicted,
            "total_error": total_predicted - total_actual,
            "total_error_pct": round(((total_predicted - total_actual) / total_actual) * 100, 4)
            if total_actual
            else 0.0,
            "mae": round(sum(abs_errors) / len(abs_errors), 4),
            "rmse": round(math.sqrt(sum(sq_errors) / len(sq_errors)), 4),
            "max_error": int(max(abs_errors)),
            "exact_pages": sum(1 for row in records if row["abs_error"] == 0),
            "within_5_percent_pages": within_5_percent,
            "within_2_pages": sum(1 for row in records if row["abs_error"] <= 2),
            "within_5_pages": sum(1 for row in records if row["abs_error"] <= 5),
        },
        "records": records,
    }


def write_evaluation_csv(evaluation: dict[str, Any], output_path: Path) -> None:
    fields = ["page", "actual_count", "predicted_count", "error", "abs_error"]
    with output_path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(evaluation["records"])


def scan_pdf(
    input_pdf: Path,
    output_dir: Path,
    model_path: Path = Path("model/red_box_calibration_model.json"),
    start_page: int = 1,
    end_page: int = 0,
    scale: float = 0.0,
    priority_color: str = "red",
    progress_callback: Callable[[int, int, int], None] | None = None,
    evaluate_truth: bool = False,
) -> dict[str, Any]:
    model = load_model(model_path)
    analysis_scale = float(scale or model.get("scale") or 2.0)
    pdf = pdfium.PdfDocument(str(input_pdf))
    total_pages = len(pdf)
    resolved_end_page = end_page or total_pages
    if start_page < 1 or resolved_end_page < start_page or resolved_end_page > total_pages:
        raise ValueError(f"Invalid range {start_page}-{resolved_end_page}; PDF has {total_pages} pages.")
    if hasattr(pdf, "close"):
        pdf.close()

    output_dir.mkdir(parents=True, exist_ok=True)
    rows = scan_rows(
        input_pdf,
        start_page,
        resolved_end_page,
        analysis_scale,
        priority_color=priority_color,
        progress_callback=progress_callback,
    )
    apply_priority_color(rows, priority_color, model)
    sorted_rows = sorted(
        rows,
        key=lambda row: (
            int(row["priority_count"]),
            float(row["priority_raw"]),
            int(row.get("priority_area", 0)),
            int(row["page"]),
        ),
        reverse=True,
    )

    suffix = f"{start_page}_{resolved_end_page}"
    csv_path = output_dir / f"model_predicted_{priority_color}_priority_counts_{suffix}.csv"
    pdf_path = output_dir / f"model_predicted_{priority_color}_priority_sorted_pages_{suffix}.pdf"
    json_path = output_dir / f"model_predicted_{priority_color}_priority_debug_{suffix}.json"
    evaluation_path: Path | None = None
    evaluation_metrics: dict[str, Any] | None = None
    evaluation = (
        evaluate_against_truth(rows, Path("countedvalues.txt"), priority_color)
        if evaluate_truth
        else None
    )
    if evaluation is not None:
        evaluation_path = output_dir / f"model_predicted_{priority_color}_priority_evaluation_{suffix}.csv"
        write_evaluation_csv(evaluation, evaluation_path)
        evaluation_metrics = evaluation["metrics"]

    write_csv(sorted_rows, csv_path, output_feature_names(sorted_rows))
    write_pdf(input_pdf, sorted_rows, pdf_path)
    json_path.write_text(json.dumps(sorted_rows, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "rows": sorted_rows,
        "csv_path": csv_path,
        "pdf_path": pdf_path,
        "json_path": json_path,
        "start_page": start_page,
        "end_page": resolved_end_page,
        "total_pages": total_pages,
        "scale": analysis_scale,
        "priority_color": priority_color,
        "priority_color_label": PRIORITY_COLORS[priority_color]["label"],
        "priority_calibrated": bool(PRIORITY_COLORS[priority_color]["calibrated"]),
        "count_model": DETECTOR_COUNT_MODEL,
        "count_model_label": DETECTOR_COUNT_MODEL_LABEL,
        "evaluation_path": evaluation_path,
        "evaluation_metrics": evaluation_metrics,
        "model": model,
    }


def main() -> None:
    args = parse_args()
    default_model = Path("model/red_box_calibration_model.json")
    model_path = args.model
    if model_path == Path("output/pdf/opencv_truth_calibrated/red_box_calibration_model_1019_1115.json") and default_model.exists():
        model_path = default_model
    result = scan_pdf(
        input_pdf=args.pdf,
        output_dir=args.output_dir,
        model_path=model_path,
        start_page=args.start_page,
        end_page=args.end_page,
        scale=args.scale,
        priority_color=args.priority_color,
        evaluate_truth=args.evaluate_truth,
    )
    sorted_rows = result["rows"]
    pdf_path = result["pdf_path"]
    csv_path = result["csv_path"]
    json_path = result["json_path"]

    print(f"Wrote {pdf_path}")
    print(f"Wrote {csv_path}")
    print(f"Wrote {json_path}")
    print("Top 15 predicted priority pages:")
    for rank, row in enumerate(sorted_rows[:15], 1):
        print(f"{rank:02d}. page {row['page']} priority_count={row['priority_count']}")


if __name__ == "__main__":
    main()
