from enum import Enum


class DeveloperRuntimeStatusEnvironment(str, Enum):
    LOCAL = "local"
    PRODUCTION = "production"
    RECOVERY = "recovery"
    UNKNOWN = "unknown"

    def __str__(self) -> str:
        return str(self.value)
