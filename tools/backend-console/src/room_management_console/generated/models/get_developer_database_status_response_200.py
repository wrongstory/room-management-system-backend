from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_database_status import DeveloperDatabaseStatus


T = TypeVar("T", bound="GetDeveloperDatabaseStatusResponse200")


@_attrs_define
class GetDeveloperDatabaseStatusResponse200:
    """
    Attributes:
        database (DeveloperDatabaseStatus):
    """

    database: DeveloperDatabaseStatus

    def to_dict(self) -> dict[str, Any]:
        database = self.database.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "database": database,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_database_status import DeveloperDatabaseStatus

        d = dict(src_dict)
        database = DeveloperDatabaseStatus.from_dict(d.pop("database"))

        get_developer_database_status_response_200 = cls(
            database=database,
        )

        return get_developer_database_status_response_200
