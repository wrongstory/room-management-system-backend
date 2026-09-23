from __future__ import annotations

import threading
from dataclasses import dataclass

import pytest

from room_management_console.readonly_db import (
    ReadonlyDbAvailability,
    ReadonlyDbError,
    ReadonlyQueryExecutor,
    ReadonlyQueryPolicy,
    readonly_db_availability,
    validate_readonly_query,
)


@dataclass(frozen=True)
class FakeDescription:
    name: str


class FakeCursor:
    def __init__(
        self,
        rows: list[tuple[object, ...]],
        columns: tuple[str, ...] = ("room_count",),
        *,
        fail_query: bool = False,
        query_started: threading.Event | None = None,
        query_release: threading.Event | None = None,
    ) -> None:
        self.rows = rows
        self.description = tuple(FakeDescription(name) for name in columns)
        self.fail_query = fail_query
        self.query_started = query_started
        self.query_release = query_release
        self.executed: list[str] = []
        self.closed = False

    def execute(self, query: str) -> object:
        self.executed.append(query)
        if query.startswith("SELECT") or query.startswith("WITH") or query.startswith("EXPLAIN"):
            if self.query_started is not None:
                self.query_started.set()
            if self.query_release is not None:
                self.query_release.wait(timeout=2)
            if self.fail_query:
                raise RuntimeError("private diagnostic driver detail")
        return self

    def fetchmany(self, size: int = 0) -> list[tuple[object, ...]]:
        return self.rows[:size]

    def close(self) -> None:
        self.closed = True


class FakeConnection:
    def __init__(self, cursor: FakeCursor) -> None:
        self._cursor = cursor
        self.committed = False
        self.rolled_back = False
        self.closed = False
        self.cancelled = False

    def cursor(self) -> FakeCursor:
        return self._cursor

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True

    def close(self) -> None:
        self.closed = True

    def cancel_safe(self, *, timeout: float = 30.0) -> None:
        assert timeout == 1.0
        self.cancelled = True


@pytest.mark.parametrize(
    "query",
    [
        "SELECT * FROM public.diagnostic_system_summary",
        "SELECT data_status, SUM(room_count) FROM public.diagnostic_room_state_summary "
        "GROUP BY data_status",
        "WITH states AS (SELECT * FROM public.diagnostic_room_state_summary) "
        "SELECT COUNT(*) FROM states",
        "EXPLAIN SELECT * FROM public.diagnostic_workflow_summary",
    ],
)
def test_validator_accepts_only_approved_read_queries(query: str) -> None:
    validated = validate_readonly_query(query)
    assert validated.sql
    assert validated.explain is query.startswith("EXPLAIN")


@pytest.mark.parametrize(
    ("query", "code"),
    [
        ("", "QUERY_EMPTY"),
        pytest.param(
            "SELECT '" + ("가" * 6_000) + "'",
            "QUERY_TOO_LARGE",
            id="query-byte-limit",
        ),
        (
            "SELECT * FROM public.diagnostic_system_summary; "
            "SELECT * FROM public.diagnostic_workflow_summary",
            "MULTI_STATEMENT_NOT_ALLOWED",
        ),
        ("UPDATE public.rooms SET room_number='999'", "SELECT_ONLY"),
        ("DELETE FROM public.rooms", "SELECT_ONLY"),
        ("CREATE TABLE public.probe(id int)", "SELECT_ONLY"),
        ("COPY public.rooms TO STDOUT", "SELECT_ONLY"),
        (
            "SELECT * INTO TEMP probe FROM public.diagnostic_system_summary",
            "QUERY_OPERATION_NOT_ALLOWED",
        ),
        ("SELECT * FROM public.rooms", "RELATION_NOT_APPROVED"),
        ("SELECT * FROM auth.users", "PROTECTED_SCHEMA_NOT_ALLOWED"),
        ("SELECT * FROM diagnostic_system_summary", "RELATION_NOT_APPROVED"),
        ("SELECT * FROM other.public.diagnostic_system_summary", "RELATION_NOT_APPROVED"),
        ("SELECT pg_sleep(1) FROM public.diagnostic_system_summary", "FUNCTION_NOT_APPROVED"),
        (
            "EXPLAIN ANALYZE SELECT * FROM public.diagnostic_system_summary",
            "EXPLAIN_OPTIONS_NOT_ALLOWED",
        ),
        (
            "EXPLAIN (ANALYZE false) SELECT * FROM public.diagnostic_system_summary",
            "EXPLAIN_OPTIONS_NOT_ALLOWED",
        ),
        (
            "WITH changed AS (DELETE FROM public.rooms RETURNING *) SELECT * FROM changed",
            "QUERY_OPERATION_NOT_ALLOWED",
        ),
        (
            "SELECT * FROM public.diagnostic_system_summary FOR UPDATE",
            "QUERY_OPERATION_NOT_ALLOWED",
        ),
    ],
)
def test_validator_rejects_unsafe_queries(query: str, code: str) -> None:
    with pytest.raises(ReadonlyDbError, match=code):
        validate_readonly_query(query)


def test_executor_applies_readonly_limits_before_query() -> None:
    cursor = FakeCursor([(121,)], ("room_count",))
    connection = FakeConnection(cursor)
    executor = ReadonlyQueryExecutor(lambda: connection)

    result = executor.execute("SELECT room_count FROM public.diagnostic_system_summary")

    assert result.columns == ("room_count",)
    assert result.rows == ((121,),)
    assert result.response_bytes > 0
    assert cursor.executed[:5] == [
        "SET TRANSACTION READ ONLY",
        "SET LOCAL statement_timeout = '3000ms'",
        "SET LOCAL lock_timeout = '500ms'",
        "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
        "SET LOCAL search_path = pg_catalog, public",
    ]
    assert cursor.executed[5].startswith("SELECT")
    assert connection.committed
    assert not connection.rolled_back
    assert cursor.closed and connection.closed


def test_executor_fails_closed_at_row_and_response_limits() -> None:
    row_cursor = FakeCursor([(1,), (2,), (3,)])
    row_connection = FakeConnection(row_cursor)
    row_executor = ReadonlyQueryExecutor(
        lambda: row_connection,
        ReadonlyQueryPolicy(max_rows=2),
    )
    with pytest.raises(ReadonlyDbError, match="RESULT_ROW_LIMIT_EXCEEDED"):
        row_executor.execute("SELECT * FROM public.diagnostic_system_summary")
    assert row_connection.rolled_back

    size_cursor = FakeCursor([("x" * 2_000,)], ("state",))
    size_connection = FakeConnection(size_cursor)
    size_executor = ReadonlyQueryExecutor(
        lambda: size_connection,
        ReadonlyQueryPolicy(max_response_bytes=1_024),
    )
    with pytest.raises(ReadonlyDbError, match="RESULT_SIZE_LIMIT_EXCEEDED"):
        size_executor.execute("SELECT * FROM public.diagnostic_workflow_summary")
    assert size_connection.rolled_back


def test_executor_redacts_database_errors() -> None:
    connection = FakeConnection(FakeCursor([], fail_query=True))
    executor = ReadonlyQueryExecutor(lambda: connection)

    with pytest.raises(ReadonlyDbError) as captured:
        executor.execute("SELECT * FROM public.diagnostic_system_summary")

    assert captured.value.code == "READONLY_QUERY_FAILED"
    assert str(captured.value) == "READONLY_QUERY_FAILED"
    assert "secret" not in str(captured.value)
    assert connection.rolled_back and connection.closed


def test_executor_can_cancel_an_active_query_without_retaining_credentials() -> None:
    query_started = threading.Event()
    query_release = threading.Event()
    cursor = FakeCursor([], query_started=query_started, query_release=query_release)
    connection = FakeConnection(cursor)
    executor = ReadonlyQueryExecutor(lambda: connection)
    failures: list[BaseException] = []

    def run_query() -> None:
        try:
            executor.execute("SELECT * FROM public.diagnostic_system_summary")
        except BaseException as error:  # pragma: no cover
            failures.append(error)

    thread = threading.Thread(target=run_query)
    thread.start()
    assert query_started.wait(timeout=2)
    assert executor.cancel()
    query_release.set()
    thread.join(timeout=2)

    assert not failures
    assert connection.cancelled
    assert executor.cancel() is False


def test_executor_rejects_a_second_query_while_one_is_active() -> None:
    query_started = threading.Event()
    query_release = threading.Event()
    cursor = FakeCursor([], query_started=query_started, query_release=query_release)
    connection = FakeConnection(cursor)
    executor = ReadonlyQueryExecutor(lambda: connection)

    thread = threading.Thread(
        target=lambda: executor.execute("SELECT * FROM public.diagnostic_system_summary")
    )
    thread.start()
    assert query_started.wait(timeout=2)

    with pytest.raises(ReadonlyDbError, match="QUERY_ALREADY_RUNNING"):
        executor.execute("SELECT * FROM public.diagnostic_workflow_summary")

    query_release.set()
    thread.join(timeout=2)
    assert not thread.is_alive()


def test_hosted_direct_database_profiles_remain_disabled() -> None:
    assert readonly_db_availability("local") == ReadonlyDbAvailability(True, None)
    for environment in ("production", "recovery"):
        availability = readonly_db_availability(environment)
        assert not availability.enabled
        assert availability.reason == "HOSTED_DIRECT_DB_NOT_APPROVED"
