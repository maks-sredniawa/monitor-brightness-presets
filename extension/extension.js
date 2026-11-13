import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {format} from './lib/format.js';
import {contrastIcon} from './lib/icons.js';
import {DdcutilMissingError, Monitors, NoMonitorsError, isCancelled} from './lib/monitors.js';
import {readPresets} from './lib/presets.js';
import {acceptedBrightness, describeProblems} from './lib/problems.js';
import {
    catchUpSlot, clockFormat, currentSlot, handledAfterEdit, interfaceSettings, markHandPick, msUntil, nextChange,
    nextChangeLabel, scheduleState,
} from './lib/schedule.js';

const ICON = 'display-brightness-symbolic';
const APP_ID = 'com.maksforge.MonitorBrightnessPresets.desktop';
const TIMER_SLACK_MS = 500;
const WAKE_SETTLE_MS = 3000;

const PresetsToggle = GObject.registerClass(
class PresetsToggle extends QuickMenuToggle {
    constructor(extension) {
        super({title: _('Brightness'), iconName: ICON, toggleMode: false});
        this._extension = extension;
        this._settings = extension.getSettings();
        this._monitors = new Monitors();
        this._request = 0;
        this._timer = 0;
        this._wakeTimer = 0;
        this._clock = interfaceSettings();
        this._scheduleOn = this._settings.get_boolean('schedule-enabled');

        this.menu.setHeader(ICON, _('Brightness presets'), _('Sets every monitor at once'));
        this._presetSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._presetSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._scheduleSwitch = new PopupMenu.PopupSwitchMenuItem(_('Follow schedule'), this._scheduleOn);
        this._scheduleSwitch.connect('toggled', (_item, state) => {
            if (state !== this._settings.get_boolean('schedule-enabled'))
                this._settings.set_boolean('schedule-enabled', state);
        });
        this.menu.addMenuItem(this._scheduleSwitch);
        this._openApp = this.menu.addAction(_('Open Brightness Presets'),
            () => Shell.AppSystem.get_default().lookup_app(APP_ID)?.activate());
        this.menu.addAction(_('Edit presets'), () => extension.openPreferences());

        this.connect('clicked', () => this.menu.open());
        this.connect('destroy', () => this._onDestroy());
        this._settings.connectObject(
            'changed', () => this._sync(),
            'changed::schedule', () => this._scheduleEdited(),
            'changed::presets', () => this._scheduleEdited(),
            'changed::schedule-enabled', () => this._scheduleSwitched(),
            this);
        this._clock?.connectObject('changed::clock-format', () => this._sync(), this);
        this._loginManager = LoginManager.getLoginManager();
        this._sleepHandler = this._loginManager.connect('prepare-for-sleep', (_manager, aboutToSuspend) => {
            if (!aboutToSuspend)
                this._woke();
        });
        Main.layoutManager.connectObject('monitors-changed', () => this._monitors.forget(), this);
        Shell.AppSystem.get_default().connectObject('installed-changed', () => this._syncOpenApp(), this);
        this._sync();
        this._syncOpenApp();
        this._arm();
        this._catchUp();
    }

    _onDestroy() {
        this._loginManager.disconnect(this._sleepHandler);
        for (const timer of [this._timer, this._wakeTimer]) {
            if (timer)
                GLib.source_remove(timer);
        }
        this._timer = this._wakeTimer = 0;
        this._monitors.destroy();
    }

    _schedule() {
        return scheduleState(this._settings, GLib.DateTime.new_now_local());
    }

    _arm() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        const state = this._schedule();
        this._armedWith = state;
        const next = state.enabled ? nextChange(state.entries, state.names, state.now) : null;
        if (!next)
            return;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, msUntil(next.at, state.now) + TIMER_SLACK_MS, () => {
            this._timer = 0;
            this._fire();
            return GLib.SOURCE_REMOVE;
        });
    }

    _fire() {
        const slot = catchUpSlot(this._schedule());
        if (slot)
            this._applySlot(slot, 'scheduled');
        this._arm();
        this._sync();
    }

    _catchUp() {
        const slot = catchUpSlot(this._schedule());
        if (slot)
            this._applySlot(slot, 'catch-up');
    }

    _woke() {
        this._arm();
        this._sync();
        if (this._wakeTimer)
            GLib.source_remove(this._wakeTimer);
        // Monitors are often still waking up for a moment after the system does.
        this._wakeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WAKE_SETTLE_MS, () => {
            this._wakeTimer = 0;
            this._monitors.forget();
            this._catchUp();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleEdited() {
        const state = this._schedule();
        const {entries, names} = this._armedWith ?? state;
        if (state.enabled) {
            const handled = handledAfterEdit({
                handled: state.handled,
                before: currentSlot(entries, names, state.now),
                after: currentSlot(state.entries, state.names, state.now),
            });
            if (handled !== state.handled)
                this._settings.set_int64('schedule-handled', handled);
        }
        this._arm();
    }

    _scheduleSwitched() {
        const on = this._settings.get_boolean('schedule-enabled');
        const turnedOn = on && !this._scheduleOn;
        this._scheduleOn = on;
        this._arm();
        if (!turnedOn)
            return;
        const state = this._schedule();
        const slot = currentSlot(state.entries, state.names, state.now);
        if (slot)
            this._applySlot(slot, 'switched-on');
    }

    _applySlot(slot, reason) {
        const preset = readPresets(this._settings).find(({name}) => name === slot.preset);
        if (preset)
            this._apply(preset, {reason, slotAt: slot.at});
    }

    _syncOpenApp() {
        this._openApp.visible = Shell.AppSystem.get_default().lookup_app(APP_ID) !== null;
    }

    _sync() {
        const presets = readPresets(this._settings);
        const active = this._settings.get_string('active-preset');
        this.subtitle = presets.some(({name}) => name === active) ? active : null;
        const schedule = this._schedule();
        this.menu.setHeader(ICON, _('Brightness presets'),
            nextChangeLabel({...schedule, clockFormat: clockFormat(this._clock)}, _) ?? _('Sets every monitor at once'));
        this._scheduleSwitch.visible = schedule.enabled || schedule.entries.length > 0;
        this._scheduleSwitch.setToggleState(schedule.enabled);
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

    async _apply({name, brightness, contrast}, {reason = 'hand', slotAt = 0} = {}) {
        const request = ++this._request;
        if (reason === 'hand')
            markHandPick(this._settings, GLib.DateTime.new_now_local());
        const title = reason === 'hand' ? _('Brightness preset') : _('Brightness schedule');
        const notify = body => {
            if (reason !== 'catch-up')
                Main.notify(title, body);
        };
        try {
            const {displays, failed, rejected, unreachable} = await this._monitors.apply({brightness, contrast});
            if (request !== this._request)
                return;
            if (acceptedBrightness(displays, rejected)) {
                this._settings.set_string('active-preset', name);
                if (reason !== 'hand' && slotAt > this._settings.get_int64('schedule-handled'))
                    this._settings.set_int64('schedule-handled', slotAt);
            }
            if (failed.length > 0 || unreachable.length > 0)
                notify(describeProblems(ngettext, failed, rejected, unreachable));
        } catch (error) {
            if (request !== this._request || isCancelled(error))
                return;
            if (error instanceof DdcutilMissingError) {
                notify(_('Install ddcutil to control your monitors.'));
            } else if (error instanceof NoMonitorsError && error.unreachable.length > 0) {
                notify(describeProblems(ngettext, [], {}, error.unreachable));
            } else if (error instanceof NoMonitorsError) {
                notify(_('No monitor answered over DDC/CI. Check that DDC/CI is on in each monitor’s own menu.'));
            } else {
                console.error(`monitor-brightness-presets: ${error.message}`);
                notify(error.message);
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
