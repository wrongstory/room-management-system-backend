from enum import Enum


class ManagedRole(str, Enum):
    ADMIN = "admin"
    MAID = "maid"

    def __str__(self) -> str:
        return str(self.value)
