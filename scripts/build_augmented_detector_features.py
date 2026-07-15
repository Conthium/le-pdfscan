from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
import pypdfium2 as pdfium

from detector_features import page_features_from_rgb


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build detector features from rendered pages plus scan-like augmentations."
    )
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--start-page", type=int, default=1019)
    parser.add_argument("--end-page", type=int, default=1115)
    parser.add_argument("--scale", type=float, default=2.0)
    parser.add_argument("--priority-color", default="red")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("output/pdf/detector_features_augmented/truth_calibrated_red_box_debug_1019_1115.json"),
    )
    parser.add_argument(
        "--flush-pages",
        type=int,
        default=1,
        help="Write a resumable partial JSON after this many pages.",
    )
    parser.add_argument(
        "--restart",
        action="store_true",
        help="Ignore an existing output or partial file and rebuild from the first page.",
    )
    return parser.parse_args()


def clip_rgb(image: np.ndarray) -> np.ndarray:
    return np.clip(image, 0, 255).astype("uint8")


def identity(image: np.ndarray) -> np.ndarray:
    return image


def brightness(alpha: float, beta: float) -> Callable[[np.ndarray], np.ndarray]:
    def transform(image: np.ndarray) -> np.ndarray:
        return clip_rgb(image.astype("float32") * alpha + beta)

    return transform


def blur(image: np.ndarray) -> np.ndarray:
    return cv2.GaussianBlur(image, (3, 3), 0)


def soft_jpeg(image: np.ndarray) -> np.ndarray:
    ok, encoded = cv2.imencode(".jpg", cv2.cvtColor(image, cv2.COLOR_RGB2BGR), [int(cv2.IMWRITE_JPEG_QUALITY), 82])
    if not ok:
        return image
    decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    return cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB)


def resample_soft(image: np.ndarray) -> np.ndarray:
    height, width = image.shape[:2]
    small = cv2.resize(image, (max(1, int(width * 0.86)), max(1, int(height * 0.86))), interpolation=cv2.INTER_AREA)
    return cv2.resize(small, (width, height), interpolation=cv2.INTER_CUBIC)


def gamma_transform(gamma: float) -> Callable[[np.ndarray], np.ndarray]:
    table = np.array([((value / 255.0) ** gamma) * 255 for value in range(256)]).astype("uint8")

    def transform(image: np.ndarray) -> np.ndarray:
        return cv2.LUT(image, table)

    return transform


def sharpen(image: np.ndarray) -> np.ndarray:
    blurred = cv2.GaussianBlur(image, (0, 0), 1.0)
    return clip_rgb(image.astype("float32") * 1.55 - blurred.astype("float32") * 0.55)


def mild_noise(image: np.ndarray) -> np.ndarray:
    rng = np.random.default_rng(12345)
    noise = rng.normal(0, 4.5, image.shape).astype("float32")
    return clip_rgb(image.astype("float32") + noise)


def color_bleed(image: np.ndarray) -> np.ndarray:
    blurred = cv2.GaussianBlur(image, (3, 3), 0)
    return cv2.addWeighted(image, 0.72, blurred, 0.28, 0)


AUGMENTATIONS: list[tuple[str, Callable[[np.ndarray], np.ndarray]]] = [
    ("original", identity),
    ("bright_low", brightness(0.9, -6.0)),
    ("bright_high", brightness(1.08, 8.0)),
    ("soft_blur", blur),
    ("jpeg_82", soft_jpeg),
    ("resample_soft", resample_soft),
    ("gamma_dark", gamma_transform(1.18)),
    ("gamma_light", gamma_transform(0.86)),
    ("contrast_low", brightness(0.86, 12.0)),
    ("contrast_high", brightness(1.16, -10.0)),
    ("mild_noise", mild_noise),
    ("sharpen", sharpen),
    ("color_bleed", color_bleed),
]


def partial_path(output: Path) -> Path:
    return output.with_name(f"{output.name}.partial")


def load_rows(path: Path) -> list[dict[str, object]]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(loaded, list):
        return []
    return [row for row in loaded if isinstance(row, dict)]


def write_rows(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.tmp")
    temp_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def main() -> None:
    args = parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    resume_path = partial_path(args.output)
    rows: list[dict[str, object]] = []
    if not args.restart:
        if resume_path.exists():
            rows = load_rows(resume_path)
        elif args.output.exists():
            rows = load_rows(args.output)
    completed_pages = {
        int(row.get("source_page", row.get("page", 0)))
        for row in rows
        if str(row.get("augmentation", "")) in {name for name, _transform in AUGMENTATIONS}
    }
    completed_pages = {
        page
        for page in completed_pages
        if page and sum(1 for row in rows if int(row.get("source_page", row.get("page", 0))) == page)
        >= len(AUGMENTATIONS)
    }
    pdf = pdfium.PdfDocument(str(args.pdf))
    pages_since_flush = 0
    try:
        for page_number in range(args.start_page, args.end_page + 1):
            if page_number in completed_pages:
                print(f"page {page_number}: already complete", flush=True)
                continue
            rgb = np.array(pdf[page_number - 1].render(scale=args.scale).to_pil().convert("RGB"))
            for name, transform in AUGMENTATIONS:
                augmented = transform(rgb)
                row = page_features_from_rgb(augmented, page_number, args.priority_color)
                row["source_page"] = page_number
                row["augmentation"] = name
                rows.append(row)
            print(f"page {page_number}: {len(AUGMENTATIONS)} variants", flush=True)
            pages_since_flush += 1
            if pages_since_flush >= max(1, args.flush_pages):
                write_rows(resume_path, rows)
                print(f"partial {resume_path}: {len(rows)} rows", flush=True)
                pages_since_flush = 0
    finally:
        if hasattr(pdf, "close"):
            pdf.close()

    write_rows(args.output, rows)
    if resume_path.exists():
        resume_path.unlink()
    print(f"Wrote {args.output} ({len(rows)} rows)")


if __name__ == "__main__":
    main()
