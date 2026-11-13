import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {format} from './format.js';
import {readPresets} from './presets.js';
import {
    clockFormat, formatTime, interfaceSettings, meridiem, msUntil, nextChange, nextFreeHour, normalizeSchedule,
    readSchedule, scheduleState, scheduleStatus, scheduleVariant,
} from './schedule.js';

const STATUS_KEYS = ['schedule', 'presets', 'schedule-enabled'];

export function watchStatus(settings, _, {extensionActive = () => null, onText}) {
    const clock = interfaceSettings();
    let timer = 0;
    const sync = () => {
        if (timer)
            GLib.source_remove(timer);
        timer = 0;
        const now = GLib.DateTime.new_now_local();
        const state = scheduleState(settings, now);
        onText(scheduleStatus({...state, clockFormat: clockFormat(clock), extensionActive: extensionActive()}, _));
        const next = state.enabled ? nextChange(state.entries, state.names, now) : null;
        if (next) {
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, msUntil(next.at, now) + 500, () => {
                timer = 0;
                sync();
                return GLib.SOURCE_REMOVE;
            });
        }
    };
    const handlers = STATUS_KEYS.map(key => settings.connect(`changed::${key}`, sync));
    const clockHandler = clock?.connect('changed::clock-format', sync);
    sync();
    return {
        sync,
        destroy: () => {
            handlers.forEach(id => settings.disconnect(id));
            if (clockHandler)
                clock.disconnect(clockHandler);
            if (timer)
                GLib.source_remove(timer);
            timer = 0;
        },
    };
}

function padded(spin) {
    spin.connect('output', () => {
        spin.text = String(spin.get_value_as_int()).padStart(2, '0');
        return true;
    });
}

function buildTimePicker(minutes, twelveHour, onChange, _) {
    const hour = new Gtk.SpinButton({
        orientation: Gtk.Orientation.VERTICAL,
        adjustment: new Gtk.Adjustment({lower: twelveHour ? 1 : 0, upper: twelveHour ? 12 : 23, step_increment: 1, page_increment: 3}),
        wrap: true,
        numeric: true,
        width_chars: 2,
    });
    const minute = new Gtk.SpinButton({
        orientation: Gtk.Orientation.VERTICAL,
        adjustment: new Gtk.Adjustment({lower: 0, upper: 59, step_increment: 5, page_increment: 15}),
        wrap: true,
        numeric: true,
        width_chars: 2,
    });
    hour.update_property([Gtk.AccessibleProperty.LABEL], [_('Hour')]);
    minute.update_property([Gtk.AccessibleProperty.LABEL], [_('Minute')]);
    if (!twelveHour)
        padded(hour);
    padded(minute);

    const box = new Gtk.Box({spacing: 6, margin_start: 12, margin_end: 12, margin_top: 12, margin_bottom: 12});
    box.append(hour);
    box.append(new Gtk.Label({label: ':'}));
    box.append(minute);
    let halfDay = null;
    if (twelveHour) {
        halfDay = new Adw.ToggleGroup({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, margin_start: 6});
        halfDay.add(new Adw.Toggle({name: 'am', label: meridiem(0)}));
        halfDay.add(new Adw.Toggle({name: 'pm', label: meridiem(12)}));
        box.append(halfDay);
    }

    const hours = Math.floor(minutes / 60);
    hour.value = twelveHour ? hours % 12 || 12 : hours;
    minute.value = minutes % 60;
    if (halfDay)
        halfDay.active_name = hours >= 12 ? 'pm' : 'am';

    const current = () => {
        let value = hour.get_value_as_int();
        if (halfDay)
            value = value % 12 + (halfDay.active_name === 'pm' ? 12 : 0);
        return value * 60 + minute.get_value_as_int();
    };
    hour.connect('value-changed', () => onChange(current()));
    minute.connect('value-changed', () => onChange(current()));
    halfDay?.connect('notify::active-name', () => onChange(current()));

    const popover = new Gtk.Popover({child: box});
    popover.connect('show', () => hour.grab_focus());
    return {popover, current, hour, minute, halfDay};
}

export function buildScheduleEditor(settings, _, {extensionActive = () => null} = {}) {
    const removedNote = _('This preset was removed, so this time is skipped.');
    const group = new Adw.PreferencesGroup({
        title: _('Schedule'),
        description: _('Applies a preset at set times, every day. A preset picked by hand stays until the next time. A time that is already in the list is not saved.'),
    });
    const add = new Gtk.Button({
        icon_name: 'list-add-symbolic',
        tooltip_text: _('Add time'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    group.set_header_suffix(add);

    const toggle = new Adw.SwitchRow({title: _('Follow Schedule'), use_markup: false});
    settings.bind('schedule-enabled', toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
    const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    list.append(toggle);
    group.add(list);
    const status = watchStatus(settings, _, {extensionActive, onText: text => (toggle.subtitle = text)});

    const clock = interfaceSettings();
    let rows = [];
    let placeholder = null;
    const shown = new Set();
    let openPopovers = 0;
    let rebuildWhenClosed = false;
    let syncing = false;

    const presetNames = () => readPresets(settings).map(preset => preset.name);

    const savedRows = () => {
        const seen = new Set();
        return rows.filter(row => {
            if (seen.has(row.minutes))
                return false;
            seen.add(row.minutes);
            return true;
        });
    };
    const written = () => normalizeSchedule(savedRows().map(row => [row.minutes, row.preset]));

    const duplicateNote = _('Another time in the list is the same, so this one is not saved.');
    const flagDuplicates = () => {
        const saved = new Set(savedRows());
        for (const row of rows) {
            if (saved.has(row)) {
                row.button.remove_css_class('error');
                row.button.tooltip_text = null;
                row.button.reset_state(Gtk.AccessibleState.INVALID);
                row.button.reset_property(Gtk.AccessibleProperty.DESCRIPTION);
                row.combo.subtitle = '';
            } else {
                row.button.add_css_class('error');
                row.button.tooltip_text = duplicateNote;
                row.button.update_state([Gtk.AccessibleState.INVALID], [Gtk.AccessibleInvalidState.TRUE]);
                row.button.update_property([Gtk.AccessibleProperty.DESCRIPTION], [duplicateNote]);
                row.combo.subtitle = _('Same time as above, not saved');
            }
        }
    };

    const save = () => {
        flagDuplicates();
        settings.set_value('schedule', scheduleVariant(written()));
    };

    const showTime = (row, minutes) => {
        const text = formatTime(minutes, clockFormat(clock));
        row.button.label = text;
        row.button.update_property([Gtk.AccessibleProperty.LABEL], [format(_('Time, %s'), text)]);
        row.combo.update_property([Gtk.AccessibleProperty.LABEL], [format(_('Preset at %s'), text)]);
        row.remove.update_property([Gtk.AccessibleProperty.LABEL], [format(_('Remove %s'), text)]);
    };

    const fillCombo = row => {
        const names = presetNames();
        row.missing = !names.includes(row.preset);
        row.choices = names;
        syncing = true;
        const items = row.missing ? [format(_('%s (removed)'), row.preset), ...names] : names;
        row.items.splice(0, row.items.get_n_items(), items);
        row.combo.selected = row.missing ? 0 : names.indexOf(row.preset);
        syncing = false;
        row.warning.visible = row.missing;
        if (row.missing)
            row.combo.update_property([Gtk.AccessibleProperty.DESCRIPTION], [removedNote]);
        else
            row.combo.reset_property(Gtk.AccessibleProperty.DESCRIPTION);
    };

    const position = widget => {
        if (widget === toggle)
            return -2;
        if (widget === placeholder)
            return -1;
        return rows.findIndex(row => row.combo === widget);
    };
    list.set_sort_func((a, b) => position(a) - position(b));

    const layout = () => {
        const combos = new Set(rows.map(row => row.combo));
        for (const combo of shown) {
            if (!combos.has(combo)) {
                list.remove(combo);
                shown.delete(combo);
            }
        }
        for (const combo of combos) {
            if (!shown.has(combo)) {
                list.append(combo);
                shown.add(combo);
            }
        }

        const hasPresets = presetNames().length > 0;
        add.sensitive = hasPresets;
        const [title, subtitle] = !hasPresets ? [_('No presets to schedule'), _('Add a preset first.')]
            : rows.length === 0 ? [_('No times'), _('Add one with the add button above.')] : [null, null];
        if (title && !placeholder) {
            placeholder = new Adw.ActionRow({title, subtitle});
            list.append(placeholder);
        } else if (title) {
            placeholder.set({title, subtitle});
        } else if (placeholder) {
            list.remove(placeholder);
            placeholder = null;
        }
        list.invalidate_sort();
    };

    const insertSorted = row => {
        const after = rows.findLastIndex(other => other.minutes <= row.minutes);
        rows.splice(after + 1, 0, row);
    };

    const afterPopover = () => {
        openPopovers--;
        if (openPopovers === 0 && rebuildWhenClosed) {
            rebuildWhenClosed = false;
            rebuild(readSchedule(settings));
        }
    };

    const buildRow = (minutes, preset) => {
        const row = {minutes, preset};
        row.items = new Gtk.StringList();
        row.combo = new Adw.ComboRow({use_subtitle: false, model: row.items});
        row.remove = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: _('Remove time'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });

        const picker = buildTimePicker(minutes, clockFormat(clock) === '12h', value => showTime(row, value), _);
        row.picker = picker;
        row.button = new Gtk.MenuButton({popover: picker.popover, valign: Gtk.Align.CENTER, css_classes: ['flat', 'numeric']});
        showTime(row, minutes);
        row.combo.add_prefix(row.button);

        row.warning = new Gtk.Image({
            icon_name: 'dialog-warning-symbolic',
            tooltip_text: removedNote,
            valign: Gtk.Align.CENTER,
            css_classes: ['warning'],
            accessible_role: Gtk.AccessibleRole.PRESENTATION,
        });
        row.combo.add_suffix(row.warning);
        row.combo.add_suffix(row.remove);
        fillCombo(row);

        picker.popover.connect('show', () => openPopovers++);
        picker.popover.connect('closed', () => {
            const value = picker.current();
            if (value !== row.minutes && rows.includes(row)) {
                row.minutes = value;
                rows.splice(rows.indexOf(row), 1);
                insertSorted(row);
                layout();
                save();
                row.button.grab_focus();
            }
            afterPopover();
        });
        row.combo.connect('notify::selected', () => {
            if (syncing)
                return;
            const offset = row.missing ? 1 : 0;
            const index = row.combo.selected;
            if (index === Gtk.INVALID_LIST_POSITION || index < offset)
                return;
            row.preset = row.choices[index - offset];
            save();
            if (row.missing) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (rows.includes(row))
                        fillCombo(row);
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        row.remove.connect('clicked', () => {
            const index = rows.indexOf(row);
            rows.splice(index, 1);
            const neighbour = rows[index] ?? rows[index - 1];
            layout();
            save();
            (neighbour?.combo ?? add).grab_focus();
        });
        return row;
    };

    const rebuild = entries => {
        rows = entries.map(({minutes, preset}) => buildRow(minutes, preset));
        layout();
        flagDuplicates();
    };

    add.connect('clicked', () => {
        const names = presetNames();
        if (names.length === 0)
            return;
        const row = buildRow(nextFreeHour(rows, GLib.DateTime.new_now_local()), names[0]);
        insertSorted(row);
        layout();
        save();
        if (row.button.get_mapped()) {
            row.button.popup();
            return;
        }
        const mapped = row.button.connect('map', () => {
            row.button.disconnect(mapped);
            row.button.popup();
        });
    });

    const followSchedule = () => {
        const incoming = readSchedule(settings);
        if (JSON.stringify(incoming) === JSON.stringify(written()))
            return;
        if (openPopovers > 0)
            rebuildWhenClosed = true;
        else
            rebuild(incoming);
    };
    const followPresets = () => {
        for (const row of rows)
            fillCombo(row);
        layout();
    };
    const followClock = () => {
        if (openPopovers > 0)
            rebuildWhenClosed = true;
        else
            rebuild(rows.map(({minutes, preset}) => ({minutes, preset})));
    };

    rebuild(readSchedule(settings));
    const handlers = [
        settings.connect('changed::schedule', followSchedule),
        settings.connect('changed::presets', followPresets),
    ];
    const clockHandler = clock?.connect('changed::clock-format', followClock);

    return {
        group,
        syncStatus: status.sync,
        destroy: () => {
            handlers.forEach(id => settings.disconnect(id));
            if (clockHandler)
                clock.disconnect(clockHandler);
            status.destroy();
        },
    };
}
