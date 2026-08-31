from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Literal, TypeVar, cast

from attrs import define as _attrs_define

from ..models.developer_runtime_status_environment import DeveloperRuntimeStatusEnvironment

if TYPE_CHECKING:
    from ..models.developer_runtime_status_configuration import DeveloperRuntimeStatusConfiguration
    from ..models.developer_runtime_status_runtime import DeveloperRuntimeStatusRuntime
    from ..models.developer_runtime_status_source import DeveloperRuntimeStatusSource


T = TypeVar("T", bound="DeveloperRuntimeStatus")


@_attrs_define
class DeveloperRuntimeStatus:
    """
    Attributes:
        adapter (Literal['supabase-edge']):
        environment (DeveloperRuntimeStatusEnvironment): 색상만으로 구분하지 말고 이 텍스트와 projectRef를 함께 표시합니다.
        project_ref (str): 현재 연결 대상 확인용 공개 project ref 또는 local/unknown
        runtime (DeveloperRuntimeStatusRuntime):
        source (DeveloperRuntimeStatusSource):
        configuration (DeveloperRuntimeStatusConfiguration): 소스 allowlist에 포함된 이름별 configured boolean. 값·길이·해시는 절대 포함하지
            않습니다.
        checked_at (datetime.datetime):
    """

    adapter: Literal["supabase-edge"]
    environment: DeveloperRuntimeStatusEnvironment
    project_ref: str
    runtime: DeveloperRuntimeStatusRuntime
    source: DeveloperRuntimeStatusSource
    configuration: DeveloperRuntimeStatusConfiguration
    checked_at: datetime.datetime

    def to_dict(self) -> dict[str, Any]:
        adapter = self.adapter

        environment = self.environment.value

        project_ref = self.project_ref

        runtime = self.runtime.to_dict()

        source = self.source.to_dict()

        configuration = self.configuration.to_dict()

        checked_at = self.checked_at.isoformat()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "adapter": adapter,
                "environment": environment,
                "projectRef": project_ref,
                "runtime": runtime,
                "source": source,
                "configuration": configuration,
                "checkedAt": checked_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_runtime_status_configuration import (
            DeveloperRuntimeStatusConfiguration,
        )
        from ..models.developer_runtime_status_runtime import DeveloperRuntimeStatusRuntime
        from ..models.developer_runtime_status_source import DeveloperRuntimeStatusSource

        d = dict(src_dict)
        adapter = cast(Literal["supabase-edge"], d.pop("adapter"))
        if adapter != "supabase-edge":
            raise ValueError(f"adapter must match const 'supabase-edge', got '{adapter}'")

        environment = DeveloperRuntimeStatusEnvironment(d.pop("environment"))

        project_ref = d.pop("projectRef")

        runtime = DeveloperRuntimeStatusRuntime.from_dict(d.pop("runtime"))

        source = DeveloperRuntimeStatusSource.from_dict(d.pop("source"))

        configuration = DeveloperRuntimeStatusConfiguration.from_dict(d.pop("configuration"))

        checked_at = datetime.datetime.fromisoformat(d.pop("checkedAt"))

        developer_runtime_status = cls(
            adapter=adapter,
            environment=environment,
            project_ref=project_ref,
            runtime=runtime,
            source=source,
            configuration=configuration,
            checked_at=checked_at,
        )

        return developer_runtime_status
