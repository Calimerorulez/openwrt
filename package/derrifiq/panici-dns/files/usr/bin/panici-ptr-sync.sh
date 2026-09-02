#!/bin/sh

set -eu

DIR="/etc/unbound/panici"
DEVICES="$DIR/devices.tsv"
OUT="$DIR/ptr-static.conf"

INCLUDE_FILE="/etc/unbound/unbound_ext.conf"
INCLUDE_LINE='include: "/etc/unbound/panici/ptr-static.conf"'
INCLUDE_ADDED=0

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

    echo "$(date '+%F %T') Unbound include added: ptr-static.conf"
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

HASHFILE="$DIR/ptr-static.conf.sha256"
TMP="/tmp/ptr-static.conf.new"

SEEN="/tmp/panici-ptr-seen.$$"
FORWARD="/tmp/panici-forward.$$"
CANONICAL="/tmp/panici-canonical.$$"

cleanup() {
    rm -f "$TMP" "$SEEN" "$FORWARD" "$CANONICAL"
}
trap cleanup EXIT INT TERM

: > "$SEEN"
: > "$FORWARD"
: > "$CANONICAL"

{
    echo "server:"
    echo
} > "$TMP"

###############################################################################
# PTR's die al door andere generators geleverd worden
###############################################################################

for FILE in "$DIR/lxc.conf" "$DIR/dhcp.conf"; do
    [ -f "$FILE" ] || continue

    awk '
    $1 == "local-data-ptr:" {
        ip=$2
        sub(/^"/, "", ip)

        if (ip ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)
            print ip
    }
    ' "$FILE"
done | sort -u > "$SEEN"

###############################################################################
# Bestaande A-records inventariseren
###############################################################################

for FILE in \
    "$DIR/static.conf" \
    "$DIR/iot.conf" \
    "$DIR/lxc.conf" \
    "$DIR/dhcp.conf"
do
    [ -f "$FILE" ] || continue

    awk '
    $1 == "local-data:" && $3 == "A" {
        name=$2
        ip=$4

        sub(/^"/, "", name)
        sub(/"$/, "", ip)

        if (ip ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)
            print tolower(name) "\t" ip
    }
    ' "$FILE"
done > "$FORWARD"

###############################################################################
# Canonical IP/naam uit devices.tsv
#
# Kolommen worden op HEADERNAAM gevonden, dus niet op vast kolomnummer.
###############################################################################

if [ -f "$DEVICES" ]; then
    awk -F '\t' '
    BEGIN {
        OFS="\t"
    }

    NR == 1 {
        for (i=1; i<=NF; i++) {
            if ($i == "ip")
                ipcol=i
            else if ($i == "canonical")
                cancol=i
        }

        next
    }

    {
        if (!ipcol || !cancol)
            next

        ip=$ipcol
        name=$cancol

        if (ip !~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)
            next

        if (name == "" || name == "-")
            next

        # Canonical registry entries moeten onder panici.casa vallen.
        if (tolower(name) !~ /\.panici\.casa\.?$/)
            next

        if (name !~ /\.$/)
            name=name "."

        print ip, name
    }
    ' "$DEVICES" > "$CANONICAL"
fi

###############################################################################
# Canonical overrides/registry verwerken
###############################################################################

while IFS="$(printf '\t')" read -r IP NAME; do
    [ -n "$IP" ] || continue
    [ -n "$NAME" ] || continue

    LOWER_NAME=$(printf '%s' "$NAME" | tr 'A-Z' 'a-z')

    #
    # Bestaat de canonical forwardnaam nog niet voor dit IP,
    # maak dan altijd de A-alias.
    #
    # Een bestaande PTR van een andere generator mag een extra
    # geldige forward-alias niet blokkeren.
    #
    if ! awk -F '\t' -v n="$LOWER_NAME" -v ip="$IP" '
        $1 == n && $2 == ip {
            found=1
        }
        END {
            exit !found
        }
    ' "$FORWARD"
    then
        echo "    local-data: \"$NAME A $IP\"" >> "$TMP"
    fi

    #
    # PTR alleen publiceren wanneer nog geen andere generator
    # deze IP/PTR beheert.
    #
    if ! grep -qxF "$IP" "$SEEN"; then
        echo "    local-data-ptr: \"$IP $NAME\"" >> "$TMP"
        echo "$IP" >> "$SEEN"
    fi

done < "$CANONICAL"

###############################################################################
# Fallback voor static.conf / iot.conf
###############################################################################

for FILE in "$DIR/static.conf" "$DIR/iot.conf"; do
    [ -f "$FILE" ] || continue

    awk '
    $1 == "local-data:" && $3 == "A" {
        name=$2
        ip=$4

        sub(/^"/, "", name)
        sub(/"$/, "", ip)

        if (ip ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)
            print ip "\t" name
    }
    ' "$FILE" |
    while IFS="$(printf '\t')" read -r IP NAME; do

        if grep -qxF "$IP" "$SEEN"; then
            continue
        fi

        echo "    local-data-ptr: \"$IP $NAME\"" >> "$TMP"
        echo "$IP" >> "$SEEN"

    done
done

###############################################################################
# Valideren
###############################################################################

if ! unbound-checkconf "$TMP" >/dev/null 2>&1; then
    echo "$(date '+%F %T') ERROR: generated PTR config is invalid"
    cat "$TMP"
    exit 1
fi

NEW_HASH=$(sha256sum "$TMP" | awk '{print $1}')
OLD_HASH=""

[ -f "$HASHFILE" ] && OLD_HASH=$(cat "$HASHFILE")

if [ "$NEW_HASH" = "$OLD_HASH" ] && [ -f "$OUT" ]; then
    if ! ensure_include; then
        exit 1
    fi

    if ! unbound-checkconf >/dev/null 2>&1; then
        rollback_include || true
        echo "$(date '+%F %T') ERROR: invalid Unbound config after include repair"
        exit 1
    fi

    echo "$(date '+%F %T') no DNS changes"
    exit 0
fi

cp "$OUT" "$OUT.bak" 2>/dev/null || true
cp "$TMP" "$OUT"

if ! ensure_include; then
    if [ -f "$OUT.bak" ]; then
        mv "$OUT.bak" "$OUT"
    else
        rm -f "$OUT"
    fi
    exit 1
fi

if ! unbound-checkconf >/dev/null 2>&1; then
    echo "$(date '+%F %T') ERROR: full Unbound configuration is invalid"

    rollback_include || true

    if [ -f "$OUT.bak" ]; then
        mv "$OUT.bak" "$OUT"
    else
        rm -f "$OUT"
    fi

    exit 1
fi

rm -f "$OUT.bak"
echo "$NEW_HASH" > "$HASHFILE"

if [ "${PANICI_BATCH:-0}" = "1" ]; then
    touch "${PANICI_CHANGE_MARKER:-/tmp/panici-dns-sync.changed}"
    echo "$(date '+%F %T') PTR changes staged"
else
    /etc/init.d/unbound reload
    echo "$(date '+%F %T') PTR config updated and unbound reloaded"
fi

echo "$(date '+%F %T') PTR config generated"
