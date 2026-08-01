#!/bin/sh

APP_NAME="dns-analytics"
CONFIG_NAME="dns-analytics"

STATE_DIR="$(uci -q get "${CONFIG_NAME}.main.state_dir" 2>/dev/null)"
RUNTIME_DIR="$(uci -q get "${CONFIG_NAME}.main.runtime_dir" 2>/dev/null)"
DATABASE="$(uci -q get "${CONFIG_NAME}.main.database" 2>/dev/null)"

[ -n "$STATE_DIR" ] || STATE_DIR="/etc/dns-analytics/data"
[ -n "$RUNTIME_DIR" ] || RUNTIME_DIR="/tmp/dns-analytics"
[ -n "$DATABASE" ] || DATABASE="$STATE_DIR/dns-analytics.sqlite"

log_message() {
	logger -t "$APP_NAME" -- "$*"
}

uci_get() {
	uci -q get "${CONFIG_NAME}.$1.$2" 2>/dev/null
}

ensure_directory() {
	[ -d "$1" ] || mkdir -p "$1"
}

safe_integer() {
	case "$1" in
		''|*[!0-9]*)
			printf '%s\n' "${2:-0}"
			;;
		*)
			printf '%s\n' "$1"
			;;
	esac
}

sql_quote() {
	printf '%s' "$1" | sed "s/'/''/g"
}

sqlite_query() {
	sqlite3 \
		-batch \
		-noheader \
		-separator '	' \
		"$DATABASE" \
		"$1"
}

sqlite_exec() {
	sqlite3 \
		-batch \
		"$DATABASE" \
		"$1"
}

sqlite_file() {
	sqlite3 \
		-batch \
		"$DATABASE" < "$1"
}

read_secret_value() {
	file="$1"
	key="$2"

	[ -r "$file" ] || return 1

	awk -F '=' -v wanted="$key" '
		$1 == wanted {
			sub(/^[^=]*=/, "")
			print
			exit
		}
	' "$file"
}

normalize_domain() {
	printf '%s' "$1" |
		tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz' |
		sed \
			-e 's/[[:space:]]//g' \
			-e 's/\.$//'
}

normalize_metric_name() {
	printf '%s' "$1" |
		tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz' |
		sed \
			-e 's#[ /_]#-#g' \
			-e 's/[^a-z0-9-]/-/g' \
			-e 's/-\{2,\}/-/g' \
			-e 's/^-//' \
			-e 's/-$//'
}
