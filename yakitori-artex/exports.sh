export APP_ARTEX_DB_PASSWORD="$(derive_entropy "${app_entropy_identifier}-postgres-password")"
export APP_ARTEX_SECRET_KEY="$(derive_entropy "${app_entropy_identifier}-secret-key")"
