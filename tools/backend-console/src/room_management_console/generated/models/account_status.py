from enum import Enum


class AccountStatus(str, Enum):
    ACTIVE = "active"
    DEACTIVATION_PENDING = "deactivation_pending"
    DEPARTED = "departed"
    INACTIVE = "inactive"
    UPLOAD_ONLY = "upload_only"

    def __str__(self) -> str:
        return str(self.value)
