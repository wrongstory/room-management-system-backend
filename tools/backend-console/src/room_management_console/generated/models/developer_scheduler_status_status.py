from enum import Enum


class DeveloperSchedulerStatusStatus(str, Enum):
    ACTOR_INVALID = "actor_invalid"
    AWAITING_FIRST_RUN = "awaiting_first_run"
    DEGRADED = "degraded"
    HEALTHY = "healthy"
    NOT_CONFIGURED = "not_configured"

    def __str__(self) -> str:
        return str(self.value)
