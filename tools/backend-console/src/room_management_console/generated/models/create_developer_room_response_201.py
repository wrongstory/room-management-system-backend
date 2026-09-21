from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_room_mutation_result import DeveloperRoomMutationResult


T = TypeVar("T", bound="CreateDeveloperRoomResponse201")


@_attrs_define
class CreateDeveloperRoomResponse201:
    """
    Attributes:
        creation (DeveloperRoomMutationResult):
    """

    creation: DeveloperRoomMutationResult

    def to_dict(self) -> dict[str, Any]:
        creation = self.creation.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "creation": creation,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_room_mutation_result import DeveloperRoomMutationResult

        d = dict(src_dict)
        creation = DeveloperRoomMutationResult.from_dict(d.pop("creation"))

        create_developer_room_response_201 = cls(
            creation=creation,
        )

        return create_developer_room_response_201
