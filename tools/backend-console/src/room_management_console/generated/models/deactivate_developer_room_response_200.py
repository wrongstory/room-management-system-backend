from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_room_mutation_result import DeveloperRoomMutationResult


T = TypeVar("T", bound="DeactivateDeveloperRoomResponse200")


@_attrs_define
class DeactivateDeveloperRoomResponse200:
    """
    Attributes:
        deactivation (DeveloperRoomMutationResult):
    """

    deactivation: DeveloperRoomMutationResult

    def to_dict(self) -> dict[str, Any]:
        deactivation = self.deactivation.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "deactivation": deactivation,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_room_mutation_result import DeveloperRoomMutationResult

        d = dict(src_dict)
        deactivation = DeveloperRoomMutationResult.from_dict(d.pop("deactivation"))

        deactivate_developer_room_response_200 = cls(
            deactivation=deactivation,
        )

        return deactivate_developer_room_response_200
