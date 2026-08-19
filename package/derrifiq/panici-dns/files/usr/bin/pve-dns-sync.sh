#!/bin/sh

set -eu

BEE="10.0.5.222"
KEY="/root/.ssh/id_ed25519"

DIR="/etc/unbound/panici"
OUT="$DIR/lxc.conf"
HASHFILE="$DIR/lxc.conf.sha256"
TMP="/tmp/panici-lxc.conf.$$"

cleanup() {
    rm -f "$TMP"
}

trap cleanup EXIT INT TERM

mkdir -p "$DIR"

ssh -i "$KEY" root@"$BEE" '
for CT in $(pct list | awk "NR>1 && \$2==\"running\" {print \$1}" | sort -n); do
    pct config "$CT"
    echo "---END---"
done
' |
awk '
BEGIN {
    print "server:"
    print ""
}

/^hostname:/ {
    name=$2
}

/^net[0-9]+:/ {
    n=split($0,a,",")
    for(i=1;i<=n;i++){
        if(a[i] ~ /^ip=/){
            ip=a[i]
            sub(/^ip=/,"",ip)
            sub(/\/.*/,"",ip)
        }
    }
}

/^---END---/ {
    if(name != "" && ip != ""){
        print "    local-data: \"" name ".panici.casa. A " ip "\""
        print "    local-data-ptr: \"" ip " " name ".panici.casa.\""
    }

    name=""
    ip=""
}
' > "$TMP"

NEW_HASH=$(sha256sum "$TMP" | awk '{print $1}')

OLD_HASH=""
[ -f "$HASHFILE" ] && OLD_HASH=$(cat "$HASHFILE")

if [ "$NEW_HASH" = "$OLD_HASH" ]; then
    echo "$(date '+%F %T') no changes"
    exit 0
fi

echo "$(date '+%F %T') DNS changes detected"

if [ -f "$OUT" ]; then
    echo "$(date '+%F %T') diff:"
    diff -u "$OUT" "$TMP" 2>/dev/null || true
fi

mv "$TMP" "$OUT"

if ! unbound-checkconf >/dev/null 2>&1; then
    echo "$(date '+%F %T') ERROR: invalid Unbound config"
    exit 1
fi

echo "$NEW_HASH" > "$HASHFILE"

#
# Batchmodus: centrale panici-dns-sync doet de reload.
# Standalone: hier zelf reloaden.
#
if [ "${PANICI_BATCH:-0}" = "1" ]; then
    touch "${PANICI_CHANGE_MARKER:-/tmp/panici-dns-sync.changed}"
    echo "$(date '+%F %T') changes staged"
else
    /etc/init.d/unbound reload
    echo "$(date '+%F %T') unbound reloaded"
fi
