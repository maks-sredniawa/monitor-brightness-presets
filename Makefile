UUID := monitor-brightness-presets@maksforge.com
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: test schemas install enable pack

test:
	gjs -m tests/run.js

schemas:
	glib-compile-schemas --strict extension/schemas

install: schemas
	ln -sfn $(CURDIR)/extension $(INSTALL_DIR)

enable:
	gnome-extensions enable $(UUID)

pack:
	mkdir -p dist
	gnome-extensions pack extension --extra-source=lib --force --out-dir=dist
