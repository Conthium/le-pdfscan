from __future__ import annotations

import math
from typing import Any


BASE_FEATURE_KEYS = [
    "color_{feature}_marker_area",
    "color_{feature}_marker_count",
    "color_{feature}_marker_score",
    "color_{feature}_area",
    "color_{feature}_components",
    "color_{feature}_pct",
    "color_marker_total_area",
    "cal_red_marker_count",
    "cal_red_marker_score",
    "cal_weighted_red_area",
    "cal_priority_score",
    "cal_large_false_red_count",
    "cal_hatch_like_count",
    "cal_marker_area_total",
    "cal_red_marker_pct",
    "text_red_text_box_count",
    "text_accepted_red_regions",
    "text_accepted_red_area",
    "text_large_rejected_regions",
    "text_anchor_score_sum",
    "text_anchor_score_mean",
    "text_strong_anchor_count",
    "text_weak_anchor_count",
    "text_anchor_dark_area_sum",
    "text_anchor_dark_area_mean",
    "text_anchor_dark_area_median",
    "text_anchor_nearby_area_sum",
    "text_anchor_nearby_area_mean",
    "text_anchor_nearby_area_median",
    "text_accepted_region_area_mean",
    "text_accepted_region_density_mean",
    "text_accepted_color_gr_mean",
    "text_accepted_color_br_mean",
    "text_accepted_color_saturation_mean",
    "text_accepted_color_value_mean",
    "text_confidence",
]

DERIVED_FEATURE_KEYS = [
    "text_avg_area",
    "text_per_region",
    "cal_area_per_marker",
    "color_area_per_marker",
    "cal_to_text",
    "color_to_text",
    "false_ratio",
    "strong_anchor_ratio",
    "weak_anchor_ratio",
    "anchor_dark_to_nearby",
    "red_purity",
]

TRANSFORMS = ("raw", "sqrt", "log")


def numeric_value(row: dict[str, Any], key: str) -> float:
    try:
        return float(row.get(key, 0) or 0)
    except (TypeError, ValueError):
        return 0.0


def resolved_key(key: str, feature: str) -> str:
    return key.format(feature=feature)


def target_color_purity(feature: str, saturation: float, green_over_red: float, blue_over_red: float) -> float:
    """Map selected-color purity onto the red-trained feature scale."""
    normalized_saturation = saturation / 255.0
    gr = max(0.0, green_over_red)
    br = max(0.0, blue_over_red)

    if feature == "red":
        non_target_ratio = gr + br
    elif feature == "green":
        if gr <= 0:
            return 0.0
        non_target_ratio = (1.0 / gr) + (br / gr)
    elif feature == "blue":
        if br <= 0:
            return 0.0
        non_target_ratio = (1.0 / br) + (gr / br)
    elif feature == "pink":
        # Pink/magenta markers are carried by red+blue, with green as the
        # main contaminating channel. Penalize severe red/blue imbalance.
        target_total = 1.0 + br
        non_target_ratio = (gr / max(0.001, target_total)) + abs(br - 1.0) * 0.25
    elif feature == "orange_marker":
        # Orange markers are carried by red+green; blue is the main unwanted
        # channel, with a small penalty when green leaves the expected band.
        target_total = 1.0 + gr
        green_balance_penalty = max(0.0, 0.32 - gr) + max(0.0, gr - 1.05)
        non_target_ratio = (br / max(0.001, target_total)) + green_balance_penalty
    else:
        non_target_ratio = gr + br

    return normalized_saturation / max(0.001, non_target_ratio)


def detector_count_feature_names(feature: str = "red") -> list[str]:
    raw_names = [resolved_key(key, feature) for key in BASE_FEATURE_KEYS] + DERIVED_FEATURE_KEYS
    return [f"{name}:{transform}" for name in raw_names for transform in TRANSFORMS]


def detector_count_feature_vector(row: dict[str, Any], feature: str = "red") -> list[float]:
    raw: dict[str, float] = {
        resolved_key(key, feature): numeric_value(row, resolved_key(key, feature))
        for key in BASE_FEATURE_KEYS
    }
    color_marker_area = raw.get(f"color_{feature}_marker_area", 0.0)
    color_marker_count = raw.get(f"color_{feature}_marker_count", 0.0)
    text_count = raw.get("text_red_text_box_count", 0.0)
    text_regions = raw.get("text_accepted_red_regions", 0.0)
    cal_marker_count = raw.get("cal_red_marker_count", 0.0)
    strong_anchor_count = raw.get("text_strong_anchor_count", 0.0)
    weak_anchor_count = raw.get("text_weak_anchor_count", 0.0)

    raw.update(
        {
            "text_avg_area": raw.get("text_accepted_red_area", 0.0) / max(1.0, text_count),
            "text_per_region": text_count / max(1.0, text_regions),
            "cal_area_per_marker": raw.get("cal_weighted_red_area", 0.0)
            / max(1.0, cal_marker_count),
            "color_area_per_marker": color_marker_area / max(1.0, color_marker_count),
            "cal_to_text": cal_marker_count / max(1.0, text_count),
            "color_to_text": color_marker_count / max(1.0, text_count),
            "false_ratio": raw.get("cal_large_false_red_count", 0.0) / max(1.0, cal_marker_count),
            "strong_anchor_ratio": strong_anchor_count / max(1.0, text_count),
            "weak_anchor_ratio": weak_anchor_count / max(1.0, text_count),
            "anchor_dark_to_nearby": raw.get("text_anchor_dark_area_sum", 0.0)
            / max(1.0, raw.get("text_anchor_nearby_area_sum", 0.0)),
            "red_purity": target_color_purity(
                feature,
                raw.get("text_accepted_color_saturation_mean", 0.0),
                raw.get("text_accepted_color_gr_mean", 0.0),
                raw.get("text_accepted_color_br_mean", 0.0),
            ),
        }
    )

    vector: list[float] = []
    for value in raw.values():
        vector.append(value)
        nonnegative = max(0.0, value)
        vector.append(math.sqrt(nonnegative))
        vector.append(math.log1p(nonnegative))
    return vector
