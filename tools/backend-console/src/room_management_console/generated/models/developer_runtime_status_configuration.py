from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.developer_runtime_status_configuration_accountphonepepper import (
        DeveloperRuntimeStatusConfigurationACCOUNTPHONEPEPPER,
    )
    from ..models.developer_runtime_status_configuration_corsorigins import (
        DeveloperRuntimeStatusConfigurationCORSORIGINS,
    )
    from ..models.developer_runtime_status_configuration_googledriveclientid import (
        DeveloperRuntimeStatusConfigurationGOOGLEDRIVECLIENTID,
    )
    from ..models.developer_runtime_status_configuration_googledriveclientsecret import (
        DeveloperRuntimeStatusConfigurationGOOGLEDRIVECLIENTSECRET,
    )
    from ..models.developer_runtime_status_configuration_googledriverefreshtoken import (
        DeveloperRuntimeStatusConfigurationGOOGLEDRIVEREFRESHTOKEN,
    )
    from ..models.developer_runtime_status_configuration_googledriverootfolderid import (
        DeveloperRuntimeStatusConfigurationGOOGLEDRIVEROOTFOLDERID,
    )
    from ..models.developer_runtime_status_configuration_payrollcursorhmacsecret import (
        DeveloperRuntimeStatusConfigurationPAYROLLCURSORHMACSECRET,
    )
    from ..models.developer_runtime_status_configuration_photopurgeinvokesecret import (
        DeveloperRuntimeStatusConfigurationPHOTOPURGEINVOKESECRET,
    )
    from ..models.developer_runtime_status_configuration_reservationguestnamepepper import (
        DeveloperRuntimeStatusConfigurationRESERVATIONGUESTNAMEPEPPER,
    )
    from ..models.developer_runtime_status_configuration_reservationpiikeybase64 import (
        DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYBASE64,
    )
    from ..models.developer_runtime_status_configuration_reservationpiikeyringjson import (
        DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYRINGJSON,
    )
    from ..models.developer_runtime_status_configuration_reservationpiikeyversion import (
        DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYVERSION,
    )
    from ..models.developer_runtime_status_configuration_reservationscheduleractorprofileid import (
        DeveloperRuntimeStatusConfigurationRESERVATIONSCHEDULERACTORPROFILEID,
    )
    from ..models.developer_runtime_status_configuration_schedulerinvokesecret import (
        DeveloperRuntimeStatusConfigurationSCHEDULERINVOKESECRET,
    )


T = TypeVar("T", bound="DeveloperRuntimeStatusConfiguration")


@_attrs_define
class DeveloperRuntimeStatusConfiguration:
    """소스 allowlist에 포함된 이름별 configured boolean. 값·길이·해시는 절대 포함하지 않습니다.

    Attributes:
        account_phone_pepper (DeveloperRuntimeStatusConfigurationACCOUNTPHONEPEPPER):
        reservation_pii_key_base64 (DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYBASE64):
        reservation_pii_key_version (DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYVERSION):
        reservation_pii_keyring_json (DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYRINGJSON):
        reservation_guest_name_pepper (DeveloperRuntimeStatusConfigurationRESERVATIONGUESTNAMEPEPPER):
        reservation_scheduler_actor_profile_id (DeveloperRuntimeStatusConfigurationRESERVATIONSCHEDULERACTORPROFILEID):
        scheduler_invoke_secret (DeveloperRuntimeStatusConfigurationSCHEDULERINVOKESECRET):
        cors_origins (DeveloperRuntimeStatusConfigurationCORSORIGINS):
        google_drive_client_id (DeveloperRuntimeStatusConfigurationGOOGLEDRIVECLIENTID):
        google_drive_client_secret (DeveloperRuntimeStatusConfigurationGOOGLEDRIVECLIENTSECRET):
        google_drive_refresh_token (DeveloperRuntimeStatusConfigurationGOOGLEDRIVEREFRESHTOKEN):
        google_drive_root_folder_id (DeveloperRuntimeStatusConfigurationGOOGLEDRIVEROOTFOLDERID):
        photo_purge_invoke_secret (DeveloperRuntimeStatusConfigurationPHOTOPURGEINVOKESECRET):
        payroll_cursor_hmac_secret (DeveloperRuntimeStatusConfigurationPAYROLLCURSORHMACSECRET):
    """

    account_phone_pepper: DeveloperRuntimeStatusConfigurationACCOUNTPHONEPEPPER
    reservation_pii_key_base64: DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYBASE64
    reservation_pii_key_version: DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYVERSION
    reservation_pii_keyring_json: DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYRINGJSON
    reservation_guest_name_pepper: DeveloperRuntimeStatusConfigurationRESERVATIONGUESTNAMEPEPPER
    reservation_scheduler_actor_profile_id: (
        DeveloperRuntimeStatusConfigurationRESERVATIONSCHEDULERACTORPROFILEID
    )
    scheduler_invoke_secret: DeveloperRuntimeStatusConfigurationSCHEDULERINVOKESECRET
    cors_origins: DeveloperRuntimeStatusConfigurationCORSORIGINS
    google_drive_client_id: DeveloperRuntimeStatusConfigurationGOOGLEDRIVECLIENTID
    google_drive_client_secret: DeveloperRuntimeStatusConfigurationGOOGLEDRIVECLIENTSECRET
    google_drive_refresh_token: DeveloperRuntimeStatusConfigurationGOOGLEDRIVEREFRESHTOKEN
    google_drive_root_folder_id: DeveloperRuntimeStatusConfigurationGOOGLEDRIVEROOTFOLDERID
    photo_purge_invoke_secret: DeveloperRuntimeStatusConfigurationPHOTOPURGEINVOKESECRET
    payroll_cursor_hmac_secret: DeveloperRuntimeStatusConfigurationPAYROLLCURSORHMACSECRET

    def to_dict(self) -> dict[str, Any]:
        account_phone_pepper = self.account_phone_pepper.to_dict()

        reservation_pii_key_base64 = self.reservation_pii_key_base64.to_dict()

        reservation_pii_key_version = self.reservation_pii_key_version.to_dict()

        reservation_pii_keyring_json = self.reservation_pii_keyring_json.to_dict()

        reservation_guest_name_pepper = self.reservation_guest_name_pepper.to_dict()

        reservation_scheduler_actor_profile_id = (
            self.reservation_scheduler_actor_profile_id.to_dict()
        )

        scheduler_invoke_secret = self.scheduler_invoke_secret.to_dict()

        cors_origins = self.cors_origins.to_dict()

        google_drive_client_id = self.google_drive_client_id.to_dict()

        google_drive_client_secret = self.google_drive_client_secret.to_dict()

        google_drive_refresh_token = self.google_drive_refresh_token.to_dict()

        google_drive_root_folder_id = self.google_drive_root_folder_id.to_dict()

        photo_purge_invoke_secret = self.photo_purge_invoke_secret.to_dict()

        payroll_cursor_hmac_secret = self.payroll_cursor_hmac_secret.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "ACCOUNT_PHONE_PEPPER": account_phone_pepper,
                "RESERVATION_PII_KEY_BASE64": reservation_pii_key_base64,
                "RESERVATION_PII_KEY_VERSION": reservation_pii_key_version,
                "RESERVATION_PII_KEYRING_JSON": reservation_pii_keyring_json,
                "RESERVATION_GUEST_NAME_PEPPER": reservation_guest_name_pepper,
                "RESERVATION_SCHEDULER_ACTOR_PROFILE_ID": reservation_scheduler_actor_profile_id,
                "SCHEDULER_INVOKE_SECRET": scheduler_invoke_secret,
                "CORS_ORIGINS": cors_origins,
                "GOOGLE_DRIVE_CLIENT_ID": google_drive_client_id,
                "GOOGLE_DRIVE_CLIENT_SECRET": google_drive_client_secret,
                "GOOGLE_DRIVE_REFRESH_TOKEN": google_drive_refresh_token,
                "GOOGLE_DRIVE_ROOT_FOLDER_ID": google_drive_root_folder_id,
                "PHOTO_PURGE_INVOKE_SECRET": photo_purge_invoke_secret,
                "PAYROLL_CURSOR_HMAC_SECRET": payroll_cursor_hmac_secret,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.developer_runtime_status_configuration_accountphonepepper import (
            DeveloperRuntimeStatusConfigurationACCOUNTPHONEPEPPER,
        )
        from ..models.developer_runtime_status_configuration_corsorigins import (
            DeveloperRuntimeStatusConfigurationCORSORIGINS,
        )
        from ..models.developer_runtime_status_configuration_googledriveclientid import (
            DeveloperRuntimeStatusConfigurationGOOGLEDRIVECLIENTID,
        )
        from ..models.developer_runtime_status_configuration_googledriveclientsecret import (
            DeveloperRuntimeStatusConfigurationGOOGLEDRIVECLIENTSECRET,
        )
        from ..models.developer_runtime_status_configuration_googledriverefreshtoken import (
            DeveloperRuntimeStatusConfigurationGOOGLEDRIVEREFRESHTOKEN,
        )
        from ..models.developer_runtime_status_configuration_googledriverootfolderid import (
            DeveloperRuntimeStatusConfigurationGOOGLEDRIVEROOTFOLDERID,
        )
        from ..models.developer_runtime_status_configuration_payrollcursorhmacsecret import (
            DeveloperRuntimeStatusConfigurationPAYROLLCURSORHMACSECRET,
        )
        from ..models.developer_runtime_status_configuration_photopurgeinvokesecret import (
            DeveloperRuntimeStatusConfigurationPHOTOPURGEINVOKESECRET,
        )
        from ..models.developer_runtime_status_configuration_reservationguestnamepepper import (
            DeveloperRuntimeStatusConfigurationRESERVATIONGUESTNAMEPEPPER,
        )
        from ..models.developer_runtime_status_configuration_reservationpiikeybase64 import (
            DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYBASE64,
        )
        from ..models.developer_runtime_status_configuration_reservationpiikeyringjson import (
            DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYRINGJSON,
        )
        from ..models.developer_runtime_status_configuration_reservationpiikeyversion import (
            DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYVERSION,
        )
        from ..models.developer_runtime_status_configuration_reservationscheduleractorprofileid import (
            DeveloperRuntimeStatusConfigurationRESERVATIONSCHEDULERACTORPROFILEID,
        )
        from ..models.developer_runtime_status_configuration_schedulerinvokesecret import (
            DeveloperRuntimeStatusConfigurationSCHEDULERINVOKESECRET,
        )

        d = dict(src_dict)
        account_phone_pepper = DeveloperRuntimeStatusConfigurationACCOUNTPHONEPEPPER.from_dict(
            d.pop("ACCOUNT_PHONE_PEPPER")
        )

        reservation_pii_key_base64 = (
            DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYBASE64.from_dict(
                d.pop("RESERVATION_PII_KEY_BASE64")
            )
        )

        reservation_pii_key_version = (
            DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYVERSION.from_dict(
                d.pop("RESERVATION_PII_KEY_VERSION")
            )
        )

        reservation_pii_keyring_json = (
            DeveloperRuntimeStatusConfigurationRESERVATIONPIIKEYRINGJSON.from_dict(
                d.pop("RESERVATION_PII_KEYRING_JSON")
            )
        )

        reservation_guest_name_pepper = (
            DeveloperRuntimeStatusConfigurationRESERVATIONGUESTNAMEPEPPER.from_dict(
                d.pop("RESERVATION_GUEST_NAME_PEPPER")
            )
        )

        reservation_scheduler_actor_profile_id = (
            DeveloperRuntimeStatusConfigurationRESERVATIONSCHEDULERACTORPROFILEID.from_dict(
                d.pop("RESERVATION_SCHEDULER_ACTOR_PROFILE_ID")
            )
        )

        scheduler_invoke_secret = (
            DeveloperRuntimeStatusConfigurationSCHEDULERINVOKESECRET.from_dict(
                d.pop("SCHEDULER_INVOKE_SECRET")
            )
        )

        cors_origins = DeveloperRuntimeStatusConfigurationCORSORIGINS.from_dict(
            d.pop("CORS_ORIGINS")
        )

        google_drive_client_id = DeveloperRuntimeStatusConfigurationGOOGLEDRIVECLIENTID.from_dict(
            d.pop("GOOGLE_DRIVE_CLIENT_ID")
        )

        google_drive_client_secret = (
            DeveloperRuntimeStatusConfigurationGOOGLEDRIVECLIENTSECRET.from_dict(
                d.pop("GOOGLE_DRIVE_CLIENT_SECRET")
            )
        )

        google_drive_refresh_token = (
            DeveloperRuntimeStatusConfigurationGOOGLEDRIVEREFRESHTOKEN.from_dict(
                d.pop("GOOGLE_DRIVE_REFRESH_TOKEN")
            )
        )

        google_drive_root_folder_id = (
            DeveloperRuntimeStatusConfigurationGOOGLEDRIVEROOTFOLDERID.from_dict(
                d.pop("GOOGLE_DRIVE_ROOT_FOLDER_ID")
            )
        )

        photo_purge_invoke_secret = (
            DeveloperRuntimeStatusConfigurationPHOTOPURGEINVOKESECRET.from_dict(
                d.pop("PHOTO_PURGE_INVOKE_SECRET")
            )
        )

        payroll_cursor_hmac_secret = (
            DeveloperRuntimeStatusConfigurationPAYROLLCURSORHMACSECRET.from_dict(
                d.pop("PAYROLL_CURSOR_HMAC_SECRET")
            )
        )

        developer_runtime_status_configuration = cls(
            account_phone_pepper=account_phone_pepper,
            reservation_pii_key_base64=reservation_pii_key_base64,
            reservation_pii_key_version=reservation_pii_key_version,
            reservation_pii_keyring_json=reservation_pii_keyring_json,
            reservation_guest_name_pepper=reservation_guest_name_pepper,
            reservation_scheduler_actor_profile_id=reservation_scheduler_actor_profile_id,
            scheduler_invoke_secret=scheduler_invoke_secret,
            cors_origins=cors_origins,
            google_drive_client_id=google_drive_client_id,
            google_drive_client_secret=google_drive_client_secret,
            google_drive_refresh_token=google_drive_refresh_token,
            google_drive_root_folder_id=google_drive_root_folder_id,
            photo_purge_invoke_secret=photo_purge_invoke_secret,
            payroll_cursor_hmac_secret=payroll_cursor_hmac_secret,
        )

        return developer_runtime_status_configuration
