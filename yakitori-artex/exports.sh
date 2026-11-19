# ARTEX wants deliberate secrets, and it validates them:
# - the Postgres password is used verbatim in the DSN,
# - ARTEX_SECRET_KEY must decode to exactly 32 bytes, so the 64 hex characters
#   derive_entropy returns are exactly right.
export APP_ARTEX_DB_PASSWORD="$(derive_entropy "${app_entropy_identifier}-postgres-password")"
export APP_ARTEX_SECRET_KEY="$(derive_entropy "${app_entropy_identifier}-secret-key")"

# Umbrel's proxy reaches apps from the app network's gateway. ARTEX refuses to
# start on a malformed ARTEX_TRUSTED_PROXIES, so never let this expand to "/16".
export APP_YAKITORI_ARTEX_TRUSTED_PROXIES="${NETWORK_IP:-10.21.0.0}/16"
