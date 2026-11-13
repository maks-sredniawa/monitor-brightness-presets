import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {format} from './lib/format.js';
import {contrastIcon} from './lib/icons.js';
import {DdcutilMissingError, Monitors, NoMonitorsError, isCancelled} from './lib/monitors.js';
import {readPresets} from './lib/presets.js';
import {acceptedBrightness, describeProblems} from './lib/problems.js';

const ICON = 'display-brightness-symbolic';
const APP_ID = 'com.maksforge.MonitorBrightnessPresets.desktop';

const PresetsToggle = GObject.registerClass(
class PresetsToggle extends QuickMenuToggle {
    constructor(extension) {
        super({title: _('Brightness'), iconName: ICON, toggleMode: false});
        this._extension = extension;
        this._settings = extension.getSettings();
        this._monitors = new Monitors();
        this._request = 0;

        this.menu.setHeader(ICON, _('Brightness presets'), _('Sets every monitor at once'));
        this._presetSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._presetSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._openApp = this.menu.addAction(_('Open Brightness Presets'),
            () => Shell.AppSystem.get_default().lookup_app(APP_ID)?.activate());
        this.menu.addAction(_('Edit presets'), () => extension.openPreferences());

        this.connect('clicked', () => this.menu.open());
        this.connect('destroy', () => this._monitors.destroy());
        this._settings.connectObject('changed', () => this._sync(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._monitors.forget(), this);
        Shell.AppSystem.get_default().connectObject('installed-changed', () => this._syncOpenApp(), this);
        this._sync();
        this._syncOpenApp();
    }

    _syncOpenApp() {
        this._openApp.visible = Shell.AppSystem.get_default().lookup_app(APP_ID) !== null;
    }

    _sync() {
        const presets = readPresets(this._settings);
        const active = this._settings.get_string('active-preset');
        this.subtitle = presets.some(({name}) => name === active) ? active : null;
        const withContrast = presets.some(({contrast}) => contrast !== null);

        this._presetSection.removeAll();
        for (const preset of presets) {
            const item = new PopupMenu.PopupMenuItem(preset.name);
            item.add_child(new St.Label({
                text: `${preset.brightness}%`,
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            if (withContrast)
                item.add_child(this._contrastSlot(preset.contrast));
            item.accessible_name = preset.contrast === null
                ? format(_('%s, brightness %d%%'), preset.name, preset.brightness)
                : format(_('%s, brightness %d%%, contrast %d%%'), preset.name, preset.brightness, preset.contrast);
            item.setOrnament(preset.name === active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this._apply(preset));
            this._presetSection.addMenuItem(item);
        }
    }

    _contrastSlot(contrast) {
        const slot = new St.BoxLayout({
            style: 'min-width: 4.5em; spacing: 4px;',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (contrast === null)
            return slot;
        slot.add_child(new St.Icon({gicon: contrastIcon(), style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.CENTER}));
        slot.add_child(new St.Label({text: `${contrast}%`, y_align: Clutter.ActorAlign.CENTER}));
        return slot;
    }

    async _apply({name, brightness, contrast}) {
        const request = ++this._request;
        try {
            const {displays, failed, rejected, unreachable} = await this._monitors.apply({brightness, contrast});
            if (request !== this._request)
                return;
            if (acceptedBrightness(displays, rejected))
                this._settings.set_string('active-preset', name);
            if (failed.length > 0 || unreachable.length > 0)
                Main.notify(_('Brightness preset'), describeProblems(ngettext, failed, rejected, unreachable));
        } catch (error) {
            if (request !== this._request || isCancelled(error))
                return;
            if (error instanceof DdcutilMissingError) {
                Main.notify(_('Brightness preset'), _('Install ddcutil to control your monitors.'));
            } else if (error instanceof NoMonitorsError && error.unreachable.length > 0) {
                Main.notify(_('Brightness preset'), describeProblems(ngettext, [], {}, error.unreachable));
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
