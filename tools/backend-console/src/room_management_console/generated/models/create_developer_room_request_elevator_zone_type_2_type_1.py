from enum import Enum


class CreateDeveloperRoomRequestElevatorZoneType2Type1(str, Enum):
    A = "A"
    B = "B"
    C = "C"

    def __str__(self) -> str:
        return str(self.value)
