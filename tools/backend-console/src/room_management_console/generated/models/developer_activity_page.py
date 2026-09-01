from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_activity_event import DeveloperActivityEvent


T = TypeVar("T", bound="DeveloperActivityPage")


@_attrs_define
class DeveloperActivityPage:
    """
    Attributes:
        events (list[DeveloperActivityEvent]):
        next_cursor (None | str):
    """

    events: list[DeveloperActivityEvent]
    next_cursor: None | str

    def to_dict(self) -> dict[str, Any]:
        events = []
        for events_item_data in self.events:
            events_item = events_item_data.to_dict()
            events.append(events_item)

        next_cursor: None | str
        next_cursor = self.next_cursor

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "events": events,
                "nextCursor": next_cursor,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_activity_event import DeveloperActivityEvent

        d = dict(src_dict)
        events = []
        _events = d.pop("events")
        for events_item_data in _events:
            events_item = DeveloperActivityEvent.from_dict(events_item_data)

            events.append(events_item)

        def _parse_next_cursor(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        next_cursor = _parse_next_cursor(d.pop("nextCursor"))

        developer_activity_page = cls(
            events=events,
            next_cursor=next_cursor,
        )

        return developer_activity_page
