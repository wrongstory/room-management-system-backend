from enum import Enum


class RoomPrimaryDisplayStatus(str, Enum):
    ARRIVAL_PENDING = "ARRIVAL_PENDING"
    BLOCKED = "BLOCKED"
    CLEANING_REQUIRED = "CLEANING_REQUIRED"
    OCCUPIED = "OCCUPIED"
    READY = "READY"
    RESERVATION_PRESENT = "RESERVATION_PRESENT"

    def __str__(self) -> str:
        return str(self.value)
