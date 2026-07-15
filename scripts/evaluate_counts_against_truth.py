from __future__ import annotations

import argparse
import csv
import json
import math
import re
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare detected red-box counts against countedvalues.txt.")
    parser.add_argument("--truth", type=Path, default=Path("countedvalues.txt"))
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--count-field", default="")
    parser.add_argument("--output-dir", type=Path, default=Path("output/pdf/count_evaluation"))
    parser.add_argument("--label", default="")
    return parser.parse_args()


def read_truth(path: Path) -> dict[int, int]:
    truth: dict[int, int] = {}
    pattern = re.compile(r"^\s*(\d+)\s*=\s*(\d+)\s*$")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            truth[int(match.group(1))] = int(match.group(2))
    return truth


def numeric(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def read_candidate(path: Path, count_field: str) -> dict[int, dict[str, Any]]:
    if path.suffix.lower() == ".json":
        rows = json.loads(path.read_text(encoding="utf-8"))
    else:
        with path.open("r", encoding="utf-8-sig", newline="") as fh:
            rows = list(csv.DictReader(fh))

    by_page: dict[int, dict[str, Any]] = {}
    for row in rows:
        page = int(numeric(row.get("page")))
        if not page:
            continue
        if not count_field:
            for field in (
                "predicted_count",
                "red_box_count",
                "red_marker_count",
                "red_marker_estimate",
                "red_text_box_count",
            ):
                if field in row:
                    count_field = field
                    break
        predicted = numeric(row.get(count_field))
        by_page[page] = {**row, "predicted_count": predicted}
    return by_page


def ranks(values: dict[int, float]) -> dict[int, int]:
    return {
        page: rank
        for rank, (page, _count) in enumerate(
            sorted(values.items(), key=lambda item: (item[1], item[0]), reverse=True),
            1,
        )
    }


def spearman(truth: dict[int, int], pred: dict[int, float]) -> float:
    pages = sorted(truth)
    truth_ranks = ranks({page: float(truth[page]) for page in pages})
    pred_ranks = ranks({page: float(pred.get(page, 0.0)) for page in pages})
    n = len(pages)
    if n < 2:
        return 0.0
    d2 = sum((truth_ranks[page] - pred_ranks[page]) ** 2 for page in pages)
    return 1.0 - (6.0 * d2) / (n * (n * n - 1))


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    truth = read_truth(args.truth)
    candidate = read_candidate(args.candidate, args.count_field)

    records: list[dict[str, Any]] = []
    abs_errors: list[float] = []
    sq_errors: list[float] = []
    for page in sorted(truth):
        actual = truth[page]
        predicted = float(candidate.get(page, {}).get("predicted_count", 0.0))
        error = predicted - actual
        abs_errors.append(abs(error))
        sq_errors.append(error * error)
        records.append(
            {
                "page": page,
                "actual_count": actual,
                "predicted_count": round(predicted, 4),
                "error": round(error, 4),
                "abs_error": round(abs(error), 4),
            }
        )

    total_actual = sum(truth.values())
    total_pred = sum(float(candidate.get(page, {}).get("predicted_count", 0.0)) for page in truth)
    mae = sum(abs_errors) / len(abs_errors)
    rmse = math.sqrt(sum(sq_errors) / len(sq_errors))
    exact = sum(1 for record in records if record["abs_error"] == 0)
    within_2 = sum(1 for record in records if record["abs_error"] <= 2)
    within_5 = sum(1 for record in records if record["abs_error"] <= 5)
    pred_values = {page: float(candidate.get(page, {}).get("predicted_count", 0.0)) for page in truth}
    metrics = {
        "label": args.label or args.candidate.stem,
        "pages": len(truth),
        "total_actual": total_actual,
        "total_predicted": round(total_pred, 4),
        "total_error": round(total_pred - total_actual, 4),
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "exact_pages": exact,
        "within_2_pages": within_2,
        "within_5_pages": within_5,
        "spearman_rank": round(spearman(truth, pred_values), 4),
    }

    worst = sorted(records, key=lambda row: row["abs_error"], reverse=True)
    suffix = args.label or args.candidate.stem
    (args.output_dir / f"{suffix}_metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    with (args.output_dir / f"{suffix}_page_errors.csv").open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=["page", "actual_count", "predicted_count", "error", "abs_error"])
        writer.writeheader()
        writer.writerows(records)

    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    print("Worst 12 pages:")
    for row in worst[:12]:
        print(
            f"page {row['page']}: actual={row['actual_count']} "
            f"pred={row['predicted_count']} error={row['error']}"
        )


if __name__ == "__main__":
    main()
