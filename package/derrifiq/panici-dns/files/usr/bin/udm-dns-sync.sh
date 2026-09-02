#!/bin/sh

set -eu

UDM="10.0.1.1"
KEY="/root/.ssh/id_ed25519"

REMOTE_DNS="/run/dnsmasq.dns.conf.d/hosts.d/leases"
REMOTE_LEASES="/run/dnsmasq.lease"

DIR="/etc/unbound/panici"
OUT="$DIR/dhcp.conf"

INCLUDE_FILE="/etc/unbound/unbound_ext.conf"
INCLUDE_LINE='include: "/etc/unbound/panici/dhcp.conf"'
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

    echo "$(date '+%F %T') Unbound include added: dhcp.conf"
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

HASHFILE="$DIR/dhcp.conf.sha256"
OVERRIDES="$DIR/device-overrides.tsv"

TMP="/tmp/dhcp.conf.new"
DNS_TMP="/tmp/udm-dns.$$"
LEASE_TMP="/tmp/udm-leases.$$"
LEASE_NORM="/tmp/udm-leases-norm.$$"
FIXED_TMP="/tmp/panici-fixed.$$"
OVERRIDE_TMP="/tmp/panici-mac-overrides.$$"

cleanup() {
    rm -f \
        "$TMP" \
        "$DNS_TMP" \
        "$LEASE_TMP" \
        "$LEASE_NORM" \
        "$FIXED_TMP" \
        "$OVERRIDE_TMP"
}
trap cleanup EXIT INT TERM

mkdir -p "$DIR"

#
# 1. UDM-data volledig ophalen.
#    Bij SSH-fout blijft de bestaande dhcp.conf onaangeroerd.
#
if ! ssh -i "$KEY" -o BatchMode=yes root@"$UDM" \
    "cat '$REMOTE_DNS'" > "$DNS_TMP"; then
    echo "$(date '+%F %T') ERROR: could not fetch UDM DNS host data"
    exit 1
fi

if ! ssh -i "$KEY" -o BatchMode=yes root@"$UDM" \
    "cat '$REMOTE_LEASES'" > "$LEASE_TMP"; then
    echo "$(date '+%F %T') ERROR: could not fetch UDM DHCP leases"
    exit 1
fi

if [ ! -s "$LEASE_TMP" ]; then
    echo "$(date '+%F %T') ERROR: UDM DHCP lease file is empty"
    exit 1
fi

#
# 2. Actieve DHCP-leases normaliseren:
#
#    MAC <tab> IP <tab> DHCP-hostname
#
awk '
NF >= 4 {
    mac=tolower($2)
    ip=$3
    host=$4

    if (mac ~ /^[0-9a-f][0-9a-f]:/ &&
        ip ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {
        print mac "\t" ip "\t" host
    }
}
' "$LEASE_TMP" > "$LEASE_NORM"

if [ ! -s "$LEASE_NORM" ]; then
    echo "$(date '+%F %T') ERROR: no usable DHCP leases parsed"
    exit 1
fi

#
# 3. IP-adressen verzamelen die al door onze vaste bronnen
#    worden beheerd. Deze hebben altijd hogere prioriteit.
#
for FILE in \
    "$DIR/static.conf" \
    "$DIR/iot.conf" \
    "$DIR/lxc.conf"
do
    [ -f "$FILE" ] || continue

    awk '
    $1 == "local-data:" && $3 == "A" {
        ip=$4
        sub(/"$/, "", ip)

        if (ip ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)
            print ip
    }
    ' "$FILE"
done |
sort -u > "$FIXED_TMP"

#
# 4. MAC-overrides normaliseren:
#
#    MAC <tab> short-hostname
#
#    Zowel "naam" als "naam.panici.casa" mag worden opgegeven.
#
if [ -f "$OVERRIDES" ]; then
    awk '
    BEGIN {
        FS="[ \t]+"
    }

    /^[[:space:]]*#/ || /^[[:space:]]*$/ {
        next
    }

    NF >= 2 {
        mac=tolower($1)
        name=$2
        lifecycle=(NF >= 7 ? tolower($7) : "active")

        if (lifecycle == "retired")
            next

        sub(/\.$/, "", name)
        sub(/\.panici\.casa$/, "", name)

        if (mac !~ /^[0-9a-f][0-9a-f]:/)
            next

        if (name !~ /^[A-Za-z0-9][A-Za-z0-9-]*$/)
            next

        print mac "\t" name
    }
    ' "$OVERRIDES" > "$OVERRIDE_TMP"
else
    : > "$OVERRIDE_TMP"
fi

#
# 5. Nieuwe Unbound-config genereren.
#
{
    echo "server:"
    echo
} > "$TMP"

awk \
    -v DNSFILE="$DNS_TMP" \
    -v FIXEDFILE="$FIXED_TMP" \
    -v OVERRIDEFILE="$OVERRIDE_TMP" '
BEGIN {
    FS="\t"

    # UDM DNS map: IP -> FQDN
    while ((getline line < DNSFILE) > 0) {
        n=split(line,a,/[\t ]+/)

        if (n >= 2) {
            ip=a[1]
            name=a[2]

            sub(/\.$/, "", name)

            if (ip ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)
                dns[ip]=name
        }
    }
    close(DNSFILE)

    # IPs die door static/iot/lxc beheerd worden.
    while ((getline ip < FIXEDFILE) > 0) {
        fixed[ip]=1
    }
    close(FIXEDFILE)

    # MAC -> canonical override.
    while ((getline line < OVERRIDEFILE) > 0) {
        n=split(line,a,"\t")

        if (n >= 2)
            override[tolower(a[1])]=a[2]
    }
    close(OVERRIDEFILE)
}

NF >= 3 {
    mac=tolower($1)
    ip=$2
    leasehost=$3

    #
    # Onze eigen canonical config wint altijd.
    #
    if (ip in fixed)
        next

    name=""

    #
    # 1. Expliciete MAC-override.
    #
    if (mac in override) {
        name=override[mac] ".panici.casa"
    }

    #
    # 2. Door de UDM opgebouwde lokale DNS-naam.
    #
    else if (ip in dns) {
        name=dns[ip]
    }

    #
    # 3. Rechtstreeks aangeboden DHCP-hostname.
    #
    else if (leasehost != "" && leasehost != "*") {
        name=leasehost

        if (name !~ /\.panici\.casa\.?$/)
            name=name ".panici.casa"
    }

    if (name == "")
        next

    sub(/\.$/, "", name)

    if (name !~ /\.panici\.casa$/)
        next

    #
    # Eén canonical naam per IP.
    #
    if (ip in seen_ip)
        next

    #
    # Eén IP per canonical hostname.
    #
    lname=tolower(name)

    if (lname in seen_name)
        next

    seen_ip[ip]=1
    seen_name[lname]=ip

    print "    local-data: \"" name ". A " ip "\""
    print "    local-data-ptr: \"" ip " " name ".\""
}
' "$LEASE_NORM" >> "$TMP"

#
# 6. Geen wijziging? Dan niets doen.
#
NEW_HASH=$(sha256sum "$TMP" | awk '{print $1}')

if [ -f "$HASHFILE" ]; then
    OLD_HASH=$(cat "$HASHFILE")
else
    OLD_HASH=""
fi

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

echo "$(date '+%F %T') DHCP DNS changes detected"

#
# 7. Nieuwe config veilig plaatsen en volledige Unbound-config testen.
#
if [ -f "$OUT" ]; then
    cp "$OUT" "$OUT.bak"
fi

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
    echo "$(date '+%F %T') ERROR: generated Unbound config is invalid"

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

#
# 8. Batchmodus: centrale panici-dns-sync doet de reload.
#    Standalone: hier zelf reloaden.
#
if [ "${PANICI_BATCH:-0}" = "1" ]; then
    touch "${PANICI_CHANGE_MARKER:-/tmp/panici-dns-sync.changed}"
    echo "$(date '+%F %T') changes staged"
else
    /etc/init.d/unbound reload
    echo "$(date '+%F %T') unbound reloaded"
fi
