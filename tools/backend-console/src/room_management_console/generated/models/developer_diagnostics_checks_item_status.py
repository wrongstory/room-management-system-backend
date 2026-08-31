from enum import Enum


class DeveloperDiagnosticsChecksItemStatus(str, Enum):
    FAILED = "failed"
    PASSED = "passed"
    TIMED_OUT = "timed_out"

    def __str__(self) -> str:
        return str(self.value)
