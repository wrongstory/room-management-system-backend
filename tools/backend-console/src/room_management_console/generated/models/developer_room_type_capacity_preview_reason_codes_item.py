from enum import Enum


class DeveloperRoomTypeCapacityPreviewReasonCodesItem(str, Enum):
    ROOM_TYPE_CAPACITY_ACTIVE_RESERVATION_CONFLICT = (
        "ROOM_TYPE_CAPACITY_ACTIVE_RESERVATION_CONFLICT"
    )

    def __str__(self) -> str:
        return str(self.value)
