from enum import Enum


class StatusChangeRequestStatus(str, Enum):
    ACTIVE = "active"
    DEPARTED = "departed"
    INACTIVE = "inactive"

    def __str__(self) -> str:
        return str(self.value)
