include $(TOPDIR)/rules.mk

PKG_NAME:=derrifiq-feed-config
PKG_VERSION:=1.1
PKG_RELEASE:=1

include $(INCLUDE_DIR)/package.mk

define Package/derrifiq-feed-config
  SECTION:=admin
  CATEGORY:=Administration
  TITLE:=Derrifiq APK feed configuration
  PKGARCH:=all
endef

define Package/derrifiq-feed-config/description
 Installs the public signing key and repository configuration
 for the Derrifiq APK package feed.
endef

define Build/Compile
endef

define Package/derrifiq-feed-config/install
	$(INSTALL_DIR) $(1)/etc/apk/keys
	$(INSTALL_DATA) \
		./files/derrifiq-packages-public.pem \
		$(1)/etc/apk/keys/derrifiq-packages-public.pem

	$(INSTALL_DIR) $(1)/etc/apk/repositories.d
	$(INSTALL_DATA) \
		./files/derrifiq.list \
		$(1)/etc/apk/repositories.d/derrifiq.list
endef

$(eval $(call BuildPackage,derrifiq-feed-config))
