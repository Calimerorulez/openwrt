include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-panici-dns
PKG_VERSION:=1.2.5
PKG_RELEASE:=0

PKG_LICENSE:=MIT
PKG_MAINTAINER:=Patrick

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-panici-dns
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=LuCI Panici DNS device manager
  DEPENDS:=+luci-base +panici-dns +curl
  PKGARCH:=all
endef

define Package/luci-app-panici-dns/description
LuCI interface for viewing discovered panici.casa devices and managing
canonical DNS overrides.
endef

define Build/Compile
endef

define Package/luci-app-panici-dns/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/panici-dns
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/panici-dns/devices.js \
		$(1)/www/luci-static/resources/view/panici-dns/devices.js

	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/panici-dns/records.js \
		$(1)/www/luci-static/resources/view/panici-dns/records.js

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-panici-dns.json \
		$(1)/usr/share/luci/menu.d/luci-app-panici-dns.json

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-panici-dns.json \
		$(1)/usr/share/rpcd/acl.d/luci-app-panici-dns.json

	$(INSTALL_DIR) $(1)/usr/libexec
	$(INSTALL_BIN) ./root/usr/libexec/panici-dns-apply \
		$(1)/usr/libexec/panici-dns-apply
	$(INSTALL_BIN) ./root/usr/libexec/panici-managed-dns-apply \
		$(1)/usr/libexec/panici-managed-dns-apply
endef

$(eval $(call BuildPackage,luci-app-panici-dns))
