from enum import Enum


class ActivityCategory(str, Enum):
    AUTH = "auth"
    AUTHORIZATION = "authorization"
    SENSITIVE_ACCESS = "sensitive_access"

    def __str__(self) -> str:
        return str(self.value)
