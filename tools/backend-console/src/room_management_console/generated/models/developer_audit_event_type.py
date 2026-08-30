from enum import Enum


class DeveloperAuditEventType(str, Enum):
    ACCOUNT_BOOTSTRAP_ADMIN_CREATED = "account.bootstrap_admin_created"
    ACCOUNT_BOOTSTRAP_DEVELOPER_CREATED = "account.bootstrap_developer_created"
    ACCOUNT_CREATED = "account.created"
    ACCOUNT_PASSWORD_CHANGED = "account.password_changed"
    ACCOUNT_PASSWORD_RESET_REQUESTED = "account.password_reset_requested"
    ACCOUNT_ROLE_CHANGED = "account.role_changed"
    ACCOUNT_STATUS_CHANGED = "account.status_changed"
    ACCOUNT_UNLOCKED = "account.unlocked"

    def __str__(self) -> str:
        return str(self.value)
