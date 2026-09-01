from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.developer_database_status_environment import DeveloperDatabaseStatusEnvironment
from ..models.developer_database_status_migration_drift import DeveloperDatabaseStatusMigrationDrift

if TYPE_CHECKING:
    from ..models.developer_database_status_critical_rpcs import DeveloperDatabaseStatusCriticalRpcs
    from ..models.developer_database_status_row_counts import DeveloperDatabaseStatusRowCounts


T = TypeVar("T", bound="DeveloperDatabaseStatus")


@_attrs_define
class DeveloperDatabaseStatus:
    """
    Attributes:
        database_reachable (bool):
        current_migration (None | str):
        current_migration_version (None | str): 현재 환경이 부여한 원격 migration version. source identity로 사용하지 않습니다.
        expected_migration (str):
        migration_drift (DeveloperDatabaseStatusMigrationDrift):
        rls_missing_count (int):
        rls_valid (bool):
        critical_rpcs (DeveloperDatabaseStatusCriticalRpcs):
        row_counts (DeveloperDatabaseStatusRowCounts):
        environment (DeveloperDatabaseStatusEnvironment):
        project_ref (str):
        checked_at (datetime.datetime):
    """

    database_reachable: bool
    current_migration: None | str
    current_migration_version: None | str
    expected_migration: str
    migration_drift: DeveloperDatabaseStatusMigrationDrift
    rls_missing_count: int
    rls_valid: bool
    critical_rpcs: DeveloperDatabaseStatusCriticalRpcs
    row_counts: DeveloperDatabaseStatusRowCounts
    environment: DeveloperDatabaseStatusEnvironment
    project_ref: str
    checked_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        database_reachable = self.database_reachable

        current_migration: None | str
        current_migration = self.current_migration

        current_migration_version: None | str
        current_migration_version = self.current_migration_version

        expected_migration = self.expected_migration

        migration_drift = self.migration_drift.value

        rls_missing_count = self.rls_missing_count

        rls_valid = self.rls_valid

        critical_rpcs = self.critical_rpcs.to_dict()

        row_counts = self.row_counts.to_dict()

        environment = self.environment.value

        project_ref = self.project_ref

        checked_at = self.checked_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "databaseReachable": database_reachable,
                "currentMigration": current_migration,
                "currentMigrationVersion": current_migration_version,
                "expectedMigration": expected_migration,
                "migrationDrift": migration_drift,
                "rlsMissingCount": rls_missing_count,
                "rlsValid": rls_valid,
                "criticalRpcs": critical_rpcs,
                "rowCounts": row_counts,
                "environment": environment,
                "projectRef": project_ref,
                "checkedAt": checked_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_database_status_critical_rpcs import (
            DeveloperDatabaseStatusCriticalRpcs,
        )
        from ..models.developer_database_status_row_counts import DeveloperDatabaseStatusRowCounts

        d = dict(src_dict)
        database_reachable = d.pop("databaseReachable")

        def _parse_current_migration(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        current_migration = _parse_current_migration(d.pop("currentMigration"))

        def _parse_current_migration_version(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        current_migration_version = _parse_current_migration_version(
            d.pop("currentMigrationVersion")
        )

        expected_migration = d.pop("expectedMigration")

        migration_drift = DeveloperDatabaseStatusMigrationDrift(d.pop("migrationDrift"))

        rls_missing_count = d.pop("rlsMissingCount")

        rls_valid = d.pop("rlsValid")

        critical_rpcs = DeveloperDatabaseStatusCriticalRpcs.from_dict(d.pop("criticalRpcs"))

        row_counts = DeveloperDatabaseStatusRowCounts.from_dict(d.pop("rowCounts"))

        environment = DeveloperDatabaseStatusEnvironment(d.pop("environment"))

        project_ref = d.pop("projectRef")

        checked_at = datetime.datetime.fromisoformat(d.pop("checkedAt"))

        developer_database_status = cls(
            database_reachable=database_reachable,
            current_migration=current_migration,
            current_migration_version=current_migration_version,
            expected_migration=expected_migration,
            migration_drift=migration_drift,
            rls_missing_count=rls_missing_count,
            rls_valid=rls_valid,
            critical_rpcs=critical_rpcs,
            row_counts=row_counts,
            environment=environment,
            project_ref=project_ref,
            checked_at=checked_at,
        )

        return developer_database_status
