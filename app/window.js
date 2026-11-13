import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {percentToValue} from '../extension/lib/ddc.js';
import {DdcutilMissingError, Monitors, NoMonitorsError, isCancelled} from '../extension/lib/monitors.js';
import {buildPresetsEditor} from '../extension/lib/presetsEditor.js';
import {MonitorRow} from './monitorRow.js';

const _ = text => text;

const NOT_ANSWERING = _('Not answering over DDC/CI. Check that DDC/CI is on in its own menu.');
const HINTS = {
    silent: NOT_ANSWERING,
    invalid: NOT_ANSWERING,
    disabled: _('DDC/CI is turned off. Turn it on in the monitor’s own menu, then refresh.'),
    busy: _('In use by another program, such as the ddcci kernel module, so it is left as it is.'),
};
const REJECTED = _('Did not change its brightness. Its own menu may be locking it, for example an ECO mode or picture preset.');
const INSTALL_COMMAND = 'sudo apt install ddcutil';
const REPLUG_SETTLE_MS = 2000;
const APP_ICON = 'com.maksforge.MonitorBrightnessPresets';
const REPO_URL = 'https://github.com/maks-sredniawa/monitor-brightness-presets';

export const BrightnessWindow = GObject.registerClass(
class BrightnessWindow extends Adw.ApplicationWindow {
    constructor(application, settings) {
        super({
            application,
            title: _('Brightness Presets'),
            default_width: 460,
            default_height: 560,
            width_request: 360,
            height_request: 320,
        });
        this._settings = settings;
        this._monitors = new Monitors();
        this._monitorRows = new Map();
        this._presetRows = [];
        this._presetRequest = 0;
        this._pendingPreset = null;
        this._refreshRequest = 0;
        this._followRequest = 0;
        this._recheckRequest = 0;
        this._replugTimer = 0;
        this._written = settings.get_string('active-preset');

        this._toasts = new Adw.ToastOverlay({child: this._buildToolbar()});
        this.content = this._toasts;
        this._addActions();

        const handlers = [
            settings.connect('changed::presets', () => this._buildPresetRows()),
            settings.connect('changed::active-preset', () => this._followActivePreset()),
        ];
        const screens = this.get_display().get_monitors();
        const replug = screens.connect('items-changed', () => this._refreshAfterReplug());
        this.connect('notify::is-active', () => {
            if (this.is_active)
                this._recheckNotedRows();
        });
        this.connect('close-request', () => {
            handlers.forEach(id => settings.disconnect(id));
            screens.disconnect(replug);
            if (this._replugTimer)
                GLib.source_remove(this._replugTimer);
            this._monitors.destroy();
            return false;
        });

        this._buildPresetRows();
        this._refresh();
    }

    _buildToolbar() {
        const header = new Adw.HeaderBar();
        header.pack_start(new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: _('Refresh Monitors'),
            action_name: 'win.refresh',
        }));
        const menu = new Gio.Menu();
        menu.append(_('Keyboard Shortcuts'), 'win.shortcuts');
        menu.append(_('About Brightness Presets'), 'win.about');
        header.pack_end(new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic',
            tooltip_text: _('Main Menu'),
            menu_model: menu,
            primary: true,
        }));

        this._status = new Adw.StatusPage();
        this._stack = new Gtk.Stack({transition_type: Gtk.StackTransitionType.CROSSFADE});
        this._stack.add_named(this._buildContent(), 'content');
        this._stack.add_named(this._status, 'status');

        const toolbar = new Adw.ToolbarView({content: this._stack});
        toolbar.add_top_bar(header);
        return toolbar;
    }

    _buildContent() {
        this._presetsGroup = new Adw.PreferencesGroup({
            title: _('Presets'),
            description: _('Sets every monitor at once'),
        });
        this._presetsGroup.set_header_suffix(new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            tooltip_text: _('Edit Presets'),
            action_name: 'win.edit-presets',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        }));
        this._presetList = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        this._presetsGroup.add(this._presetList);

        const monitorsGroup = new Adw.PreferencesGroup({title: _('Monitors')});
        this._monitorList = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        monitorsGroup.add(this._monitorList);

        const page = new Adw.PreferencesPage();
        page.add(this._presetsGroup);
        page.add(monitorsGroup);
        return page;
    }

    _addActions() {
        this._refreshAction = new Gio.SimpleAction({name: 'refresh'});
        this._refreshAction.connect('activate', () => this._refresh());
        const editPresets = new Gio.SimpleAction({name: 'edit-presets'});
        editPresets.connect('activate', () => this._editPresets());
        const shortcuts = new Gio.SimpleAction({name: 'shortcuts'});
        shortcuts.connect('activate', () => this._showShortcuts());
        const about = new Gio.SimpleAction({name: 'about'});
        about.connect('activate', () => this._showAbout());
        const applyPreset = new Gio.SimpleAction({name: 'apply-preset', parameter_type: new GLib.VariantType('i')});
        applyPreset.connect('activate', (_action, position) => {
            const preset = this._presets()[position.unpack() - 1];
            if (preset && this._presetsGroup.sensitive && this._stack.visible_child_name === 'content')
                this._applyPreset(...preset);
        });
        for (const action of [this._refreshAction, editPresets, shortcuts, about, applyPreset])
            this.add_action(action);
    }

    _presets() {
        return this._settings.get_value('presets').deepUnpack();
    }

    _buildPresetRows() {
        this._presetList.remove_all();
        this._presetRows = [];
        const presets = this._presets();
        if (presets.length === 0) {
            this._presetList.append(new Adw.ActionRow({
                title: _('No presets'),
                subtitle: _('Add one with the edit button above.'),
            }));
            return;
        }
        for (const [name, percent] of presets) {
            const mark = new Gtk.Stack({width_request: 16, height_request: 16, valign: Gtk.Align.CENTER});
            mark.add_named(new Gtk.Box(), 'none');
            mark.add_named(new Gtk.Image({icon_name: 'object-select-symbolic'}), 'check');
            mark.add_named(new Adw.Spinner(), 'busy');
            const row = new Adw.ActionRow({title: name, use_markup: false, activatable: true});
            row.add_suffix(new Gtk.Label({label: `${percent}%`, css_classes: ['numeric', 'dim-label']}));
            row.add_suffix(mark);
            row.connect('activated', () => this._applyPreset(name, percent));
            this._presetList.append(row);
            this._presetRows.push({name, mark});
        }
        this._syncPresetMarks();
    }

    _syncPresetMarks() {
        const active = this._settings.get_string('active-preset');
        for (const {name, mark} of this._presetRows) {
            if (name === this._pendingPreset)
                mark.visible_child_name = 'busy';
            else
                mark.visible_child_name = name === active ? 'check' : 'none';
        }
    }

    _writeActivePreset(name) {
        this._written = name;
        if (this._settings.get_string('active-preset') !== name)
            this._settings.set_string('active-preset', name);
    }

    _followActivePreset() {
        this._syncPresetMarks();
        const active = this._settings.get_string('active-preset');
        if (active === this._written)
            return;
        this._written = active;
        const request = ++this._followRequest;
        this._readBack(active, () => request === this._followRequest, () => true);
    }

    _recheckNotedRows() {
        if (![...this._monitorRows.values()].some(row => row.note))
            return;
        const request = ++this._recheckRequest;
        this._readBack(this._settings.get_string('active-preset'),
            () => request === this._recheckRequest, row => row.note !== null);
    }

    async _readBack(active, isCurrent, wanted) {
        const rowRequests = new Map([...this._monitorRows].map(([bus, row]) => [bus, row.request]));
        let displays;
        try {
            ({displays} = await this._monitors.read());
        } catch (error) {
            if (isCurrent())
                this._showError(error);
            return;
        }
        if (!isCurrent())
            return;
        const preset = this._presets().find(([name]) => name === active);
        for (const display of displays) {
            const row = this._monitorRows.get(display.bus);
            if (!row || row.request !== rowRequests.get(display.bus) || !wanted(row))
                continue;
            row.percent = display.percent;
            if (preset && display.current === percentToValue(preset[1], display.max))
                row.note = null;
        }
    }

    async _applyPreset(name, percent) {
        const request = ++this._presetRequest;
        this._pendingPreset = name;
        this._syncPresetMarks();
        const rowRequests = new Map();
        for (const [bus, row] of this._monitorRows) {
            rowRequests.set(bus, ++row.request);
            row.working = false;
        }
        try {
            const {displays, failed} = await this._monitors.setBrightness(percent);
            if (request !== this._presetRequest)
                return;
            if (failed.length < displays.length)
                this._writeActivePreset(name);
            this._showWrites(displays, failed, percent, rowRequests);
        } catch (error) {
            if (request === this._presetRequest)
                this._showError(error);
        } finally {
            if (request === this._presetRequest) {
                this._pendingPreset = null;
                this._syncPresetMarks();
            }
        }
    }

    _showWrites(displays, failed, percent, rowRequests) {
        if (displays.some(display => !this._monitorRows.has(display.bus))) {
            this._refresh();
            return;
        }
        for (const display of displays) {
            const row = this._monitorRows.get(display.bus);
            if (row.request !== rowRequests.get(display.bus))
                continue;
            if (failed.includes(display)) {
                row.note = REJECTED;
            } else {
                row.note = null;
                row.percent = percent;
            }
        }
        if (failed.length > 0)
            this._rereadRejected();
    }

    async _setMonitor(row, percent) {
        const request = ++row.request;
        row.working = true;
        try {
            const {displays, failed} = await this._monitors.setMonitorBrightness(row.bus, percent);
            if (request !== row.request)
                return;
            if (!displays.some(display => display.bus === row.bus)) {
                this._refresh();
            } else if (failed.length > 0) {
                row.note = REJECTED;
                this._rereadRejected();
            } else {
                row.note = null;
                this._writeActivePreset('');
            }
        } catch (error) {
            if (request === row.request)
                this._showError(error);
        } finally {
            if (request === row.request)
                row.working = false;
        }
    }

    async _rereadRejected() {
        let displays;
        try {
            ({displays} = await this._monitors.read());
        } catch (error) {
            if (!isCancelled(error))
                this._showError(error);
            return;
        }
        for (const display of displays) {
            const row = this._monitorRows.get(display.bus);
            if (row?.note)
                row.percent = display.percent;
        }
    }

    async _refresh() {
        const request = ++this._refreshRequest;
        this._refreshAction.enabled = false;
        for (const row of this._monitorRows.values())
            row.refreshing = true;
        if (this._monitorList.get_first_child() === null)
            this._monitorList.append(this._lookingRow());
        this._monitors.forget();
        try {
            const {displays, unreachable} = await this._monitors.read();
            if (request === this._refreshRequest)
                this._showMonitors(displays, unreachable);
        } catch (error) {
            if (request !== this._refreshRequest || isCancelled(error))
                return;
            if (error instanceof NoMonitorsError && error.unreachable.length > 0)
                this._showMonitors([], error.unreachable);
            else
                this._showStatus(error);
        } finally {
            if (request === this._refreshRequest)
                this._refreshAction.enabled = true;
        }
    }

    _refreshAfterReplug() {
        if (this._replugTimer)
            GLib.source_remove(this._replugTimer);
        this._replugTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPLUG_SETTLE_MS, () => {
            this._replugTimer = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _lookingRow() {
        const row = new Adw.ActionRow({title: _('Looking for monitors…')});
        row.add_prefix(new Adw.Spinner({width_request: 16, height_request: 16}));
        return row;
    }

    _showMonitors(displays, unreachable) {
        this._stack.visible_child_name = 'content';
        this._monitorList.remove_all();
        const rows = new Map();
        for (const display of displays) {
            const row = this._monitorRows.get(display.bus) ??
                new MonitorRow(display.bus, percent => this._setMonitor(row, percent));
            row.name = display.name;
            row.percent = display.percent;
            row.note = null;
            row.refreshing = false;
            rows.set(display.bus, row);
            this._monitorList.append(row);
        }
        for (const {name, reason} of unreachable) {
            this._monitorList.append(new Adw.ActionRow({
                title: name,
                subtitle: HINTS[reason] ?? NOT_ANSWERING,
                use_markup: false,
            }));
        }
        this._monitorRows = rows;
        this._presetsGroup.sensitive = displays.length > 0;
    }

    _showStatus(error) {
        const tryAgain = new Gtk.Button({label: _('Try Again'), action_name: 'win.refresh', css_classes: ['pill']});
        const buttons = new Gtk.Box({spacing: 12, halign: Gtk.Align.CENTER});
        if (error instanceof DdcutilMissingError) {
            this._status.icon_name = 'dialog-information-symbolic';
            this._status.title = _('ddcutil Is Not Installed');
            this._status.description = GLib.markup_escape_text(
                _('Brightness Presets needs ddcutil to talk to your monitors. Install it, then log out and in again so your session can reach them.'), -1);
            const copy = new Gtk.Button({label: _('Copy Install Command'), css_classes: ['pill']});
            copy.connect('clicked', () => {
                this.get_clipboard().set_text(INSTALL_COMMAND);
                this._toasts.add_toast(new Adw.Toast({title: _('Copied')}));
            });
            buttons.append(copy);
            tryAgain.add_css_class('suggested-action');
        } else if (error instanceof NoMonitorsError) {
            this._status.icon_name = 'video-display-symbolic';
            this._status.title = _('No Monitor Answered');
            this._status.description = GLib.markup_escape_text(
                _('No monitor answered over DDC/CI. Check that DDC/CI is on in each monitor’s own menu.'), -1);
        } else {
            this._status.icon_name = 'dialog-warning-symbolic';
            this._status.title = _('Could Not Read Monitors');
            this._status.description = GLib.markup_escape_text(error.message, -1);
        }
        buttons.append(tryAgain);
        this._status.child = buttons;
        this._stack.visible_child_name = 'status';
        this._monitorList.remove_all();
        this._monitorRows = new Map();
    }

    _showError(error) {
        if (isCancelled(error))
            return;
        if (error instanceof DdcutilMissingError || error instanceof NoMonitorsError) {
            this._refresh();
            return;
        }
        this._toasts.add_toast(new Adw.Toast({title: error.message, timeout: 5}));
    }

    _editPresets() {
        const editor = buildPresetsEditor(this._settings, _);
        const page = new Adw.PreferencesPage();
        page.add(editor.group);
        const view = new Adw.ToolbarView({content: page});
        view.add_top_bar(new Adw.HeaderBar());
        const dialog = new Adw.Dialog({title: _('Edit Presets'), content_width: 440, content_height: 480, child: view});
        dialog.connect('closed', () => editor.destroy());
        dialog.present(this);
    }

    _showShortcuts() {
        const section = new Adw.ShortcutsSection();
        for (const [title, accelerator] of [
            [_('Apply preset 1 to 9'), '<Control>1...<Control>9'],
            [_('Refresh monitors'), '<Control>r F5'],
            [_('Edit presets'), '<Control>comma'],
            [_('Keyboard shortcuts'), '<Control>question'],
            [_('Quit'), '<Control>q'],
        ])
            section.add(new Adw.ShortcutsItem({title, accelerator}));
        const dialog = new Adw.ShortcutsDialog();
        dialog.add(section);
        dialog.present(this);
    }

    _showAbout() {
        new Adw.AboutDialog({
            application_name: _('Brightness Presets'),
            application_icon: APP_ICON,
            developer_name: 'MaksForge',
            website: REPO_URL,
            issue_url: `${REPO_URL}/issues`,
            license_type: Gtk.License.CUSTOM,
            license: _('All rights reserved, source available.'),
        }).present(this);
    }
});
