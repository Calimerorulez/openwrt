# DNS Analytics 2.1.1

DNS Analytics 2.1.1 is de eerste stabiele release van de vernieuwde
classificatie- en reviewarchitectuur.

## Nieuw

- Review-CLI voor pending domeinen.
- Lokale exact- en suffixregels met prioriteiten.
- Automatische herclassificatie van historische gegevens.
- Selftest voor bestanden, rechten, database, processen en configuratie.
- Read-only regressietest.
- Auditlogging van handmatige reviewacties.
- Uitgebreide package-documentatie en changelog.

## Verbeterd

- Betrouwbaar collectorbeheer via collectd.
- Veilige upgrades zonder verweesde collectorprocessen.
- BusyBox-compatibele diagnostiek.
- Behoud van configuratie, secrets, database en lokale regels.
- Uitgebreidere ingebouwde categorisatie.
- Consistente CLI-uitvoer, helpteksten en exitcodes.

## Opgelost

- Dubbele en verweesde collectors.
- Onjuiste collectd-procestelling.
- GNU-stat-afhankelijkheid.
- Ongewenste SQLite busy-timeout-uitvoer.
- Fouten in lokale classificatieregels en herclassificatie.
- Upgradeproblemen waarbij oude collectors actief konden blijven.

## Releasekwaliteit

De release is gevalideerd met:

- upgrade van 2.1.1-rc1 naar 2.1.1-rc2;
- één geldige collector na upgrade;
- SQLite-integriteitscontrole;
- foreign-keycontrole;
- selftest met 0 fouten en 0 waarschuwingen;
- regressietest met 0 fouten;
- behoud van lokale regels en configuratie.
