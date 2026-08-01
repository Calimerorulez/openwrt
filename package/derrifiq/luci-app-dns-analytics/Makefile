include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-dns-analytics
PKG_VERSION:=2.3.0
PKG_RELEASE:=4

LUCI_TITLE:=LuCI interface for DNS Analytics
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ucode-mod-fs +dns-analytics
LUCI_PKGARCH:=all

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Patrick <chatgpt@derrifiq.nl>

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
