from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="DeveloperDatabaseStatusPhotoPurgeBacklog")


@_attrs_define
class DeveloperDatabaseStatusPhotoPurgeBacklog:
    """
    Attributes:
        accepted_due (int):
        orphan_due (int):
        folder_due (int):
        blocked (int):
    """

    accepted_due: int
    orphan_due: int
    folder_due: int
    blocked: int

    def to_dict(self) -> dict[str, Any]:
        accepted_due = self.accepted_due

        orphan_due = self.orphan_due

        folder_due = self.folder_due

        blocked = self.blocked

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "acceptedDue": accepted_due,
                "orphanDue": orphan_due,
                "folderDue": folder_due,
                "blocked": blocked,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        accepted_due = d.pop("acceptedDue")

        orphan_due = d.pop("orphanDue")

        folder_due = d.pop("folderDue")

        blocked = d.pop("blocked")

        developer_database_status_photo_purge_backlog = cls(
            accepted_due=accepted_due,
            orphan_due=orphan_due,
            folder_due=folder_due,
            blocked=blocked,
        )

        return developer_database_status_photo_purge_backlog
