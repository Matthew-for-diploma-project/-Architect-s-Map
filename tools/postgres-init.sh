#!/bin/sh
set -eu

# Run by the official image on an empty volume only. No passwords in argv/logs.
psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_user APP_DB_USER
\getenv app_password APP_DB_PASSWORD
\getenv app_database APP_DB_NAME
CREATE ROLE :"app_user" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE DATABASE :"app_database" OWNER :"app_user";
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
SQL
