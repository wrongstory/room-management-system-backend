from enum import Enum


class ListDeveloperRoomsStatus(str, Enum):
    ACTIVE = "active"
    ALL = "all"
    RETIRED = "retired"

    def __str__(self) -> str:
        return str(self.value)
