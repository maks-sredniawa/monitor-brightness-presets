UUID := monitor-brightness-presets@maksforge.com
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
APP_ID := com.maksforge.MonitorBrightnessPresets
DATA_DIR := $(HOME)/.local/share
DESKTOP_FILE := $(DATA_DIR)/applications/$(APP_ID).desktop
ICON_DIR := $(DATA_DIR)/icons/hicolor

.PHONY: test smoke schemas install install-app uninstall-app enable pack

test: schemas
	gjs -m tests/run.js

smoke: schemas
	env -u WAYLAND_DISPLAY GDK_BACKEND=x11 GSETTINGS_BACKEND=memory xvfb-run -a gjs -m tests/app-smoke.js

schemas:
	glib-compile-schemas --strict extension/schemas

install: schemas
	ln -sfn $(CURDIR)/extension $(INSTALL_DIR)

install-app: schemas
	mkdir -p $(DATA_DIR)/applications $(ICON_DIR)/scalable/apps $(ICON_DIR)/symbolic/apps
	sed 's|@APP_DIR@|$(CURDIR)/app|' app/$(APP_ID).desktop.in > $(DESKTOP_FILE)
	ln -sfn $(CURDIR)/app/icons/$(APP_ID).svg $(ICON_DIR)/scalable/apps/$(APP_ID).svg
	ln -sfn $(CURDIR)/app/icons/$(APP_ID)-symbolic.svg $(ICON_DIR)/symbolic/apps/$(APP_ID)-symbolic.svg

uninstall-app:
	rm -f $(DESKTOP_FILE) $(ICON_DIR)/scalable/apps/$(APP_ID).svg $(ICON_DIR)/symbolic/apps/$(APP_ID)-symbolic.svg

enable:
	gnome-extensions enable $(UUID)

pack:
	mkdir -p dist
	gnome-extensions pack extension --extra-source=lib --extra-source=icons --force --out-dir=dist
