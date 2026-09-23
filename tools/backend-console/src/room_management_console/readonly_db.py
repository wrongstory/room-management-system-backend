from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Callable, Sequence
from contextlib import suppress
from dataclasses import dataclass
from typing import Protocol, cast

import psycopg
from sqlglot import exp, parse
from sqlglot.errors import ParseError

from .models import Environment

APPROVED_RELATIONS = frozenset(
    {
        "public.diagnostic_room_state_summary",
        "public.diagnostic_system_summary",
        "public.diagnostic_workflow_summary",
    }
)
PROTECTED_SCHEMAS = frozenset(
    {
        "auth",
        "cron",
        "information_schema",
        "net",
        "pg_catalog",
        "private",
        "realtime",
        "storage",
        "supabase_migrations",
        "vault",
    }
)
APPROVED_FUNCTIONS = frozenset(
    {"AVG", "COALESCE", "COUNT", "GREATEST", "LEAST", "MAX", "MIN", "NULLIF", "SUM"}
)
EXPLAIN_PREFIX = re.compile(r"^\s*EXPLAIN\s+(?=(?:SELECT|WITH)\b)", re.IGNORECASE)
MAX_QUERY_BYTES = 16 * 1024
HOSTED_POOLER_HOST = re.compile(r"^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$")


class ReadonlyDbError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class ReadonlyQueryPolicy:
    max_rows: int = 200
    max_response_bytes: int = 256 * 1024
    statement_timeout_ms: int = 3_000
    lock_timeout_ms: int = 500
    idle_transaction_timeout_ms: int = 5_000

    def __post_init__(self) -> None:
        if not 1 <= self.max_rows <= 1_000:
            raise ValueError("max_rows는 1~1000 사이여야 합니다.")
        if not 1_024 <= self.max_response_bytes <= 1024 * 1024:
            raise ValueError("max_response_bytes는 1KiB~1MiB 사이여야 합니다.")
        if not 100 <= self.statement_timeout_ms <= 10_000:
            raise ValueError("statement_timeout_ms는 100~10000 사이여야 합니다.")
        if not 50 <= self.lock_timeout_ms <= self.statement_timeout_ms:
            raise ValueError("lock_timeout_ms가 허용 범위를 벗어났습니다.")
        if not 500 <= self.idle_transaction_timeout_ms <= 30_000:
            raise ValueError("idle_transaction_timeout_ms가 허용 범위를 벗어났습니다.")


@dataclass(frozen=True, slots=True)
class ValidatedQuery:
    sql: str
    explain: bool


@dataclass(frozen=True, slots=True)
class ReadonlyQueryResult:
    columns: tuple[str, ...]
    rows: tuple[tuple[object, ...], ...]
    elapsed_ms: int
    response_bytes: int


@dataclass(frozen=True, slots=True)
class ReadonlyDbAvailability:
    enabled: bool
    reason: str | None


@dataclass(frozen=True, slots=True)
class HostedReadonlyProfile:
    environment: Environment
    project_ref: str
    host: str
    port: int = 5432
    dbname: str = "postgres"
    role: str = "rms_diagnostic"

    @property
    def user(self) -> str:
        return f"{self.role}.{self.project_ref}"

    @classmethod
    def create(
        cls,
        *,
        environment: Environment,
        expected_project_ref: str,
        confirmed_project_ref: str,
        host: str,
    ) -> HostedReadonlyProfile:
        if environment not in {"production", "recovery"}:
            raise ReadonlyDbError("HOSTED_ENVIRONMENT_REQUIRED")
        if confirmed_project_ref != expected_project_ref:
            raise ReadonlyDbError("PROJECT_CONFIRMATION_MISMATCH")
        normalized_host = host.strip().lower()
        if not HOSTED_POOLER_HOST.fullmatch(normalized_host):
            raise ReadonlyDbError("POOLER_HOST_INVALID")
        return cls(
            environment=environment,
            project_ref=expected_project_ref,
            host=normalized_host,
        )


class ColumnDescription(Protocol):
    @property
    def name(self) -> str: ...


class CursorLike(Protocol):
    @property
    def description(self) -> Sequence[ColumnDescription] | None: ...

    def execute(self, query: str) -> object: ...

    def fetchmany(self, size: int = 0) -> list[tuple[object, ...]]: ...

    def close(self) -> None: ...


class ConnectionLike(Protocol):
    def cursor(self) -> CursorLike: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...

    def close(self) -> None: ...

    def cancel_safe(self, *, timeout: float = 30.0) -> None: ...


ConnectionFactory = Callable[[], ConnectionLike]


def readonly_db_availability(
    environment: Environment, *, enable_hosted: bool = False
) -> ReadonlyDbAvailability:
    if environment == "local":
        return ReadonlyDbAvailability(enabled=True, reason=None)
    if enable_hosted:
        return ReadonlyDbAvailability(enabled=True, reason=None)
    return ReadonlyDbAvailability(enabled=False, reason="HOSTED_DIRECT_DB_NOT_APPROVED")


def validate_readonly_query(source: str) -> ValidatedQuery:
    if not source.strip():
        raise ReadonlyDbError("QUERY_EMPTY")
    if len(source.encode("utf-8")) > MAX_QUERY_BYTES:
        raise ReadonlyDbError("QUERY_TOO_LARGE")

    explain_match = EXPLAIN_PREFIX.match(source)
    explain = explain_match is not None
    candidate = source[explain_match.end() :] if explain_match else source
    if source.lstrip().upper().startswith("EXPLAIN") and not explain:
        raise ReadonlyDbError("EXPLAIN_OPTIONS_NOT_ALLOWED")

    try:
        statements = parse(candidate, read="postgres")
    except ParseError as error:
        raise ReadonlyDbError("QUERY_INVALID") from error
    if len(statements) != 1 or statements[0] is None:
        raise ReadonlyDbError("MULTI_STATEMENT_NOT_ALLOWED")
    statement = statements[0]
    if not isinstance(statement, exp.Select):
        raise ReadonlyDbError("SELECT_ONLY")

    forbidden_nodes = (
        exp.Alter,
        exp.Command,
        exp.Copy,
        exp.Create,
        exp.Delete,
        exp.Drop,
        exp.Insert,
        exp.Into,
        exp.Lock,
        exp.Merge,
        exp.Transaction,
        exp.Update,
    )
    if any(statement.find(node_type) is not None for node_type in forbidden_nodes):
        raise ReadonlyDbError("QUERY_OPERATION_NOT_ALLOWED")

    cte_names = {
        cte.alias_or_name.lower() for cte in statement.find_all(exp.CTE) if cte.alias_or_name
    }
    for table in statement.find_all(exp.Table):
        table_name = table.name.lower()
        schema_name = table.db.lower() if table.db else ""
        if table.catalog:
            raise ReadonlyDbError("RELATION_NOT_APPROVED")
        if not schema_name and table_name in cte_names:
            continue
        if schema_name in PROTECTED_SCHEMAS:
            raise ReadonlyDbError("PROTECTED_SCHEMA_NOT_ALLOWED")
        qualified_name = f"{schema_name}.{table_name}" if schema_name else table_name
        if qualified_name not in APPROVED_RELATIONS:
            raise ReadonlyDbError("RELATION_NOT_APPROVED")

    for function in statement.find_all(exp.Func):
        if function.sql_name().upper() not in APPROVED_FUNCTIONS:
            raise ReadonlyDbError("FUNCTION_NOT_APPROVED")

    canonical = statement.sql(dialect="postgres", pretty=False)
    if explain:
        canonical = f"EXPLAIN {canonical}"
    return ValidatedQuery(sql=canonical, explain=explain)


def open_psycopg_connection(
    *,
    host: str,
    port: int,
    dbname: str,
    user: str,
    password: str,
    sslmode: str,
    sslrootcert: str | None = None,
) -> ConnectionLike:
    if sslmode not in {"disable", "require", "verify-ca", "verify-full"}:
        raise ValueError("sslmode이 허용되지 않았습니다.")
    if sslrootcert is not None:
        return cast(
            ConnectionLike,
            psycopg.connect(
                host=host,
                port=port,
                dbname=dbname,
                user=user,
                password=password,
                sslmode=sslmode,
                sslrootcert=sslrootcert,
                gssencmode="disable",
                connect_timeout=5,
                autocommit=False,
            ),
        )
    return cast(
        ConnectionLike,
        psycopg.connect(
            host=host,
            port=port,
            dbname=dbname,
            user=user,
            password=password,
            sslmode=sslmode,
            gssencmode="disable",
            connect_timeout=5,
            autocommit=False,
        ),
    )


def open_hosted_readonly_connection(
    profile: HostedReadonlyProfile,
    password: str,
) -> ConnectionLike:
    if not password or len(password) > 512 or any(character in "\r\n\0" for character in password):
        raise ReadonlyDbError("DB_PASSWORD_INVALID")
    connection: ConnectionLike | None = None
    cursor: CursorLike | None = None
    try:
        connection = open_psycopg_connection(
            host=profile.host,
            port=profile.port,
            dbname=profile.dbname,
            user=profile.user,
            password=password,
            sslmode="verify-full",
            sslrootcert="system",
        )
        cursor = connection.cursor()
        cursor.execute(
            "SELECT current_user, current_database(), "
            "current_setting('default_transaction_read_only')"
        )
        rows = cursor.fetchmany(2)
        if rows != [(profile.role, profile.dbname, "on")]:
            raise ReadonlyDbError("DB_IDENTITY_MISMATCH")
        connection.rollback()
        return connection
    except ReadonlyDbError:
        if connection is not None:
            with suppress(Exception):
                connection.close()
        raise
    except Exception as error:
        if connection is not None:
            with suppress(Exception):
                connection.close()
        raise ReadonlyDbError("DB_CONNECTION_FAILED") from error
    finally:
        if cursor is not None:
            with suppress(Exception):
                cursor.close()


class ReadonlyQueryExecutor:
    def __init__(
        self,
        connection_factory: ConnectionFactory,
        policy: ReadonlyQueryPolicy | None = None,
    ) -> None:
        self._connection_factory = connection_factory
        self._policy = policy or ReadonlyQueryPolicy()
        self._active_connection: ConnectionLike | None = None
        self._executing = False
        self._active_lock = threading.Lock()

    def cancel(self) -> bool:
        with self._active_lock:
            connection = self._active_connection
        if connection is None:
            return False
        try:
            connection.cancel_safe(timeout=1.0)
        except Exception as error:
            raise ReadonlyDbError("QUERY_CANCEL_FAILED") from error
        return True

    def execute(self, source: str) -> ReadonlyQueryResult:
        validated = validate_readonly_query(source)
        with self._active_lock:
            if self._executing:
                raise ReadonlyDbError("QUERY_ALREADY_RUNNING")
            self._executing = True
        started_at = time.monotonic()
        connection: ConnectionLike | None = None
        cursor: CursorLike | None = None
        try:
            connection = self._connection_factory()
            with self._active_lock:
                self._active_connection = connection
            cursor = connection.cursor()
            cursor.execute("SET TRANSACTION READ ONLY")
            cursor.execute(f"SET LOCAL statement_timeout = '{self._policy.statement_timeout_ms}ms'")
            cursor.execute(f"SET LOCAL lock_timeout = '{self._policy.lock_timeout_ms}ms'")
            cursor.execute(
                "SET LOCAL idle_in_transaction_session_timeout = "
                f"'{self._policy.idle_transaction_timeout_ms}ms'"
            )
            cursor.execute("SET LOCAL search_path = pg_catalog, public")
            cursor.execute(validated.sql)
            rows = cursor.fetchmany(self._policy.max_rows + 1)
            if len(rows) > self._policy.max_rows:
                raise ReadonlyDbError("RESULT_ROW_LIMIT_EXCEEDED")
            description = cursor.description or ()
            columns = tuple(item.name for item in description)
            encoded = json.dumps(
                {"columns": columns, "rows": rows},
                default=str,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            if len(encoded) > self._policy.max_response_bytes:
                raise ReadonlyDbError("RESULT_SIZE_LIMIT_EXCEEDED")
            connection.commit()
            return ReadonlyQueryResult(
                columns=columns,
                rows=tuple(rows),
                elapsed_ms=max(0, round((time.monotonic() - started_at) * 1_000)),
                response_bytes=len(encoded),
            )
        except ReadonlyDbError:
            if connection is not None:
                with suppress(Exception):
                    connection.rollback()
            raise
        except Exception as error:
            if connection is not None:
                with suppress(Exception):
                    connection.rollback()
            raise ReadonlyDbError("READONLY_QUERY_FAILED") from error
        finally:
            with self._active_lock:
                self._active_connection = None
                self._executing = False
            if cursor is not None:
                with suppress(Exception):
                    cursor.close()
            if connection is not None:
                with suppress(Exception):
                    connection.close()
