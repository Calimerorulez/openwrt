include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for NanoMQ
LUCI_DEPENDS:=+nanomq
LUCI_PKGARCH:=all

PKG_NAME:=luci-app-nanomq
PKG_VERSION:=1.0
PKG_RELEASE:=4

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
$(eval $(call BuildPackage,$(PKG_NAME)))
