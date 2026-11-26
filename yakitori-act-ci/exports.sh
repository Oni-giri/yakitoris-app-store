export APP_YAKITORI_ACT_CI_MASTER_KEY="$(derive_entropy "${app_entropy_identifier}-master-key")"
export APP_YAKITORI_ACT_CI_CSRF_SECRET="$(derive_entropy "${app_entropy_identifier}-csrf-secret")"
