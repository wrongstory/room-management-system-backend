from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, Literal

HostedEnvironment = Literal["production", "recovery"]


@dataclass(frozen=True, slots=True)
class ApprovedHostedTarget:
    project_ref: str
    supabase_url: str


# Supabase project ref와 기본 URL은 공개 식별자이며 운영 대상 혼동을 막기 위해 source에서
# 고정한다. publishable key와 모든 secret은 이 mapping에 포함하지 않는다.
APPROVED_HOSTED_TARGETS: Final[Mapping[HostedEnvironment, ApprovedHostedTarget]] = {
    "production": ApprovedHostedTarget(
        project_ref="aodikrxcczbogjpsjwjt",
        supabase_url="https://aodikrxcczbogjpsjwjt.supabase.co",
    ),
    "recovery": ApprovedHostedTarget(
        project_ref="matalcofimnhuzslfhdd",
        supabase_url="https://matalcofimnhuzslfhdd.supabase.co",
    ),
}
