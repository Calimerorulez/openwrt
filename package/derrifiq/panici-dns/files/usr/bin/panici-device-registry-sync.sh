#!/bin/sh

set -eu

UDM="10.0.1.1"
KEY="/root/.ssh/id_ed25519"

DIR="/etc/unbound/panici"

DISCOVERED="$DIR/devices-discovered.tsv"
OVERRIDES="$DIR/device-overrides.tsv"
OUT="$DIR/devices.tsv"

DNS_TMP="/tmp/panici-registry-dns.$$"
LEASE_TMP="/tmp/panici-registry-leases.$$"
MONGO_TMP="/tmp/panici-registry-unifi.$$"
FIXED_TMP="/tmp/panici-registry-fixed.$$"
OVERRIDE_TMP="/tmp/panici-registry-overrides.$$"
DISC_TMP="/tmp/panici-devices-discovered.$$"
OUT_TMP="/tmp/panici-devices.$$"

cleanup() {
    rm -f \
        "$DNS_TMP" \
        "$LEASE_TMP" \
        "$MONGO_TMP" \
        "$FIXED_TMP" \
        "$OVERRIDE_TMP" \
        "$DISC_TMP" \
        "$OUT_TMP"
}
trap cleanup EXIT INT TERM

mkdir -p "$DIR"

###############################################################################
# 1. UDM dnsmasq discovery - READ ONLY
###############################################################################

if ! ssh \
    -i "$KEY" \
    -o BatchMode=yes \
    root@"$UDM" \
    'cat /run/dnsmasq.dns.conf.d/hosts.d/leases' \
    > "$DNS_TMP"
then
    echo "$(date '+%F %T') ERROR: could not read UDM DNS host data"
    exit 1
fi

if ! ssh \
    -i "$KEY" \
    -o BatchMode=yes \
    root@"$UDM" \
    'cat /run/dnsmasq.lease' \
    > "$LEASE_TMP"
then
    echo "$(date '+%F %T') ERROR: could not read UDM DHCP lease data"
    exit 1
fi

if [ ! -s "$LEASE_TMP" ]; then
    echo "$(date '+%F %T') ERROR: UDM DHCP lease data is empty"
    exit 1
fi

###############################################################################
# 2. UniFi Network client metadata uit MongoDB - STRICT READ ONLY
#
# Alleen db.user.find(); geen update/insert/remove.
###############################################################################

if ! ssh \
    -i "$KEY" \
    -o BatchMode=yes \
    root@"$UDM" \
    "mongo --quiet --host 127.0.0.1 --port 27117 ace --eval '
db.user.find(
    {},
    {
        _id: 0,
        mac: 1,
        hostname: 1,
        name: 1,
        oui: 1,
        first_seen: 1,
        last_seen: 1,
        fixed_ip: 1,
        use_fixedip: 1
    }
).maxTimeMS(5000).forEach(function(x) {
    function t(v) {
        if (v === undefined || v === null || v === \"\") return \"-\";
        return String(v).replace(/\t/g, \" \").replace(/\r/g, \" \").replace(/\n/g, \" \");
    }

    function n(v) {
        if (v === undefined || v === null) return \"-\";
        return String(Number(v));
    }

    function b(v) {
        if (v === undefined || v === null) return \"-\";
        return v ? \"true\" : \"false\";
    }

    if (!x.mac) return;

    print([
        t(x.mac).toLowerCase(),
        t(x.name),
        t(x.hostname),
        t(x.oui),
        n(x.first_seen),
        n(x.last_seen),
        t(x.fixed_ip),
        b(x.use_fixedip)
    ].join(\"\t\"));
});
'" > "$MONGO_TMP"
then
    echo "$(date '+%F %T') ERROR: could not read UniFi Network client metadata"
    exit 1
fi

###############################################################################
# 3. Bestaande lokaal beheerde canonical namen per IP
#
# Prioriteit:
# static.conf -> iot.conf -> lxc.conf
###############################################################################

awk '
$1 == "local-data:" && $3 == "A" {
    name=$2
    ip=$4

    sub(/^"/, "", name)
    sub(/"$/, "", ip)

    if (ip ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && !(ip in seen)) {
        seen[ip]=1
        print ip "\t" name
    }
}
' \
    "$DIR/static.conf" \
    "$DIR/iot.conf" \
    "$DIR/lxc.conf" \
    > "$FIXED_TMP"

###############################################################################
# 4. Handmatige overrides normaliseren
#
# Formaat:
# mac canonical description room type identity
###############################################################################

if [ -f "$OVERRIDES" ]; then
    awk -F '\t' '
    BEGIN {
        OFS="\t"
    }

    NR == 1 {
        next
    }

    NF >= 2 {
        mac=tolower($1)
        canonical=$2
        description=(NF >= 3 ? $3 : "")
        room=(NF >= 4 ? $4 : "")
        dtype=(NF >= 5 ? $5 : "")
        identity=(NF >= 6 && $6 != "" ? $6 : canonical)

        sub(/\.$/, "", canonical)
        sub(/\.panici\.casa$/, "", canonical)

        if (mac !~ /^[0-9a-f][0-9a-f]:/)
            next

        if (canonical != "" && canonical !~ /^[A-Za-z0-9][A-Za-z0-9-]*$/)
            next

        print \
            mac, \
            canonical, \
            description, \
            room, \
            dtype, \
            identity
    }
    ' "$OVERRIDES" > "$OVERRIDE_TMP"
else
    : > "$OVERRIDE_TMP"
fi

###############################################################################
# 5. devices-discovered.tsv
#
# Discoverybasis:
#
#   - actuele DHCP lease
#   - OF UniFi client met use_fixedip=true en geldig fixed_ip
#
# Daardoor blijven vaste apparaten zichtbaar wanneer ze tijdelijk offline zijn,
# zonder historische dynamische/randomized clients uit Mongo terug te halen.
###############################################################################

awk \
    -v DNSFILE="$DNS_TMP" \
    -v MONGOFILE="$MONGO_TMP" '
BEGIN {
    OFS="\t"

    #
    # DNS host entries: IP -> naam
    #
    while ((getline line < DNSFILE) > 0) {
        n=split(line,a,/[\t ]+/)

        if (n >= 2)
            dns[a[1]]=a[2]
    }
    close(DNSFILE)

    #
    # UniFi Mongo metadata per MAC.
    #
    while ((getline line < MONGOFILE) > 0) {
        n=split(line,a,"\t")

        if (n >= 1 && a[1] ~ /^[0-9a-f][0-9a-f]:/) {
            mac=tolower(a[1])

            uname[mac]=(n >= 2 ? a[2] : "-")
            uhostname[mac]=(n >= 3 ? a[3] : "-")
            oui[mac]=(n >= 4 ? a[4] : "-")
            firstseen[mac]=(n >= 5 ? a[5] : "-")
            lastseen[mac]=(n >= 6 ? a[6] : "-")
            fixedip[mac]=(n >= 7 ? a[7] : "-")
            usefixed[mac]=(n >= 8 ? a[8] : "-")
        }
    }
    close(MONGOFILE)

    print \
        "mac", \
        "ip", \
        "udm_dns", \
        "dhcp_hostname", \
        "unifi_name", \
        "unifi_hostname", \
        "oui", \
        "first_seen", \
        "last_seen", \
        "fixed_ip", \
        "use_fixedip", \
        "mac_type"
}

#
# Eerst alle actuele DHCP leases.
#
NF >= 4 {
    mac=tolower($2)
    ip=$3
    dhcp=$4

    if (mac !~ /^[0-9a-f][0-9a-f]:/)
        next

    if (ip !~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)
        next

    seen[mac]=1

    udm=(ip in dns ? dns[ip] : "-")

    split(mac,b,":")
    first=("0x" b[1])+0
    mtype=(and(first,2) ? "locally-administered" : "globally-administered")

    print \
        mac, \
        ip, \
        udm, \
        dhcp, \
        (mac in uname ? uname[mac] : "-"), \
        (mac in uhostname ? uhostname[mac] : "-"), \
        (mac in oui ? oui[mac] : "-"), \
        (mac in firstseen ? firstseen[mac] : "-"), \
        (mac in lastseen ? lastseen[mac] : "-"), \
        (mac in fixedip ? fixedip[mac] : "-"), \
        (mac in usefixed ? usefixed[mac] : "-"), \
        mtype
}

END {
    #
    # Daarna UniFi fixed-IP clients die GEEN actuele DHCP lease hebben.
    #
    for (mac in fixedip) {
        if (mac in seen)
            continue

        if (usefixed[mac] != "true")
            continue

        ip=fixedip[mac]

        if (ip !~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)
            continue

        udm=(ip in dns ? dns[ip] : "-")

        split(mac,b,":")
        first=("0x" b[1])+0
        mtype=(and(first,2) ? "locally-administered" : "globally-administered")

        print \
            mac, \
            ip, \
            udm, \
            "-", \
            (mac in uname ? uname[mac] : "-"), \
            (mac in uhostname ? uhostname[mac] : "-"), \
            (mac in oui ? oui[mac] : "-"), \
            (mac in firstseen ? firstseen[mac] : "-"), \
            (mac in lastseen ? lastseen[mac] : "-"), \
            ip, \
            "true", \
            mtype
    }
}
' "$LEASE_TMP" > "$DISC_TMP"

if [ -f "$DISCOVERED" ] && cmp -s "$DISC_TMP" "$DISCOVERED"; then
    echo "$(date '+%F %T') discovered registry no changes"
else
    cp "$DISC_TMP" "$DISCOVERED"
    echo "$(date '+%F %T') discovered registry updated"
fi

###############################################################################
# 6. Samengevoegde devices.tsv
#
# Canonical blijft bewust beheerd:
#   1. expliciete device override
#   2. bestaande static/iot/lxc canonical naam
#
# UniFi name wordt WEL als suggested_name aangeboden,
# maar wordt nog niet automatisch DNS-canonical.
###############################################################################

awk \
    -v FIXEDFILE="$FIXED_TMP" \
    -v OVERRIDEFILE="$OVERRIDE_TMP" '
BEGIN {
    FS="\t"
    OFS="\t"

    while ((getline line < FIXEDFILE) > 0) {
        n=split(line,a,"\t")

        if (n >= 2)
            fixed[a[1]]=a[2]
    }
    close(FIXEDFILE)

    while ((getline line < OVERRIDEFILE) > 0) {
        n=split(line,a,"\t")

        if (n >= 2) {
            mac=tolower(a[1])

            ocanonical[mac]=(n >= 2 ? a[2] : "")
            odescription[mac]=(n >= 3 ? a[3] : "")
            oroom[mac]=(n >= 4 ? a[4] : "")
            otype[mac]=(n >= 5 ? a[5] : "")
            oidentity[mac]=(n >= 6 ? a[6] : "")
        }
    }
    close(OVERRIDEFILE)

    print \
        "mac", \
        "ip", \
        "udm_dns", \
        "dhcp_hostname", \
        "unifi_name", \
        "suggested_name", \
        "canonical", \
        "canonical_source", \
        "description", \
        "room", \
        "type", \
        "identity", \
        "mac_type", \
        "oui", \
        "first_seen", \
        "last_seen", \
        "fixed_ip", \
        "use_fixedip", \
        "identity_warning"
}

NR == 1 {
    next
}

{
    mac=tolower($1)
    ip=$2
    udm=$3
    dhcp=$4
    unifi=$5
    unifi_hostname=$6
    vendor=$7
    firstseen=$8
    lastseen=$9
    fixedip=$10
    usefixed=$11
    mtype=$12

    canonical="-"
    csource="none"
    description=""
    room=""
    dtype=""
    identity=""
    warning=""

    #
    # Beste niet-bindende suggestie.
    #
    suggested="-"

    if (unifi != "-" && unifi != "")
        suggested=unifi
    else if (udm != "-" && udm != "") {
        suggested=udm
        sub(/\.$/, "", suggested)
        sub(/\.panici\.casa$/, "", suggested)
    }
    else if (dhcp != "*" && dhcp != "")
        suggested=dhcp
    else if (unifi_hostname != "-" && unifi_hostname != "")
        suggested=unifi_hostname

    #
    # Expliciete override is hoogste prioriteit.
    #
    if (mac in ocanonical && ocanonical[mac] != "") {
        canonical=ocanonical[mac] ".panici.casa."
        csource="override"

        description=odescription[mac]
        room=oroom[mac]
        dtype=otype[mac]
        identity=oidentity[mac]
    }

    #
    # Anders bestaande lokaal beheerde canonical naam.
    #
    else if (ip in fixed) {
        canonical=fixed[ip]

        if (canonical !~ /\.$/)
            canonical=canonical "."

        csource="fixed-config"
    }

    #
    # Technisch feit, geen aanname over Apple/rotating/fixed.
    #
    if (mtype == "locally-administered")
        warning="stability-unknown"

    print \
        mac, \
        ip, \
        udm, \
        dhcp, \
        unifi, \
        suggested, \
        canonical, \
        csource, \
        description, \
        room, \
        dtype, \
        identity, \
        mtype, \
        vendor, \
        firstseen, \
        lastseen, \
        fixedip, \
        usefixed, \
        warning
}
' "$DISCOVERED" > "$OUT_TMP"

if [ -f "$OUT" ] && cmp -s "$OUT_TMP" "$OUT"; then
    echo "$(date '+%F %T') device registry no changes"
else
    cp "$OUT_TMP" "$OUT"
    echo "$(date '+%F %T') device registry updated: $OUT"
fi
