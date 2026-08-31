from enum import Enum


class DeveloperSchedulerStatusLastHeartbeatType0Status(str, Enum):
    FAILED = "failed"
    SUCCEEDED = "succeeded"

    def __str__(self) -> str:
        return str(self.value)
