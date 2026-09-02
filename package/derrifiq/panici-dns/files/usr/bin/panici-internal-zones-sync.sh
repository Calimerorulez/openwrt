#!/bin/sh

set -eu

DIR="/etc/unbound/panici"
DEVICES="$DIR/devices.tsv"

STATE="/etc/panici-dns/internal-hostnames.tsv"
OUT="$DIR/internal-zones.conf"
HASHFILE="$DIR/internal-zones.conf.sha256"

INCLUDE_FILE="/etc/unbound/unbound_ext.conf"
INCLUDE_LINE='include: "/etc/unbound/panici/internal-zones.conf"'
INCLUDE_ADDED=0

CURRENT="/tmp/panici-internal-current.$$"
STATE_NEW="/tmp/panici-internal-state.$$"
OUT_NEW="/tmp/panici-internal-zones.$$"

cleanup() {
    rm -f "$CURRENT" "$STATE_NEW" "$OUT_NEW"
}
trap cleanup EXIT INT TERM

ensure_include() {
    [ -f "$INCLUDE_FILE" ] || {
        echo "ERROR: Unbound include file not found: $INCLUDE_FILE" >&2
        return 1
    }

    if grep -qxF "$INCLUDE_LINE" "$INCLUDE_FILE"; then
        return 0
    fi

    printf '%s\n' "$INCLUDE_LINE" >> "$INCLUDE_FILE"
    INCLUDE_ADDED=1

    if [ -n "${PANICI_CHANGE_MARKER:-}" ]; then
        : > "$PANICI_CHANGE_MARKER"
    fi

    echo "$(date '+%F %T') internal DNS zones include added"
}

rollback_include() {
    [ "$INCLUDE_ADDED" = "1" ] || return 0

    TMP_INCLUDE="/tmp/panici-unbound-ext.$$"

    if ! awk -v line="$INCLUDE_LINE" '
        $0 != line { print }
    ' "$INCLUDE_FILE" > "$TMP_INCLUDE"; then
        rm -f "$TMP_INCLUDE"
        echo "ERROR: could not prepare Unbound include rollback" >&2
        return 1
    fi

    if ! cat "$TMP_INCLUDE" > "$INCLUDE_FILE"; then
        rm -f "$TMP_INCLUDE"
        echo "ERROR: could not roll back Unbound include" >&2
        return 1
    fi

    rm -f "$TMP_INCLUDE"
    INCLUDE_ADDED=0
}

mkdir -p "$DIR" /etc/panici-dns

[ -f "$STATE" ] || {
    printf 'name\tlifecycle\n' > "$STATE"
}

###############################################################################
# 1. Huidig bekende interne namen verzamelen.
#
# Bronnen:
#   - canonical namen uit devices.tsv
#   - alle daadwerkelijk lokaal gepubliceerde A-records
###############################################################################

{
    if [ -f "$DEVICES" ]; then
        awk -F '\t' '
        NR == 1 {
            for (i=1; i<=NF; i++) {
                if ($i == "canonical")
                    cancol=i
                else if ($i == "lifecycle")
                    lifecol=i
            }

            if (!cancol || !lifecol)
                exit 2

            next
        }

        {
            name=tolower($cancol)
            lifecycle=tolower($lifecol)

            if (lifecycle == "retired")
                next

            if (name == "" || name == "-")
                next

            sub(/\.$/, "", name)

            if (name ~ /^[a-z0-9][a-z0-9-]*\.panici\.casa$/)
                print name
        }
        ' "$DEVICES"
    fi

    for FILE in \
        "$DIR/static.conf" \
        "$DIR/iot.conf" \
        "$DIR/lxc.conf" \
        "$DIR/dhcp.conf" \
        "$DIR/managed.conf"
    do
        [ -f "$FILE" ] || continue

        awk '
        $1 == "local-data:" && $3 == "A" {
            name=tolower($2)

            sub(/^"/, "", name)
            sub(/\.$/, "", name)

            if (name ~ /^[a-z0-9][a-z0-9-]*\.panici\.casa$/)
                print name
        }
        ' "$FILE"
    done
} | sort -u > "$CURRENT"

###############################################################################
# 2. Persistente registry bijwerken.
#
# Bestaande namen verdwijnen nooit automatisch.
# lifecycle=retired blijft expliciet gerespecteerd.
###############################################################################

awk -F '\t' -v CURRENT="$CURRENT" '
BEGIN {
    OFS="\t"

    while ((getline name < CURRENT) > 0) {
        if (name != "")
            current[tolower(name)]=1
    }
    close(CURRENT)
}

NR == 1 {
    next
}

NF >= 1 {
    name=tolower($1)
    lifecycle=(NF >= 2 ? tolower($2) : "active")

    if (name == "")
        next

    if (lifecycle != "active" && lifecycle != "retired")
        lifecycle="active"

    known[name]=1
    state[name]=lifecycle
}

END {
    for (name in current) {
        if (!(name in known))
            state[name]="active"
    }

    print "name", "lifecycle"

    for (name in state)
        print name, state[name]
}
' "$STATE" | {
    IFS= read -r HEADER
    printf '%s\n' "$HEADER"
    sort
} > "$STATE_NEW"

###############################################################################
# 3. Exact-name static zones genereren.
###############################################################################

{
    echo "server:"
    echo

    awk -F '\t' '
    NR == 1 {
        next
    }

    tolower($2) == "active" {
        name=tolower($1)

        if (name ~ /^[a-z0-9][a-z0-9-]*\.panici\.casa$/)
            printf "    local-zone: \"%s.\" static\n", name
    }
    ' "$STATE_NEW"
} > "$OUT_NEW"

if command -v unbound-checkconf >/dev/null 2>&1; then
    if ! unbound-checkconf "$OUT_NEW" >/dev/null 2>&1; then
        echo "ERROR: generated internal-zones.conf is invalid" >&2
        cat "$OUT_NEW" >&2
        exit 1
    fi
fi

STATE_CHANGED=0
OUT_CHANGED=0

if ! cmp -s "$STATE_NEW" "$STATE"; then
    STATE_CHANGED=1
fi

NEW_HASH="$(sha256sum "$OUT_NEW" | awk '{print $1}')"
OLD_HASH=""

[ -f "$HASHFILE" ] && OLD_HASH="$(cat "$HASHFILE" 2>/dev/null || true)"

if [ "$NEW_HASH" != "$OLD_HASH" ] || [ ! -f "$OUT" ]; then
    OUT_CHANGED=1
fi

# Backups maken vóór persistente wijzigingen.
STATE_EXISTED=0
OUT_EXISTED=0
HASH_EXISTED=0

if [ -f "$STATE" ]; then
    cp "$STATE" "$STATE.bak"
    STATE_EXISTED=1
fi

if [ -f "$OUT" ]; then
    cp "$OUT" "$OUT.bak"
    OUT_EXISTED=1
fi

if [ -f "$HASHFILE" ]; then
    cp "$HASHFILE" "$HASHFILE.bak"
    HASH_EXISTED=1
fi

if [ "$STATE_CHANGED" -eq 1 ]; then
    cp "$STATE_NEW" "$STATE"
fi

if [ "$OUT_CHANGED" -eq 1 ]; then
    cp "$OUT_NEW" "$OUT"
    printf '%s\n' "$NEW_HASH" > "$HASHFILE"
fi

if ! ensure_include; then
    if [ "$STATE_EXISTED" -eq 1 ]; then
        mv "$STATE.bak" "$STATE"
    else
        rm -f "$STATE"
    fi

    if [ "$OUT_EXISTED" -eq 1 ]; then
        mv "$OUT.bak" "$OUT"
    else
        rm -f "$OUT"
    fi

    if [ "$HASH_EXISTED" -eq 1 ]; then
        mv "$HASHFILE.bak" "$HASHFILE"
    else
        rm -f "$HASHFILE"
    fi

    exit 1
fi

if ! unbound-checkconf >/dev/null 2>&1; then
    echo "$(date '+%F %T') ERROR: full Unbound configuration is invalid"

    rollback_include || true

    if [ "$STATE_EXISTED" -eq 1 ]; then
        mv "$STATE.bak" "$STATE"
    else
        rm -f "$STATE"
    fi

    if [ "$OUT_EXISTED" -eq 1 ]; then
        mv "$OUT.bak" "$OUT"
    else
        rm -f "$OUT"
    fi

    if [ "$HASH_EXISTED" -eq 1 ]; then
        mv "$HASHFILE.bak" "$HASHFILE"
    else
        rm -f "$HASHFILE"
    fi

    exit 1
fi

rm -f "$STATE.bak" "$OUT.bak" "$HASHFILE.bak"

if [ "$OUT_CHANGED" -eq 1 ]; then
    if [ -n "${PANICI_CHANGE_MARKER:-}" ]; then
        : > "$PANICI_CHANGE_MARKER"
    fi

    echo "$(date '+%F %T') internal DNS zones updated: $OUT"
elif [ "$STATE_CHANGED" -eq 1 ]; then
    echo "$(date '+%F %T') internal hostname registry updated"
else
    echo "$(date '+%F %T') internal DNS zones no changes"
fi
