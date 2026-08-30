from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.developer_runtime_status_source_fastify_rollback_baseline import (
    DeveloperRuntimeStatusSourceFastifyRollbackBaseline,
)

T = TypeVar("T", bound="DeveloperRuntimeStatusSource")


@_attrs_define
class DeveloperRuntimeStatusSource:
    """
    Attributes:
        api_version (str):
        expected_migration (str): 원격 적용 시각과 무관한 Git migration의 안정적인 name
        fastify_rollback_baseline (DeveloperRuntimeStatusSourceFastifyRollbackBaseline):
    """

    api_version: str
    expected_migration: str
    fastify_rollback_baseline: DeveloperRuntimeStatusSourceFastifyRollbackBaseline

    def to_dict(self) -> dict[str, Any]:
        api_version = self.api_version

        expected_migration = self.expected_migration

        fastify_rollback_baseline = self.fastify_rollback_baseline.value

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "apiVersion": api_version,
                "expectedMigration": expected_migration,
                "fastifyRollbackBaseline": fastify_rollback_baseline,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        api_version = d.pop("apiVersion")

        expected_migration = d.pop("expectedMigration")

        fastify_rollback_baseline = DeveloperRuntimeStatusSourceFastifyRollbackBaseline(
            d.pop("fastifyRollbackBaseline")
        )

        developer_runtime_status_source = cls(
            api_version=api_version,
            expected_migration=expected_migration,
            fastify_rollback_baseline=fastify_rollback_baseline,
        )

        return developer_runtime_status_source
