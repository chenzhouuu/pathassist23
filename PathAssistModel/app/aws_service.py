from __future__ import annotations

import base64
from pathlib import Path
from typing import Dict, Optional

import boto3

from .config import Settings


class AwsService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.ec2 = boto3.client("ec2", region_name=settings.aws_region)
        self.s3 = boto3.client("s3", region_name=settings.aws_region)

    def upload_result_artifact(self, key: str, local_path: Path, content_type: str = "application/json") -> str:
        if not self.settings.s3_bucket:
            raise RuntimeError("PATHASSIST_S3_BUCKET is required for artifact uploads.")
        self.s3.upload_file(
            str(local_path),
            self.settings.s3_bucket,
            key,
            ExtraArgs={"ContentType": content_type},
        )
        return f"s3://{self.settings.s3_bucket}/{key}"

    def request_spot_instance(self, user_data: str = "", tags: Optional[Dict[str, str]] = None) -> Dict:
        if not all(
            [
                self.settings.spot_ami_id,
                self.settings.spot_subnet_id,
                self.settings.spot_security_group_id,
            ]
        ):
            raise RuntimeError("Spot instance settings are incomplete.")

        tag_specifications = []
        if tags:
            tag_specifications.append(
                {
                    "ResourceType": "instance",
                    "Tags": [{"Key": key, "Value": value} for key, value in tags.items()],
                }
            )

        launch_spec = {
            "ImageId": self.settings.spot_ami_id,
            "InstanceType": self.settings.spot_instance_type,
            "SubnetId": self.settings.spot_subnet_id,
            "SecurityGroupIds": [self.settings.spot_security_group_id],
        }
        if self.settings.spot_key_name:
            launch_spec["KeyName"] = self.settings.spot_key_name
        if self.settings.spot_iam_instance_profile:
            launch_spec["IamInstanceProfile"] = {"Name": self.settings.spot_iam_instance_profile}
        if user_data:
            launch_spec["UserData"] = base64.b64encode(user_data.encode("utf-8")).decode("utf-8")

        response = self.ec2.request_spot_instances(
            InstanceCount=1,
            Type="one-time",
            LaunchSpecification=launch_spec,
            TagSpecifications=tag_specifications or None,
        )
        return response
