from enum import Enum


class DeveloperDatabaseStatusMigrationDrift(str, Enum):
    AHEAD = "ahead"
    BEHIND = "behind"
    EQUAL = "equal"
    UNKNOWN = "unknown"

    def __str__(self) -> str:
        return str(self.value)
