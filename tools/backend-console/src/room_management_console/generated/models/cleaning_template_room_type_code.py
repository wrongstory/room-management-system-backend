from enum import Enum


class CleaningTemplateRoomTypeCode(str, Enum):
    OCEANFAMILY = "oceanFamily"
    OCEANPREMIUM = "oceanPremium"
    PREMIUM = "premium"
    STANDARD = "standard"

    def __str__(self) -> str:
        return str(self.value)
