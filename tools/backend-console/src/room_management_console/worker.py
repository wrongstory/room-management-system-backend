from __future__ import annotations

from collections.abc import Callable
from typing import Any

from PySide6.QtCore import QObject, QRunnable, Signal, Slot

from .api_client import ApiError


class WorkerSignals(QObject):
    succeeded = Signal(object)
    failed = Signal(object)
    finished = Signal()


class Worker(QRunnable):
    def __init__(self, task: Callable[[], Any]) -> None:
        super().__init__()
        self._task = task
        self.signals = WorkerSignals()

    @Slot()
    def run(self) -> None:
        try:
            result = self._task()
        except ApiError as error:
            self.signals.failed.emit(error)
        except Exception:
            self.signals.failed.emit(
                ApiError(
                    status_code=0,
                    code="UNEXPECTED_CLIENT_ERROR",
                    message="운영도구 내부 오류가 발생했습니다. 입력값은 기록되지 않았습니다.",
                )
            )
        else:
            self.signals.succeeded.emit(result)
        finally:
            self.signals.finished.emit()
