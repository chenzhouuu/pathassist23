from __future__ import annotations

from pathlib import Path
from typing import Dict

from worker.celery_worker import celery_app
from app.annotation_service import elements_to_annotation_docs, hovernet_to_elements, load_hovernet_output
from app.aws_service import AwsService
from app.config import get_settings
from app.girder_service import GirderService
from app.inference_service import InferenceService
from app.utils import job_dir, json_dump, managed_workdir, setup_logging


settings = get_settings()
setup_logging(settings.log_level)


@celery_app.task(bind=True, name="worker.tasks.process_wsi_item")
def process_wsi_item(self, item_id: str) -> Dict:
    girder = GirderService(settings)
    inference = InferenceService(settings)
    aws = AwsService(settings)
    item = girder.get_item(item_id)

    with managed_workdir(job_dir(settings.output_root), keep=settings.keep_workdir) as workdir:
        self.update_state(state="STARTED", meta={"step": "download", "item_id": item_id})
        slide_path = girder.download_item_file(item_id, workdir / "input")

        self.update_state(state="PROGRESS", meta={"step": "infer", "item_id": item_id})
        infer_result = inference.run_hovernet(slide_path, workdir / "output")

        self.update_state(state="PROGRESS", meta={"step": "convert", "item_id": item_id})
        instances = load_hovernet_output(Path(infer_result["output_path"]))
        elements = hovernet_to_elements(instances, settings)
        annotation_docs = elements_to_annotation_docs(item["name"], elements, settings)

        annotation_ids = []
        for doc in annotation_docs:
            created = girder.create_annotation(item_id, {"annotation": doc})
            annotation_ids.append(created["_id"])

        result_json = {
            "item_id": item_id,
            "item_name": item["name"],
            "slide_path": str(slide_path),
            "nuclei_count": len(elements),
            "annotation_ids": annotation_ids,
            "model_name": settings.model_name,
        }
        result_path = workdir / "result" / "summary.json"
        json_dump(result_path, result_json)

        s3_uri = None
        if settings.s3_bucket:
            key = f"{settings.s3_prefix}/{item_id}/summary.json"
            s3_uri = aws.upload_result_artifact(key, result_path)
            result_json["artifact_s3_uri"] = s3_uri

        return result_json
