from __future__ import annotations

from room_management_console.models import Actor, MemorySession
from room_management_console.redaction import redact, redact_text


def test_nested_sensitive_values_are_redacted() -> None:
    value = redact(
        {
            "password": "not-a-real-password",
            "accessToken": "not-a-real-token",
            "nested": {"phone": "010-0000-0000", "safe": "request-123"},
        }
    )
    assert value == {
        "password": "[REDACTED]",
        "accessToken": "[REDACTED]",
        "nested": {"phone": "[REDACTED]", "safe": "request-123"},
    }


def test_exception_text_redacts_bearer_jwt_and_phone() -> None:
    text = redact_text("Bearer abc.def.ghi eyJhbGciOiJIUzI1NiJ9.e30.signature 01000000000")
    assert "01000000000" not in text
    assert "eyJ" not in text
    assert "abc.def.ghi" not in text


def test_session_repr_omits_tokens() -> None:
    session = MemorySession.create(
        access_token="not-a-real-access-token",
        refresh_token="not-a-real-refresh-token",
        expires_in=3600,
        actor=Actor(
            auth_user_id="00000000-0000-4000-8000-000000000001",
            profile_id="00000000-0000-4000-8000-000000000002",
            display_name="개발자",
            role="developer",
            must_change_password=False,
        ),
    )
    representation = repr(session)
    assert "not-a-real-access-token" not in representation
    assert "not-a-real-refresh-token" not in representation
