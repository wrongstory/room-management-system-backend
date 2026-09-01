from enum import Enum


class DeveloperRuntimeStatusSourceFastifyRollbackBaseline(str, Enum):
    AVAILABLE = "available"
    RETIRED = "retired"

    def __str__(self) -> str:
        return str(self.value)
