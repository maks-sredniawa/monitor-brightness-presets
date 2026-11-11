import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DdcutilMissingError, Monitors, NoMonitorsError, isCancelled} from './lib/monitors.js';

const ICON = 'display-brightness-symbolic';

const PresetsToggle = GObject.registerClass(
class PresetsToggle extends QuickMenuToggle {
    constructor(extension) {
        super({title: _('Brightness'), iconName: ICON, toggleMode: false});
        this._extension = extension;
        this._settings = extension.getSettings();
        this._monitors = new Monitors();

        this.menu.setHeader(ICON, _('Brightness presets'), _('Sets every monitor at once'));
        this._presetSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._presetSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Edit presets'), () => extension.openPreferences());

        this.connect('clicked', () => this.menu.open());
        this.connect('destroy', () => this._monitors.destroy());
        this._settings.connectObject('changed', () => this._sync(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._monitors.forget(), this);
        this._sync();
    }

    _sync() {
        const presets = this._settings.get_value('presets').deepUnpack();
        const active = this._settings.get_string('active-preset');
        this.subtitle = presets.some(([name]) => name === active) ? active : null;

        this._presetSection.removeAll();
        for (const [name, percent] of presets) {
            const item = new PopupMenu.PopupMenuItem(name);
            item.add_child(new St.Label({
                text: `${percent}%`,
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            item.setOrnament(name === active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this._apply(name, percent));
            this._presetSection.addMenuItem(item);
        }
    }

    async _apply(name, percent) {
        try {
            const {displays, failed} = await this._monitors.setBrightness(percent);
            if (failed.length < displays.length)
                this._settings.set_string('active-preset', name);
            if (failed.length > 0) {
                Main.notify(_('Brightness preset'),
                    _('%s did not change its brightness. Its own menu may be locking it, for example an ECO mode or picture preset.').format(failed.map(display => display.name).join(', ')));
            }
        } catch (error) {
            if (isCancelled(error))
                return;
            if (error instanceof DdcutilMissingError) {
                Main.notify(_('Brightness preset'), _('Install ddcutil to control your monitors.'));
            } else if (error instanceof NoMonitorsError) {
                Main.notify(_('Brightness preset'),
                    _('No monitor answered over DDC/CI. Check that DDC/CI is on in each monitor’s own menu.'));
            } else {
                console.error(`monitor-brightness-presets: ${error.message}`);
                Main.notify(_('Brightness preset'), error.message);
            }
        }
    }
});

const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    constructor(extension) {
        super();
        this.quickSettingsItems.push(new PresetsToggle(extension));
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class MonitorBrightnessPresetsExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
