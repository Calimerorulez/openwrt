include $(TOPDIR)/rules.mk

PKG_NAME:=panici-dns
PKG_VERSION:=1.2.5
PKG_RELEASE:=4

PKG_LICENSE:=MIT
PKG_MAINTAINER:=derrifiq

include $(INCLUDE_DIR)/package.mk

define Package/panici-dns
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Panici DNS synchronization backend
  DEPENDS:=+unbound-daemon +dropbear +flock
endef

define Package/panici-dns/description
Backend for panici.casa DNS synchronization.

Synchronizes Proxmox LXC and UniFi client data, maintains the local
device registry and canonical device overrides, and generates Unbound
forward and PTR records.
endef

define Package/panici-dns/conffiles
/etc/unbound/panici/device-overrides.tsv
/etc/panici-dns/device-identities.tsv
/etc/panici-dns/internal-hostnames.tsv
/etc/panici-dns/managed-records.tsv
/etc/panici-dns/adguard-cache.conf
endef

define Build/Compile
endef

define Package/panici-dns/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/usr/bin/panici-dns-sync $(1)/usr/bin/panici-dns-sync

	$(INSTALL_DIR) $(1)/etc/unbound/panici
	$(INSTALL_CONF) ./files/etc/unbound/panici/device-overrides.tsv \
		$(1)/etc/unbound/panici/device-overrides.tsv

	$(INSTALL_DIR) $(1)/etc/panici-dns
	$(INSTALL_CONF) ./files/etc/panici-dns/device-identities.tsv \
		$(1)/etc/panici-dns/device-identities.tsv
	$(INSTALL_CONF) ./files/etc/panici-dns/internal-hostnames.tsv \
		$(1)/etc/panici-dns/internal-hostnames.tsv
	$(INSTALL_CONF) ./files/etc/panici-dns/managed-records.tsv \
		$(1)/etc/panici-dns/managed-records.tsv
	$(INSTALL_CONF) ./files/etc/panici-dns/adguard-cache.conf \
		$(1)/etc/panici-dns/adguard-cache.conf
endef

$(eval $(call BuildPackage,panici-dns))
