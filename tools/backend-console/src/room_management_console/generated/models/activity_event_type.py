from enum import Enum


class ActivityEventType(str, Enum):
    AUTHORIZATION_DENIED = "authorization.denied"
    AUTH_LOGIN_FAILED = "auth.login_failed"
    AUTH_LOGIN_SUCCEEDED = "auth.login_succeeded"
    SENSITIVE_READ = "sensitive.read"

    def __str__(self) -> str:
        return str(self.value)
