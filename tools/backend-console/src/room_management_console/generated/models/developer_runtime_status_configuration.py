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
    from ..models.developer_runtime_status_configuration_googlesheetsroompintab import (
        DeveloperRuntimeStatusConfigurationGOOGLESHEETSROOMPINTAB,
    )
    from ..models.developer_runtime_status_configuration_googlesheetsserviceaccountemail import (
        DeveloperRuntimeStatusConfigurationGOOGLESHEETSSERVICEACCOUNTEMAIL,
    )
    from ..models.developer_runtime_status_configuration_googlesheetsserviceaccountprivatekey import (
        DeveloperRuntimeStatusConfigurationGOOGLESHEETSSERVICEACCOUNTPRIVATEKEY,
    )
    from ..models.developer_runtime_status_configuration_googlesheetsspreadsheetid import (
        DeveloperRuntimeStatusConfigurationGOOGLESHEETSSPREADSHEETID,
    )
    from ..models.developer_runtime_status_configuration_notificationcursorhmacsecret import (
        DeveloperRuntimeStatusConfigurationNOTIFICATIONCURSORHMACSECRET,
    )
    from ..models.developer_runtime_status_configuration_notificationdeliveryinvokesecret import (
        DeveloperRuntimeStatusConfigurationNOTIFICATIONDELIVERYINVOKESECRET,
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
    from ..models.developer_runtime_status_configuration_roompinkeybase64 import (
        DeveloperRuntimeStatusConfigurationROOMPINKEYBASE64,
    )
    from ..models.developer_runtime_status_configuration_roompinkeyringjson import (
        DeveloperRuntimeStatusConfigurationROOMPINKEYRINGJSON,
    )
    from ..models.developer_runtime_status_configuration_roompinkeyversion import (
        DeveloperRuntimeStatusConfigurationROOMPINKEYVERSION,
    )
    from ..models.developer_runtime_status_configuration_roompinsheetsyncinvokesecret import (
        DeveloperRuntimeStatusConfigurationROOMPINSHEETSYNCINVOKESECRET,
    )
    from ..models.developer_runtime_status_configuration_schedulerinvokesecret import (
        DeveloperRuntimeStatusConfigurationSCHEDULERINVOKESECRET,
    )
    from ..models.developer_runtime_status_configuration_vapidcurrentkeyversion import (
        DeveloperRuntimeStatusConfigurationVAPIDCURRENTKEYVERSION,
    )
    from ..models.developer_runtime_status_configuration_vapidkeyringjson import (
        DeveloperRuntimeStatusConfigurationVAPIDKEYRINGJSON,
    )
    from ..models.developer_runtime_status_configuration_vapidprivatekey import (
        DeveloperRuntimeStatusConfigurationVAPIDPRIVATEKEY,
    )
    from ..models.developer_runtime_status_configuration_vapidpublickey import (
        DeveloperRuntimeStatusConfigurationVAPIDPUBLICKEY,
    )
    from ..models.developer_runtime_status_configuration_vapidpublickeyringjson import (
        DeveloperRuntimeStatusConfigurationVAPIDPUBLICKEYRINGJSON,
    )
    from ..models.developer_runtime_status_configuration_vapidsubject import (
        DeveloperRuntimeStatusConfigurationVAPIDSUBJECT,
    )
    from ..models.developer_runtime_status_configuration_webpushbindingdigestsecret import (
        DeveloperRuntimeStatusConfigurationWEBPUSHBINDINGDIGESTSECRET,
    )
    from ..models.developer_runtime_status_configuration_webpushsubscriptionkeybase64 import (
        DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYBASE64,
    )
    from ..models.developer_runtime_status_configuration_webpushsubscriptionkeyringjson import (
        DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYRINGJSON,
    )
    from ..models.developer_runtime_status_configuration_webpushsubscriptionkeyversion import (
        DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYVERSION,
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
        notification_cursor_hmac_secret (DeveloperRuntimeStatusConfigurationNOTIFICATIONCURSORHMACSECRET):
        web_push_subscription_key_base64 (DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYBASE64):
        web_push_subscription_key_version (DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYVERSION):
        web_push_subscription_keyring_json (DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYRINGJSON):
        web_push_binding_digest_secret (DeveloperRuntimeStatusConfigurationWEBPUSHBINDINGDIGESTSECRET):
        vapid_subject (DeveloperRuntimeStatusConfigurationVAPIDSUBJECT):
        vapid_current_key_version (DeveloperRuntimeStatusConfigurationVAPIDCURRENTKEYVERSION):
        vapid_public_key (DeveloperRuntimeStatusConfigurationVAPIDPUBLICKEY):
        vapid_public_keyring_json (DeveloperRuntimeStatusConfigurationVAPIDPUBLICKEYRINGJSON):
        vapid_private_key (DeveloperRuntimeStatusConfigurationVAPIDPRIVATEKEY):
        vapid_keyring_json (DeveloperRuntimeStatusConfigurationVAPIDKEYRINGJSON):
        notification_delivery_invoke_secret (DeveloperRuntimeStatusConfigurationNOTIFICATIONDELIVERYINVOKESECRET):
        room_pin_key_base64 (DeveloperRuntimeStatusConfigurationROOMPINKEYBASE64):
        room_pin_key_version (DeveloperRuntimeStatusConfigurationROOMPINKEYVERSION):
        room_pin_keyring_json (DeveloperRuntimeStatusConfigurationROOMPINKEYRINGJSON):
        room_pin_sheet_sync_invoke_secret (DeveloperRuntimeStatusConfigurationROOMPINSHEETSYNCINVOKESECRET):
        google_sheets_service_account_email (DeveloperRuntimeStatusConfigurationGOOGLESHEETSSERVICEACCOUNTEMAIL):
        google_sheets_service_account_private_key
            (DeveloperRuntimeStatusConfigurationGOOGLESHEETSSERVICEACCOUNTPRIVATEKEY):
        google_sheets_spreadsheet_id (DeveloperRuntimeStatusConfigurationGOOGLESHEETSSPREADSHEETID):
        google_sheets_room_pin_tab (DeveloperRuntimeStatusConfigurationGOOGLESHEETSROOMPINTAB):
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
    notification_cursor_hmac_secret: DeveloperRuntimeStatusConfigurationNOTIFICATIONCURSORHMACSECRET
    web_push_subscription_key_base64: (
        DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYBASE64
    )
    web_push_subscription_key_version: (
        DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYVERSION
    )
    web_push_subscription_keyring_json: (
        DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYRINGJSON
    )
    web_push_binding_digest_secret: DeveloperRuntimeStatusConfigurationWEBPUSHBINDINGDIGESTSECRET
    vapid_subject: DeveloperRuntimeStatusConfigurationVAPIDSUBJECT
    vapid_current_key_version: DeveloperRuntimeStatusConfigurationVAPIDCURRENTKEYVERSION
    vapid_public_key: DeveloperRuntimeStatusConfigurationVAPIDPUBLICKEY
    vapid_public_keyring_json: DeveloperRuntimeStatusConfigurationVAPIDPUBLICKEYRINGJSON
    vapid_private_key: DeveloperRuntimeStatusConfigurationVAPIDPRIVATEKEY
    vapid_keyring_json: DeveloperRuntimeStatusConfigurationVAPIDKEYRINGJSON
    notification_delivery_invoke_secret: (
        DeveloperRuntimeStatusConfigurationNOTIFICATIONDELIVERYINVOKESECRET
    )
    room_pin_key_base64: DeveloperRuntimeStatusConfigurationROOMPINKEYBASE64
    room_pin_key_version: DeveloperRuntimeStatusConfigurationROOMPINKEYVERSION
    room_pin_keyring_json: DeveloperRuntimeStatusConfigurationROOMPINKEYRINGJSON
    room_pin_sheet_sync_invoke_secret: (
        DeveloperRuntimeStatusConfigurationROOMPINSHEETSYNCINVOKESECRET
    )
    google_sheets_service_account_email: (
        DeveloperRuntimeStatusConfigurationGOOGLESHEETSSERVICEACCOUNTEMAIL
    )
    google_sheets_service_account_private_key: (
        DeveloperRuntimeStatusConfigurationGOOGLESHEETSSERVICEACCOUNTPRIVATEKEY
    )
    google_sheets_spreadsheet_id: DeveloperRuntimeStatusConfigurationGOOGLESHEETSSPREADSHEETID
    google_sheets_room_pin_tab: DeveloperRuntimeStatusConfigurationGOOGLESHEETSROOMPINTAB

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

        notification_cursor_hmac_secret = self.notification_cursor_hmac_secret.to_dict()

        web_push_subscription_key_base64 = self.web_push_subscription_key_base64.to_dict()

        web_push_subscription_key_version = self.web_push_subscription_key_version.to_dict()

        web_push_subscription_keyring_json = self.web_push_subscription_keyring_json.to_dict()

        web_push_binding_digest_secret = self.web_push_binding_digest_secret.to_dict()

        vapid_subject = self.vapid_subject.to_dict()

        vapid_current_key_version = self.vapid_current_key_version.to_dict()

        vapid_public_key = self.vapid_public_key.to_dict()

        vapid_public_keyring_json = self.vapid_public_keyring_json.to_dict()

        vapid_private_key = self.vapid_private_key.to_dict()

        vapid_keyring_json = self.vapid_keyring_json.to_dict()

        notification_delivery_invoke_secret = self.notification_delivery_invoke_secret.to_dict()

        room_pin_key_base64 = self.room_pin_key_base64.to_dict()

        room_pin_key_version = self.room_pin_key_version.to_dict()

        room_pin_keyring_json = self.room_pin_keyring_json.to_dict()

        room_pin_sheet_sync_invoke_secret = self.room_pin_sheet_sync_invoke_secret.to_dict()

        google_sheets_service_account_email = self.google_sheets_service_account_email.to_dict()

        google_sheets_service_account_private_key = (
            self.google_sheets_service_account_private_key.to_dict()
        )

        google_sheets_spreadsheet_id = self.google_sheets_spreadsheet_id.to_dict()

        google_sheets_room_pin_tab = self.google_sheets_room_pin_tab.to_dict()

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
                "NOTIFICATION_CURSOR_HMAC_SECRET": notification_cursor_hmac_secret,
                "WEB_PUSH_SUBSCRIPTION_KEY_BASE64": web_push_subscription_key_base64,
                "WEB_PUSH_SUBSCRIPTION_KEY_VERSION": web_push_subscription_key_version,
                "WEB_PUSH_SUBSCRIPTION_KEYRING_JSON": web_push_subscription_keyring_json,
                "WEB_PUSH_BINDING_DIGEST_SECRET": web_push_binding_digest_secret,
                "VAPID_SUBJECT": vapid_subject,
                "VAPID_CURRENT_KEY_VERSION": vapid_current_key_version,
                "VAPID_PUBLIC_KEY": vapid_public_key,
                "VAPID_PUBLIC_KEYRING_JSON": vapid_public_keyring_json,
                "VAPID_PRIVATE_KEY": vapid_private_key,
                "VAPID_KEYRING_JSON": vapid_keyring_json,
                "NOTIFICATION_DELIVERY_INVOKE_SECRET": notification_delivery_invoke_secret,
                "ROOM_PIN_KEY_BASE64": room_pin_key_base64,
                "ROOM_PIN_KEY_VERSION": room_pin_key_version,
                "ROOM_PIN_KEYRING_JSON": room_pin_keyring_json,
                "ROOM_PIN_SHEET_SYNC_INVOKE_SECRET": room_pin_sheet_sync_invoke_secret,
                "GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL": google_sheets_service_account_email,
                "GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY": google_sheets_service_account_private_key,
                "GOOGLE_SHEETS_SPREADSHEET_ID": google_sheets_spreadsheet_id,
                "GOOGLE_SHEETS_ROOM_PIN_TAB": google_sheets_room_pin_tab,
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
        from ..models.developer_runtime_status_configuration_googlesheetsroompintab import (
            DeveloperRuntimeStatusConfigurationGOOGLESHEETSROOMPINTAB,
        )
        from ..models.developer_runtime_status_configuration_googlesheetsserviceaccountemail import (
            DeveloperRuntimeStatusConfigurationGOOGLESHEETSSERVICEACCOUNTEMAIL,
        )
        from ..models.developer_runtime_status_configuration_googlesheetsserviceaccountprivatekey import (
            DeveloperRuntimeStatusConfigurationGOOGLESHEETSSERVICEACCOUNTPRIVATEKEY,
        )
        from ..models.developer_runtime_status_configuration_googlesheetsspreadsheetid import (
            DeveloperRuntimeStatusConfigurationGOOGLESHEETSSPREADSHEETID,
        )
        from ..models.developer_runtime_status_configuration_notificationcursorhmacsecret import (
            DeveloperRuntimeStatusConfigurationNOTIFICATIONCURSORHMACSECRET,
        )
        from ..models.developer_runtime_status_configuration_notificationdeliveryinvokesecret import (
            DeveloperRuntimeStatusConfigurationNOTIFICATIONDELIVERYINVOKESECRET,
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
        from ..models.developer_runtime_status_configuration_roompinkeybase64 import (
            DeveloperRuntimeStatusConfigurationROOMPINKEYBASE64,
        )
        from ..models.developer_runtime_status_configuration_roompinkeyringjson import (
            DeveloperRuntimeStatusConfigurationROOMPINKEYRINGJSON,
        )
        from ..models.developer_runtime_status_configuration_roompinkeyversion import (
            DeveloperRuntimeStatusConfigurationROOMPINKEYVERSION,
        )
        from ..models.developer_runtime_status_configuration_roompinsheetsyncinvokesecret import (
            DeveloperRuntimeStatusConfigurationROOMPINSHEETSYNCINVOKESECRET,
        )
        from ..models.developer_runtime_status_configuration_schedulerinvokesecret import (
            DeveloperRuntimeStatusConfigurationSCHEDULERINVOKESECRET,
        )
        from ..models.developer_runtime_status_configuration_vapidcurrentkeyversion import (
            DeveloperRuntimeStatusConfigurationVAPIDCURRENTKEYVERSION,
        )
        from ..models.developer_runtime_status_configuration_vapidkeyringjson import (
            DeveloperRuntimeStatusConfigurationVAPIDKEYRINGJSON,
        )
        from ..models.developer_runtime_status_configuration_vapidprivatekey import (
            DeveloperRuntimeStatusConfigurationVAPIDPRIVATEKEY,
        )
        from ..models.developer_runtime_status_configuration_vapidpublickey import (
            DeveloperRuntimeStatusConfigurationVAPIDPUBLICKEY,
        )
        from ..models.developer_runtime_status_configuration_vapidpublickeyringjson import (
            DeveloperRuntimeStatusConfigurationVAPIDPUBLICKEYRINGJSON,
        )
        from ..models.developer_runtime_status_configuration_vapidsubject import (
            DeveloperRuntimeStatusConfigurationVAPIDSUBJECT,
        )
        from ..models.developer_runtime_status_configuration_webpushbindingdigestsecret import (
            DeveloperRuntimeStatusConfigurationWEBPUSHBINDINGDIGESTSECRET,
        )
        from ..models.developer_runtime_status_configuration_webpushsubscriptionkeybase64 import (
            DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYBASE64,
        )
        from ..models.developer_runtime_status_configuration_webpushsubscriptionkeyringjson import (
            DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYRINGJSON,
        )
        from ..models.developer_runtime_status_configuration_webpushsubscriptionkeyversion import (
            DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYVERSION,
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

        notification_cursor_hmac_secret = (
            DeveloperRuntimeStatusConfigurationNOTIFICATIONCURSORHMACSECRET.from_dict(
                d.pop("NOTIFICATION_CURSOR_HMAC_SECRET")
            )
        )

        web_push_subscription_key_base64 = (
            DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYBASE64.from_dict(
                d.pop("WEB_PUSH_SUBSCRIPTION_KEY_BASE64")
            )
        )

        web_push_subscription_key_version = (
            DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYVERSION.from_dict(
                d.pop("WEB_PUSH_SUBSCRIPTION_KEY_VERSION")
            )
        )

        web_push_subscription_keyring_json = (
            DeveloperRuntimeStatusConfigurationWEBPUSHSUBSCRIPTIONKEYRINGJSON.from_dict(
                d.pop("WEB_PUSH_SUBSCRIPTION_KEYRING_JSON")
            )
        )

        web_push_binding_digest_secret = (
            DeveloperRuntimeStatusConfigurationWEBPUSHBINDINGDIGESTSECRET.from_dict(
                d.pop("WEB_PUSH_BINDING_DIGEST_SECRET")
            )
        )

        vapid_subject = DeveloperRuntimeStatusConfigurationVAPIDSUBJECT.from_dict(
            d.pop("VAPID_SUBJECT")
        )

        vapid_current_key_version = (
            DeveloperRuntimeStatusConfigurationVAPIDCURRENTKEYVERSION.from_dict(
                d.pop("VAPID_CURRENT_KEY_VERSION")
            )
        )

        vapid_public_key = DeveloperRuntimeStatusConfigurationVAPIDPUBLICKEY.from_dict(
            d.pop("VAPID_PUBLIC_KEY")
        )

        vapid_public_keyring_json = (
            DeveloperRuntimeStatusConfigurationVAPIDPUBLICKEYRINGJSON.from_dict(
                d.pop("VAPID_PUBLIC_KEYRING_JSON")
            )
        )

        vapid_private_key = DeveloperRuntimeStatusConfigurationVAPIDPRIVATEKEY.from_dict(
            d.pop("VAPID_PRIVATE_KEY")
        )

        vapid_keyring_json = DeveloperRuntimeStatusConfigurationVAPIDKEYRINGJSON.from_dict(
            d.pop("VAPID_KEYRING_JSON")
        )

        notification_delivery_invoke_secret = (
            DeveloperRuntimeStatusConfigurationNOTIFICATIONDELIVERYINVOKESECRET.from_dict(
                d.pop("NOTIFICATION_DELIVERY_INVOKE_SECRET")
            )
        )

        room_pin_key_base64 = DeveloperRuntimeStatusConfigurationROOMPINKEYBASE64.from_dict(
            d.pop("ROOM_PIN_KEY_BASE64")
        )

        room_pin_key_version = DeveloperRuntimeStatusConfigurationROOMPINKEYVERSION.from_dict(
            d.pop("ROOM_PIN_KEY_VERSION")
        )

        room_pin_keyring_json = DeveloperRuntimeStatusConfigurationROOMPINKEYRINGJSON.from_dict(
            d.pop("ROOM_PIN_KEYRING_JSON")
        )

        room_pin_sheet_sync_invoke_secret = (
            DeveloperRuntimeStatusConfigurationROOMPINSHEETSYNCINVOKESECRET.from_dict(
                d.pop("ROOM_PIN_SHEET_SYNC_INVOKE_SECRET")
            )
        )

        google_sheets_service_account_email = (
            DeveloperRuntimeStatusConfigurationGOOGLESHEETSSERVICEACCOUNTEMAIL.from_dict(
                d.pop("GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL")
            )
        )

        google_sheets_service_account_private_key = (
            DeveloperRuntimeStatusConfigurationGOOGLESHEETSSERVICEACCOUNTPRIVATEKEY.from_dict(
                d.pop("GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY")
            )
        )

        google_sheets_spreadsheet_id = (
            DeveloperRuntimeStatusConfigurationGOOGLESHEETSSPREADSHEETID.from_dict(
                d.pop("GOOGLE_SHEETS_SPREADSHEET_ID")
            )
        )

        google_sheets_room_pin_tab = (
            DeveloperRuntimeStatusConfigurationGOOGLESHEETSROOMPINTAB.from_dict(
                d.pop("GOOGLE_SHEETS_ROOM_PIN_TAB")
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
            notification_cursor_hmac_secret=notification_cursor_hmac_secret,
            web_push_subscription_key_base64=web_push_subscription_key_base64,
            web_push_subscription_key_version=web_push_subscription_key_version,
            web_push_subscription_keyring_json=web_push_subscription_keyring_json,
            web_push_binding_digest_secret=web_push_binding_digest_secret,
            vapid_subject=vapid_subject,
            vapid_current_key_version=vapid_current_key_version,
            vapid_public_key=vapid_public_key,
            vapid_public_keyring_json=vapid_public_keyring_json,
            vapid_private_key=vapid_private_key,
            vapid_keyring_json=vapid_keyring_json,
            notification_delivery_invoke_secret=notification_delivery_invoke_secret,
            room_pin_key_base64=room_pin_key_base64,
            room_pin_key_version=room_pin_key_version,
            room_pin_keyring_json=room_pin_keyring_json,
            room_pin_sheet_sync_invoke_secret=room_pin_sheet_sync_invoke_secret,
            google_sheets_service_account_email=google_sheets_service_account_email,
            google_sheets_service_account_private_key=google_sheets_service_account_private_key,
            google_sheets_spreadsheet_id=google_sheets_spreadsheet_id,
            google_sheets_room_pin_tab=google_sheets_room_pin_tab,
        )

        return developer_runtime_status_configuration
