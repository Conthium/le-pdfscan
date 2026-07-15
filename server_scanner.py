from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import shutil
import sys
import tempfile
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
import pypdfium2 as pdfium

ROOT = Path(__file__).resolve().parent
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from apply_red_box_calibration import DETECTOR_COUNT_MODEL, DETECTOR_COUNT_MODEL_LABEL, PRIORITY_COLORS, scan_pdf

APP_NAME = "LE PDF Priority Scanner API"
MODEL_PATH = ROOT / "model" / "red_box_calibration_model.json"
JOBS_DIR = Path(tempfile.gettempdir()) / "le-pdf-priority-scanner" / "jobs"
SCAN_EXECUTOR = ThreadPoolExecutor(max_workers=2)
SCAN_JOBS: dict[str, dict[str, Any]] = {}
SCAN_JOBS_LOCK = Lock()

app = FastAPI(title=APP_NAME, version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": MODEL_PATH.exists(),
        "service": APP_NAME,
        "model": MODEL_PATH.name,
        "priority_colors": list(PRIORITY_COLORS),
        "count_model": DETECTOR_COUNT_MODEL,
        "count_model_label": DETECTOR_COUNT_MODEL_LABEL,
    }


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def update_scan_job(job_id: str, **fields: Any) -> None:
    with SCAN_JOBS_LOCK:
        current = SCAN_JOBS.setdefault(job_id, {})
        current.update(fields)
        current["updated_at"] = now_iso()


def get_scan_job(job_id: str) -> dict[str, Any]:
    with SCAN_JOBS_LOCK:
        job = SCAN_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found.")
        return dict(job)


def validate_scan_request(
    file_name: str | None,
    start_page: int,
    end_page: int,
    priority_color: str,
) -> None:
    if not MODEL_PATH.exists():
        raise HTTPException(status_code=500, detail="Calibration model is missing on the server.")
    if not file_name or not file_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a PDF file.")
    if start_page < 1 or end_page < 0 or (end_page and end_page < start_page):
        raise HTTPException(status_code=400, detail="Invalid page range.")
    if priority_color not in PRIORITY_COLORS:
        raise HTTPException(status_code=400, detail="Invalid priority color.")


def scan_result_payload(
    job_id: str,
    file_name: str,
    result: dict[str, Any],
    priority_color: str,
) -> dict[str, Any]:
    rows = [
        {
            "rank": rank,
            "page": int(row["page"]),
            "priority_color": row["priority_color"],
            "priority_color_label": row["priority_color_label"],
            "priority_count": int(row["priority_count"]),
            "priority_raw": float(row["priority_raw"]),
            "priority_area": int(row["priority_area"]),
            "priority_components": int(row["priority_components"]),
            "priority_pct": float(row["priority_pct"]),
            "priority_calibrated": bool(row["priority_calibrated"]),
            "priority_profile_estimator": row.get("priority_profile_estimator", ""),
            "priority_profile_source": row.get("priority_profile_source", ""),
            "priority_detected_color_area": int(row.get("priority_detected_color_area", 0) or 0),
            "priority_detected_color_components": int(row.get("priority_detected_color_components", 0) or 0),
            "priority_marker_score": float(row.get("priority_marker_score", 0) or 0),
            "predicted_count": int(row["predicted_count"]),
            "predicted_raw": float(row["predicted_raw"]),
            "prediction_std": float(row.get("prediction_std", 0) or 0),
            "prediction_tree_min": float(row.get("prediction_tree_min", 0) or 0),
            "prediction_tree_max": float(row.get("prediction_tree_max", 0) or 0),
            "prediction_confidence": row.get("prediction_confidence", ""),
            "priority_band": row["priority_band"],
            "action": row["action"],
            "count_model": row.get("detector_count_model", DETECTOR_COUNT_MODEL),
            "count_model_label": row.get("detector_count_model_label", DETECTOR_COUNT_MODEL_LABEL),
        }
        for rank, row in enumerate(result["rows"], 1)
    ]
    total_priority = sum(row["priority_count"] for row in rows)
    return {
        "job_id": job_id,
        "file_name": file_name,
        "start_page": result["start_page"],
        "end_page": result["end_page"],
        "total_pages": result["total_pages"],
        "scale": result["scale"],
        "priority_color": result["priority_color"],
        "priority_color_label": result["priority_color_label"],
        "priority_calibrated": result["priority_calibrated"],
        "count_model": result["count_model"],
        "count_model_label": result["count_model_label"],
        "row_count": len(rows),
        "total_priority_count": total_priority,
        "top_priority_count": rows[0]["priority_count"] if rows else 0,
        "rows": rows,
        "downloads": {
            "pdf": f"/api/download/{job_id}/{Path(result['pdf_path']).name}",
            "csv": f"/api/download/{job_id}/{Path(result['csv_path']).name}",
        },
    }


def run_scan_job(
    job_id: str,
    input_pdf: Path,
    job_dir: Path,
    file_name: str,
    start_page: int,
    end_page: int,
    scale: float,
    priority_color: str,
) -> None:
    def update_progress(page_number: int, completed: int, total: int) -> None:
        update_scan_job(
            job_id,
            status="scanning",
            current_page=page_number,
            completed_pages=completed,
            total_scan_pages=total,
            percent=round((completed / total) * 100, 1) if total else 0,
        )

    try:
        update_scan_job(
            job_id,
            status="scanning",
            current_page=None,
            completed_pages=0,
            total_scan_pages=max(0, end_page - start_page + 1) if end_page else None,
            percent=0,
        )
        result = scan_pdf(
            input_pdf=input_pdf,
            output_dir=job_dir,
            model_path=MODEL_PATH,
            start_page=start_page,
            end_page=end_page,
            scale=scale,
            priority_color=priority_color,
            progress_callback=update_progress,
        )
        payload = scan_result_payload(job_id, file_name, result, priority_color)
        update_scan_job(
            job_id,
            status="complete",
            completed_pages=payload["row_count"],
            total_scan_pages=payload["row_count"],
            percent=100,
            result=payload,
        )
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        update_scan_job(
            job_id,
            status="failed",
            error=str(exc),
            percent=0,
        )


@app.post("/api/pdf-info")
async def pdf_info(file: UploadFile = File(...)) -> dict[str, Any]:
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a PDF file.")

    job_id = uuid4().hex
    job_dir = JOBS_DIR / f"info-{job_id}"
    job_dir.mkdir(parents=True, exist_ok=True)
    input_pdf = job_dir / "input.pdf"
    try:
        with input_pdf.open("wb") as fh:
            shutil.copyfileobj(file.file, fh)
        pdf = pdfium.PdfDocument(str(input_pdf))
        total_pages = len(pdf)
        if hasattr(pdf, "close"):
            pdf.close()
        return {
            "file_name": file.filename,
            "total_pages": total_pages,
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot read PDF page count: {exc}") from exc
    finally:
        await file.close()
        shutil.rmtree(job_dir, ignore_errors=True)


@app.post("/api/scan")
async def scan(
    file: UploadFile = File(...),
    start_page: int = Form(1),
    end_page: int = Form(0),
    scale: float = Form(0.0),
    priority_color: str = Form("red"),
) -> dict[str, Any]:
    validate_scan_request(file.filename, start_page, end_page, priority_color)

    job_id = uuid4().hex
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    input_pdf = job_dir / "input.pdf"
    try:
        with input_pdf.open("wb") as fh:
            shutil.copyfileobj(file.file, fh)

        result = await run_in_threadpool(
            scan_pdf,
            input_pdf=input_pdf,
            output_dir=job_dir,
            model_path=MODEL_PATH,
            start_page=start_page,
            end_page=end_page,
            scale=scale,
            priority_color=priority_color,
        )
    except ValueError as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Scan failed: {exc}") from exc
    finally:
        await file.close()

    return scan_result_payload(job_id, file.filename, result, priority_color)


@app.post("/api/scan-job")
async def scan_job(
    file: UploadFile = File(...),
    start_page: int = Form(1),
    end_page: int = Form(0),
    scale: float = Form(0.0),
    priority_color: str = Form("red"),
) -> dict[str, Any]:
    validate_scan_request(file.filename, start_page, end_page, priority_color)

    job_id = uuid4().hex
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    input_pdf = job_dir / "input.pdf"
    try:
        with input_pdf.open("wb") as fh:
            shutil.copyfileobj(file.file, fh)
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Upload failed: {exc}") from exc
    finally:
        await file.close()

    SCAN_JOBS[job_id] = {
        "job_id": job_id,
        "status": "queued",
        "file_name": file.filename,
        "start_page": start_page,
        "end_page": end_page,
        "priority_color": priority_color,
        "current_page": None,
        "completed_pages": 0,
        "total_scan_pages": max(0, end_page - start_page + 1) if end_page else None,
        "percent": 0,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    SCAN_EXECUTOR.submit(
        run_scan_job,
        job_id,
        input_pdf,
        job_dir,
        file.filename,
        start_page,
        end_page,
        scale,
        priority_color,
    )
    return {
        "job_id": job_id,
        "status": "queued",
    }


@app.get("/api/jobs/{job_id}")
def scan_job_status(job_id: str) -> dict[str, Any]:
    if not job_id.isalnum():
        raise HTTPException(status_code=400, detail="Invalid job id.")
    return get_scan_job(job_id)


@app.get("/api/download/{job_id}/{file_name}")
def download(job_id: str, file_name: str) -> FileResponse:
    if not job_id.isalnum() or any(part in file_name for part in ("..", "/", "\\")):
        raise HTTPException(status_code=400, detail="Invalid download path.")
    path = JOBS_DIR / job_id / file_name
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found.")
    return FileResponse(path, filename=file_name)
