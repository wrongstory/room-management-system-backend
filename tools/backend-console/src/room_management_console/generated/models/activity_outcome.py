from enum import Enum


class ActivityOutcome(str, Enum):
    DENIED = "denied"
    FAILED = "failed"
    SUCCEEDED = "succeeded"

    def __str__(self) -> str:
        return str(self.value)
