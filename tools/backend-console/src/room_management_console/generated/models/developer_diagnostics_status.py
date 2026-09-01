from enum import Enum


class DeveloperDiagnosticsStatus(str, Enum):
    DEGRADED = "degraded"
    PASSED = "passed"

    def __str__(self) -> str:
        return str(self.value)
