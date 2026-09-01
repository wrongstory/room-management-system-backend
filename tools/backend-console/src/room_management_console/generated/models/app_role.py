from enum import Enum


class AppRole(str, Enum):
    ADMIN = "admin"
    DEVELOPER = "developer"
    MAID = "maid"

    def __str__(self) -> str:
        return str(self.value)
