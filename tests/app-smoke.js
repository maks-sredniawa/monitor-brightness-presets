import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

import {loadSettings} from '../app/settings.js';
import {BrightnessWindow} from '../app/window.js';
import {currentSlot, formatTime, nextFreeHour, readSchedule, scheduleState} from '../extension/lib/schedule.js';

const testsDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const fakeBin = GLib.build_filenamev([testsDir, 'fake-bin']);
const systemPath = GLib.getenv('PATH');
const [fd, log] = GLib.file_open_tmp('ddcutil-smoke-XXXXXX.log');
GLib.close(fd);
GLib.setenv('FAKE_DDCUTIL_LOG', log, true);

function useFake(env = {}) {
    GLib.setenv('PATH', `${fakeBin}:${systemPath}`, true);
    for (const name of ['FAIL_BUS', 'GETVCP_FAIL', 'BUSY_DISPLAY', 'NO_ANSWERING_DISPLAYS', 'NO_CONTRAST', 'FAIL_CONTRAST_BUS'])
        GLib.setenv(`FAKE_DDCUTIL_${name}`, env[name] ?? '', true);
    GLib.file_set_contents(log, '');
}

const calls = () => new TextDecoder().decode(GLib.file_get_contents(log)[1]).trim().split('\n').filter(Boolean);
const writes = () => calls().filter(call => call.includes('setvcp'));

function assertEqual(actual, expected, what) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${what}: expected ${e}, got ${a}`);
}

function until(condition, what, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const started = GLib.get_monotonic_time();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            if (condition()) {
                resolve();
                return GLib.SOURCE_REMOVE;
            }
            if (GLib.get_monotonic_time() - started > timeoutMs * 1000) {
                reject(new Error(`timed out waiting for ${what}`));
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    });
}

const children = list => {
    const rows = [];
    for (let row = list.get_first_child(); row; row = row.get_next_sibling())
        rows.push(row);
    return rows;
};
const monitorState = win => [...win._monitorRows.values()].map(row => [row.title, row.percent, row.note !== null]);
const marks = win => win._presetRows.map(({name, mark}) => `${name}:${mark.visible_child_name}`);
const settled = win => win._refreshAction.enabled;

const extension = {onChange: null, rechecks: 0};
const fakeExtensionWatch = onChange => {
    extension.onChange = onChange;
    return {recheck: () => extension.rechecks++, destroy: () => (extension.onChange = null)};
};

const steps = [];
const step = (name, fn) => steps.push({name, fn});

step('loads every monitor with its current brightness', async (win, settings) => {
    await until(() => settled(win) && win._monitorRows.size === 2, 'monitors');
    assertEqual(monitorState(win), [['LG ULTRAGEAR', 70, false], ['PL2745Q', 40, false]], 'rows');
    assertEqual(marks(win), ['Day:none', 'Evening:none', 'Night:none'], 'marks');
    assertEqual(win._contrastSlots.get_widgets().length, 0, 'no contrast slots without a preset contrast');
    assertEqual(settings.get_string('active-preset'), '', 'active preset');
});

step('a preset row sets every monitor, ticks itself and moves the sliders', async (win, settings) => {
    GLib.file_set_contents(log, '');
    children(win._presetList)[2].emit('activated');
    await until(() => settings.get_string('active-preset') === 'Night', 'active preset');
    assertEqual(writes().sort(), ['--bus 4 setvcp 10 25', '--bus 6 setvcp 10 13'], 'writes');
    assertEqual(marks(win), ['Day:none', 'Evening:none', 'Night:check'], 'marks');
    assertEqual(monitorState(win), [['LG ULTRAGEAR', 25, false], ['PL2745Q', 25, false]], 'rows');
});

step('moving one slider sets only that monitor and clears the active preset', async (win, settings) => {
    GLib.file_set_contents(log, '');
    win._monitorRows.get(4)._brightness.scale.set_value(55);
    await until(() => settings.get_string('active-preset') === '', 'cleared preset');
    assertEqual(writes(), ['--bus 4 setvcp 10 55'], 'writes');
    assertEqual(marks(win), ['Day:none', 'Evening:none', 'Night:none'], 'marks');
});

step('a pick made elsewhere ticks the preset and reads the monitors back without writing', async (win, settings) => {
    GLib.file_set_contents(log, '');
    settings.set_string('active-preset', 'Evening');
    await until(() => win._monitorRows.get(4).percent === 70 && win._monitorRows.get(6).percent === 40, 'sliders read back');
    assertEqual(marks(win), ['Day:none', 'Evening:check', 'Night:none'], 'marks');
    assertEqual(writes(), [], 'writes');
});

step('a slider moved while a preset is being written keeps its own value', async (win, settings) => {
    GLib.file_set_contents(log, '');
    children(win._presetList)[2].emit('activated');
    win._monitorRows.get(4)._brightness.scale.set_value(80);
    await until(() => win._pendingPreset === null && settings.get_string('active-preset') === '' &&
        writes().includes('--bus 4 setvcp 10 80'), 'both writes');
    assertEqual(monitorState(win), [['LG ULTRAGEAR', 80, false], ['PL2745Q', 25, false]], 'rows');
    assertEqual(writes().filter(call => call.startsWith('--bus 4 ')).at(-1), '--bus 4 setvcp 10 80', 'last bus 4 write');
});

step('a monitor that rejects a write keeps its slider, shows the note and is read back', async (win, settings) => {
    useFake({FAIL_BUS: '6'});
    children(win._presetList)[0].emit('activated');
    await until(() => win._monitorRows.get(6).note !== null && settings.get_string('active-preset') === 'Day', 'note');
    await until(() => win._monitorRows.get(6).percent === 40, 'read back');
    assertEqual(win._monitorRows.get(4).percent, 100, 'other monitor');
});

step('a pick made elsewhere keeps the note on a monitor that is not at that preset', async (win, settings) => {
    settings.set_string('active-preset', 'Evening');
    await until(() => win._monitorRows.get(4).percent === 70, 'read back');
    assertEqual(win._monitorRows.get(6).note !== null, true, 'note kept');
});

step('a pick made elsewhere that the monitor shows clears its note', async (win, settings) => {
    settings.set_value('presets', new GLib.Variant('a(si)', [['Day', 100], ['Forty', 40]]));
    settings.set_string('active-preset', 'Forty');
    await until(() => win._monitorRows.get(6).note === null, 'note cleared');
    assertEqual(win._monitorRows.get(6).percent, 40, 'slider');
});

step('re-picking the active preset elsewhere clears the note of a monitor at it once the window is active again', async (win, settings) => {
    const [lg, pl] = [win._monitorRows.get(4), win._monitorRows.get(6)];
    lg.setRejected('brightness', true);
    pl.setRejected('brightness', true);
    lg.percent = pl.percent = 10;
    settings.set_string('active-preset', 'Forty');
    assertEqual(win.is_active, true, 'window active');
    win.notify('is-active');
    await until(() => pl.note === null, 'note cleared');
    await until(() => lg.percent === 70, 'other slider read back');
    assertEqual([pl.percent, lg.note !== null], [40, true], 'monitor at the preset cleared, other kept');
});

step('editing presets in the app rebuilds the preset rows', async (win, settings) => {
    win.activate_action('edit-presets', null);
    await until(() => win.get_visible_dialog() !== null, 'edit dialog');
    settings.set_value('presets', new GLib.Variant('a(si)', [['Day', 100], ['Dim', 10]]));
    await until(() => win._presetRows.length === 2, 'rebuilt rows');
    assertEqual(win._presetRows.map(row => row.name), ['Day', 'Dim'], 'names');
    win.get_visible_dialog().force_close();
});

step('Ctrl+2 applies the second preset', async (win, settings) => {
    useFake();
    win.activate_action('apply-preset', new GLib.Variant('i', 2));
    await until(() => settings.get_string('active-preset') === 'Dim', 'Dim applied');
    assertEqual(writes().sort(), ['--bus 4 setvcp 10 10', '--bus 6 setvcp 10 5'], 'writes');
});

step('the shortcuts and about dialogs open', async win => {
    win.activate_action('shortcuts', null);
    await until(() => win.get_visible_dialog() instanceof Adw.ShortcutsDialog, 'shortcuts');
    win.get_visible_dialog().force_close();
    win.activate_action('about', null);
    await until(() => win.get_visible_dialog() instanceof Adw.AboutDialog, 'about');
    win.get_visible_dialog().force_close();
});

step('a busy monitor is listed with its hint and no slider', async win => {
    useFake({BUSY_DISPLAY: '1'});
    win.activate_action('refresh', null);
    await until(() => settled(win) && children(win._monitorList).length === 3, 'three rows');
    const busy = children(win._monitorList)[2];
    assertEqual([busy.title, busy.subtitle.startsWith('In use by another program')], ['DP-3', true], 'busy row');
    assertEqual(win._presetsGroup.sensitive, true, 'presets usable');
});

step('monitors that all cannot be controlled stay listed and presets are disabled', async win => {
    useFake({BUSY_DISPLAY: '1', NO_ANSWERING_DISPLAYS: '1'});
    win.activate_action('refresh', null);
    await until(() => settled(win) && children(win._monitorList).length === 1, 'one row');
    assertEqual(win._stack.visible_child_name, 'content', 'page');
    assertEqual(win._presetsGroup.sensitive, false, 'presets disabled');
});

step('no monitor at all shows the status page', async win => {
    useFake({NO_ANSWERING_DISPLAYS: '1'});
    win.activate_action('refresh', null);
    await until(() => settled(win) && win._stack.visible_child_name === 'status', 'status page');
    assertEqual(win._status.title, 'No Monitor Answered', 'title');
});

step('a missing ddcutil shows the install page, and Try Again recovers', async win => {
    GLib.setenv('PATH', '/nonexistent', true);
    win.activate_action('refresh', null);
    await until(() => settled(win) && win._status.title === 'ddcutil Is Not Installed', 'install page');
    useFake();
    win.activate_action('refresh', null);
    await until(() => settled(win) && win._stack.visible_child_name === 'content' && win._monitorRows.size === 2, 'recovered');
    assertEqual(win._presetsGroup.sensitive, true, 'presets usable');
});

const NOTES = {
    contrast: 'Did not change its contrast. Its own menu may be locking it, for example an ECO mode or picture preset.',
    both: 'Did not change its brightness or contrast. Its own menu may be locking them, for example an ECO mode or picture preset.',
};
const contrasts = win => [...win._monitorRows.values()].map(row => row.contrast);
const contrastWrites = () => writes().filter(call => call.includes('setvcp 12'));

function descendants(widget, type) {
    const found = [];
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        if (child instanceof type)
            found.push(child);
        found.push(...descendants(child, type));
    }
    return found;
}

step('every monitor shows its contrast under its brightness', async win => {
    assertEqual(contrasts(win), [50, 50], 'contrast sliders');
    assertEqual([...win._monitorRows.values()].map(row => row._noContrast.visible), [false, false], 'no caption');
});

step('a contrast slider sets only that monitor contrast and clears the active preset', async (win, settings) => {
    settings.set_string('active-preset', 'Day');
    await until(() => settled(win) && marks(win)[0] === 'Day:check', 'Day ticked');
    GLib.file_set_contents(log, '');
    win._monitorRows.get(6)._contrast.scale.set_value(80);
    await until(() => settings.get_string('active-preset') === '', 'cleared preset');
    assertEqual(writes(), ['--bus 6 setvcp 12 48'], 'writes');
    assertEqual(contrasts(win), [50, 80], 'contrast sliders');
});

step('a preset with contrast moves the contrast sliders and writes contrast', async (win, settings) => {
    settings.set_value('preset-contrast', new GLib.Variant('a{si}', {Movie: 70}));
    settings.set_value('presets', new GLib.Variant('a(si)', [['Day', 100], ['Movie', 40]]));
    await until(() => win._presetRows.map(row => row.name).join() === 'Day,Movie', 'preset rows');
    assertEqual(win._contrastSlots.get_widgets().length, 2, 'contrast slots');
    GLib.file_set_contents(log, '');
    children(win._presetList)[1].emit('activated');
    await until(() => settings.get_string('active-preset') === 'Movie' && win._pendingPreset === null, 'Movie applied');
    assertEqual(writes().sort(), ['--bus 4 setvcp 10 40', '--bus 4 setvcp 12 70', '--bus 6 setvcp 10 20', '--bus 6 setvcp 12 42'], 'writes');
    assertEqual(contrasts(win), [70, 70], 'contrast sliders');
});

step('a preset without contrast leaves the contrast sliders where they are', async (win, settings) => {
    GLib.file_set_contents(log, '');
    children(win._presetList)[0].emit('activated');
    await until(() => settings.get_string('active-preset') === 'Day' && win._pendingPreset === null, 'Day applied');
    assertEqual(contrastWrites(), [], 'contrast writes');
    assertEqual(contrasts(win), [70, 70], 'contrast sliders');
});

step('a rejected contrast write shows the contrast note and reads the real contrast back', async win => {
    useFake({FAIL_CONTRAST_BUS: '6'});
    const pl = win._monitorRows.get(6);
    pl._contrast.scale.set_value(20);
    await until(() => pl.note === NOTES.contrast, 'contrast note');
    await until(() => pl.contrast === 50, 'contrast read back');
    assertEqual(win._monitorRows.get(4).note, null, 'other monitor');
});

step('a monitor that rejects both writes of a preset shows one note for both, and the preset still ticks', async (win, settings) => {
    useFake({FAIL_BUS: '6', FAIL_CONTRAST_BUS: '6'});
    children(win._presetList)[1].emit('activated');
    await until(() => win._monitorRows.get(6).note === NOTES.both && settings.get_string('active-preset') === 'Movie', 'both note');
    assertEqual(win._monitorRows.get(4).note, null, 'other monitor');
});

step('a successful brightness write clears only the brightness half of the note', async win => {
    useFake({FAIL_CONTRAST_BUS: '6'});
    win._monitorRows.get(6)._brightness.scale.set_value(65);
    await until(() => win._monitorRows.get(6).note === NOTES.contrast, 'contrast note left');
});

step('a monitor without contrast control shows the caption, no contrast slider, and presets skip it', async (win, settings) => {
    useFake({NO_CONTRAST: '6'});
    win.activate_action('refresh', null);
    await until(() => settled(win) && win._monitorRows.size === 2, 'refreshed');
    const pl = win._monitorRows.get(6);
    assertEqual([pl._noContrast.visible, pl._contrast.box.visible, pl.contrast, pl.note], [true, false, null, null], 'row');
    settings.set_string('active-preset', '');
    GLib.file_set_contents(log, '');
    children(win._presetList)[1].emit('activated');
    await until(() => settings.get_string('active-preset') === 'Movie' && win._pendingPreset === null, 'Movie applied');
    assertEqual(contrastWrites(), ['--bus 4 setvcp 12 70'], 'contrast writes');
    assertEqual(pl.note, null, 'no note');
});

step('the editor sets, renames and clears a preset contrast, writing both keys together', async (win, settings) => {
    useFake();
    win.activate_action('edit-presets', null);
    await until(() => win.get_visible_dialog() !== null, 'edit dialog');
    const dialog = win.get_visible_dialog();
    const [day, movie] = descendants(dialog, Adw.EntryRow);
    const [dayButton] = descendants(day, Gtk.MenuButton);
    const [movieButton] = descendants(movie, Gtk.MenuButton);
    assertEqual(descendants(movieButton, Gtk.Switch)[0].active, true, 'Movie contrast on');
    const pairs = [];
    const watch = settings.connect('changed::presets', () => pairs.push([
        settings.get_value('presets').deepUnpack().map(([name]) => name).join(),
        JSON.stringify(settings.get_value('preset-contrast').deepUnpack()),
    ]));
    try {
        dayButton.popup();
        await until(() => dayButton.popover.visible, 'popover');
        const [toggle] = descendants(dayButton.popover, Gtk.Switch);
        const [spin] = descendants(dayButton.popover, Gtk.SpinButton);
        assertEqual(toggle.has_focus, true, 'switch focused');
        toggle.active = true;
        assertEqual(settings.get_value('preset-contrast').deepUnpack(), {Day: 50, Movie: 70}, 'turned on at 50');
        spin.value = 23;
        assertEqual(settings.get_value('preset-contrast').deepUnpack(), {Day: 23, Movie: 70}, 'typed 23');
        dayButton.popdown();
        day.text = 'Daylight';
        assertEqual(settings.get_value('preset-contrast').deepUnpack(), {Daylight: 23, Movie: 70}, 'rename carries it');
        assertEqual(pairs.at(-1), ['Daylight,Movie', '{"Daylight":23,"Movie":70}'], 'both keys in one write');
        toggle.active = false;
        assertEqual(settings.get_value('preset-contrast').deepUnpack(), {Movie: 70}, 'cleared');
        toggle.active = true;
        assertEqual(settings.get_value('preset-contrast').deepUnpack(), {Daylight: 23, Movie: 70}, 'switch back on restores it');
        descendants(movie, Gtk.Button).find(button => button.icon_name === 'user-trash-symbolic').emit('clicked');
        assertEqual(settings.get_value('preset-contrast').deepUnpack(), {Daylight: 23}, 'removed with its preset');
    } finally {
        settings.disconnect(watch);
        dialog.force_close();
    }
    await until(() => win._presetRows.map(row => row.name).join() === 'Daylight', 'preset rows follow');
});

const PRESETS = [['Day', 100], ['Evening', 60], ['Night', 25]];
const schedule = settings => readSchedule(settings).map(({minutes, preset}) => [minutes, preset]);
const setSchedule = (settings, raw) => settings.set_value('schedule', new GLib.Variant('a(is)', raw));
const scheduleDialog = async win => {
    win.activate_action('edit-schedule', null);
    await until(() => win.get_visible_dialog()?.title === 'Schedule', 'schedule dialog');
    return win.get_visible_dialog();
};
const timeRows = dialog => descendants(dialog, Adw.ComboRow);
const placeholders = dialog => descendants(dialog, Adw.ActionRow).filter(row => row.constructor.$gtype === Adw.ActionRow.$gtype);
const timeButton = row => descendants(row, Gtk.MenuButton)[0];
const buttonWith = (widget, icon) => descendants(widget, Gtk.Button).find(button => button.icon_name === icon);
const comboItems = row => Array.from({length: row.model.get_n_items()}, (_v, i) => row.model.get_string(i));
const hhmm = minutes => formatTime(minutes, '24h');
const minutesFromNow = offset => {
    const now = GLib.DateTime.new_now_local();
    return (now.get_hour() * 60 + now.get_minute() + offset + 1440) % 1440;
};

const holdsFocus = widget => {
    const focus = widget.get_root()?.get_focus();
    return focus === widget || (focus?.is_ancestor(widget) ?? false);
};

async function setTime(row, minutes) {
    const button = timeButton(row);
    button.popup();
    await until(() => button.popover.visible, 'time popover');
    const [hour, minute] = descendants(button.popover, Gtk.SpinButton);
    assertEqual(holdsFocus(hour), true, 'hour spin focused');
    hour.value = Math.floor(minutes / 60);
    minute.value = minutes % 60;
    assertEqual(button.label, hhmm(minutes), 'label follows the spins');
    button.popdown();
    await until(() => !button.popover.visible, 'popover closed');
}

step('the main window shows the schedule between presets and monitors, off by default', async (win, settings) => {
    settings.set_value('presets', new GLib.Variant('a(si)', PRESETS));
    settings.set_value('preset-contrast', new GLib.Variant('a{si}', {}));
    const titles = descendants(win._stack.get_child_by_name('content'), Adw.PreferencesGroup).map(group => group.title);
    assertEqual(titles, ['Presets', 'Schedule', 'Monitors'], 'groups');
    assertEqual([win._scheduleRow.title, win._scheduleRow.active, win._scheduleRow.subtitle],
        ['Follow Schedule', false, 'Changes presets at set times'], 'switch row');
    assertEqual(win.default_height, 740, 'window height');
});

step('the schedule switch turns the schedule on and the status shows what comes next', async (win, settings) => {
    win._scheduleRow.active = true;
    assertEqual(settings.get_boolean('schedule-enabled'), true, 'setting');
    assertEqual(win._scheduleRow.subtitle, 'No times set', 'no times');
    const soon = minutesFromNow(120);
    setSchedule(settings, [[soon, 'Night']]);
    assertEqual(win._scheduleRow.subtitle, `Next: Night at ${hhmm(soon)}`, 'next change');
    setSchedule(settings, [[soon, 'Gone']]);
    assertEqual(win._scheduleRow.subtitle, 'Every time points at a removed preset', 'only removed');
    settings.set_boolean('schedule-enabled', false);
    assertEqual([win._scheduleRow.active, win._scheduleRow.subtitle], [false, 'Changes presets at set times'], 'off again');
});

step('the status says when the extension that runs the schedule is off', async win => {
    extension.onChange(false);
    assertEqual(win._scheduleRow.subtitle, 'Needs the Monitor brightness presets extension turned on', 'extension off');
    extension.onChange(null);
    assertEqual(win._scheduleRow.subtitle, 'Changes presets at set times', 'unknown is not shown as off');
    extension.onChange(true);
    assertEqual(win._scheduleRow.subtitle, 'Changes presets at set times', 'extension on');
    const before = extension.rechecks;
    win.notify('is-active');
    assertEqual(extension.rechecks, before + 1, 'rechecked when the window is active again');
});

step('the schedule dialog starts empty and adds a time at the next free hour, opening its time picker', async (win, settings) => {
    setSchedule(settings, []);
    const dialog = await scheduleDialog(win);
    try {
        assertEqual(placeholders(dialog).map(row => [row.title, row.subtitle]), [['No times', 'Add one with the add button above.']], 'empty state');
        const add = buttonWith(dialog, 'list-add-symbolic');
        assertEqual([add.sensitive, add.tooltip_text], [true, 'Add time'], 'add button');
        add.emit('clicked');
        const expected = nextFreeHour([], GLib.DateTime.new_now_local());
        assertEqual(schedule(settings), [[expected, 'Day']], 'saved at once');
        assertEqual(placeholders(dialog).length, 0, 'placeholder gone');
        const [row] = timeRows(dialog);
        await until(() => timeButton(row).popover.visible, 'time popover opened');
        timeButton(row).popdown();
        assertEqual([timeButton(row).label, comboItems(row), row.selected], [hhmm(expected), ['Day', 'Evening', 'Night'], 0], 'row');
    } finally {
        dialog.force_close();
    }
});

step('changing a time saves it when the picker closes and keeps the rows sorted', async (win, settings) => {
    setSchedule(settings, [[450, 'Day'], [1350, 'Night']]);
    const dialog = await scheduleDialog(win);
    try {
        const [day] = timeRows(dialog);
        const writes = [];
        const watch = settings.connect('changed::schedule', () => writes.push(schedule(settings)));
        try {
            await setTime(day, 23 * 60 + 15);
        } finally {
            settings.disconnect(watch);
        }
        assertEqual(writes, [[[1350, 'Night'], [1395, 'Day']]], 'one write, on close');
        assertEqual(timeRows(dialog).map(row => timeButton(row).label), ['22:30', '23:15'], 'sorted rows');
        assertEqual(holdsFocus(timeButton(day)), true, 'focus back on the time button');
    } finally {
        dialog.force_close();
    }
});

step('a duplicate time is flagged and not saved until it changes', async (win, settings) => {
    setSchedule(settings, [[450, 'Day'], [1350, 'Night']]);
    const dialog = await scheduleDialog(win);
    try {
        const [, night] = timeRows(dialog);
        await setTime(night, 450);
        const [first, second] = timeRows(dialog);
        assertEqual([first.selected, second.selected], [0, 2], 'the row that had the time first stays on top');
        assertEqual([timeButton(first).has_css_class('error'), timeButton(second).has_css_class('error')], [false, true], 'flag');
        assertEqual(timeButton(second).tooltip_text, 'Another time in the list is the same, so this one is not saved.', 'tooltip');
        assertEqual(schedule(settings), [[450, 'Day']], 'saved');
        await setTime(second, 1200);
        assertEqual(timeButton(timeRows(dialog)[1]).has_css_class('error'), false, 'flag cleared');
        assertEqual(schedule(settings), [[450, 'Day'], [1200, 'Night']], 'saved once unique');
    } finally {
        dialog.force_close();
    }
});

step('picking a preset saves it and removing a time drops it', async (win, settings) => {
    setSchedule(settings, [[450, 'Day'], [1350, 'Night']]);
    const dialog = await scheduleDialog(win);
    try {
        timeRows(dialog)[0].selected = 1;
        assertEqual(schedule(settings), [[450, 'Evening'], [1350, 'Night']], 'preset changed');
        buttonWith(timeRows(dialog)[1], 'user-trash-symbolic').emit('clicked');
        assertEqual(schedule(settings), [[450, 'Evening']], 'removed');
        assertEqual(timeRows(dialog).length, 1, 'rows');
        buttonWith(timeRows(dialog)[0], 'user-trash-symbolic').emit('clicked');
        assertEqual(placeholders(dialog).map(row => row.title), ['No times'], 'empty again');
    } finally {
        dialog.force_close();
    }
});

step('a time whose preset was removed is shown as removed, stays saved and is repaired by picking a preset', async (win, settings) => {
    setSchedule(settings, [[450, 'Day'], [1080, 'Reading']]);
    const dialog = await scheduleDialog(win);
    try {
        const reading = timeRows(dialog)[1];
        const warning = descendants(reading, Gtk.Image).find(image => image.icon_name === 'dialog-warning-symbolic');
        assertEqual([comboItems(reading), reading.selected, warning.visible, warning.tooltip_text],
            [['Reading (removed)', 'Day', 'Evening', 'Night'], 0, true, 'This preset was removed, so this time is skipped.'], 'removed row');
        assertEqual(warning.visible, true, 'warning');
        assertEqual(warning.visible && !descendants(timeRows(dialog)[0], Gtk.Image).find(image => image.icon_name === 'dialog-warning-symbolic').visible, true, 'only on the removed row');
        settings.set_boolean('schedule-enabled', true);
        assertEqual(win._scheduleRow.subtitle.startsWith('Next: Day at 07:30'), true, 'status skips it');
        settings.set_boolean('schedule-enabled', false);
        reading.selected = 3;
        assertEqual(schedule(settings), [[450, 'Day'], [1080, 'Night']], 'repaired');
        await until(() => comboItems(reading).length === 3 && !warning.visible, 'removed item dropped');
        assertEqual(reading.selected, 2, 'selection kept');
    } finally {
        dialog.force_close();
    }
});

step('with no presets the schedule says so and cannot add, but keeps the times', async (win, settings) => {
    setSchedule(settings, [[450, 'Day']]);
    const dialog = await scheduleDialog(win);
    try {
        settings.set_value('presets', new GLib.Variant('a(si)', []));
        assertEqual(placeholders(dialog).map(row => [row.title, row.subtitle]), [['No presets to schedule', 'Add a preset first.']], 'placeholder');
        assertEqual(buttonWith(dialog, 'list-add-symbolic').sensitive, false, 'add disabled');
        assertEqual(comboItems(timeRows(dialog)[0]), ['Day (removed)'], 'time kept as removed');
        settings.set_value('presets', new GLib.Variant('a(si)', PRESETS));
        assertEqual([placeholders(dialog).length, buttonWith(dialog, 'list-add-symbolic').sensitive], [0, true], 'back');
        assertEqual(schedule(settings), [[450, 'Day']], 'schedule untouched');
    } finally {
        dialog.force_close();
    }
});

step('renaming a preset carries its times along, in the same write as the presets', async (win, settings) => {
    setSchedule(settings, [[450, 'Day'], [1080, 'Evening'], [1200, 'Day']]);
    win.activate_action('edit-presets', null);
    await until(() => win.get_visible_dialog() !== null, 'edit dialog');
    const dialog = win.get_visible_dialog();
    const pairs = [];
    const watch = settings.connect('changed::presets', () => pairs.push([
        settings.get_value('presets').deepUnpack().map(([name]) => name).join(),
        schedule(settings).map(([, preset]) => preset).join(),
    ]));
    try {
        const [day] = descendants(dialog, Adw.EntryRow);
        day.text = '';
        assertEqual(schedule(settings).map(([, preset]) => preset), ['Day', 'Evening', 'Day'], 'kept while unnamed');
        day.text = 'Daylight';
        assertEqual(pairs.at(-1), ['Daylight,Evening,Night', 'Daylight,Evening,Daylight'], 'carried in one write');
        descendants(dialog, Adw.EntryRow)[1].text = 'Daylight';
        assertEqual(schedule(settings).map(([, preset]) => preset), ['Daylight', 'Evening', 'Daylight'], 'a duplicate carries nothing');
        descendants(dialog, Adw.EntryRow)[1].text = 'Evening';
        buttonWith(descendants(dialog, Adw.EntryRow)[1], 'user-trash-symbolic').emit('clicked');
        assertEqual(schedule(settings).map(([, preset]) => preset), ['Daylight', 'Evening', 'Daylight'], 'removing leaves its times');
    } finally {
        settings.disconnect(watch);
        dialog.force_close();
    }
    settings.set_value('presets', new GLib.Variant('a(si)', PRESETS));
});

step('a preset picked by hand while the schedule is on marks the current time as handled', async (win, settings) => {
    useFake();
    const earlier = minutesFromNow(-60);
    setSchedule(settings, [[earlier, 'Day']]);
    settings.set_int64('schedule-handled', 0);
    children(win._presetList)[2].emit('activated');
    await until(() => settings.get_string('active-preset') === 'Night' && win._pendingPreset === null, 'Night applied');
    assertEqual(settings.get_int64('schedule-handled'), 0, 'schedule off: untouched');
    settings.set_boolean('schedule-enabled', true);
    children(win._presetList)[1].emit('activated');
    await until(() => settings.get_string('active-preset') === 'Evening' && win._pendingPreset === null, 'Evening applied');
    const state = scheduleState(settings, GLib.DateTime.new_now_local());
    assertEqual(settings.get_int64('schedule-handled'), currentSlot(state.entries, state.names, state.now).at, 'handled');
    settings.set_boolean('schedule-enabled', false);
});

step('the shortcuts dialog lists Edit schedule', async win => {
    win.activate_action('shortcuts', null);
    await until(() => win.get_visible_dialog() instanceof Adw.ShortcutsDialog, 'shortcuts');
    const items = descendants(win.get_visible_dialog(), Gtk.Widget).filter(widget => widget instanceof Adw.ShortcutsItem);
    win.get_visible_dialog().force_close();
    if (items.length > 0)
        assertEqual(items.some(item => item.title === 'Edit schedule'), true, 'item');
});

step('the extension preferences window builds the presets editor', async (win, settings) => {
    const extensionDir = GLib.build_filenamev([testsDir, '..', 'extension']);
    const dir = GLib.dir_make_tmp('prefs-smoke-XXXXXX');
    const stub = GLib.build_filenamev([dir, 'stub.js']);
    GLib.file_set_contents(stub, `import {loadSettings} from '${GLib.filename_to_uri(GLib.build_filenamev([testsDir, '..', 'app', 'settings.js']), null)}';
export const gettext = text => text;
export class ExtensionPreferences {
    getSettings() {
        return loadSettings();
    }
}
`);
    const source = new TextDecoder().decode(GLib.file_get_contents(GLib.build_filenamev([extensionDir, 'prefs.js']))[1])
        .replace(/'resource:\/\/\/org\/gnome\/Shell\/Extensions\/js\/extensions\/prefs\.js'/, `'${GLib.filename_to_uri(stub, null)}'`)
        .replaceAll("'./lib/", `'${GLib.filename_to_uri(extensionDir, null)}/lib/`);
    const prefs = GLib.build_filenamev([dir, 'prefs.js']);
    GLib.file_set_contents(prefs, source);
    try {
        const {default: Preferences} = await import(GLib.filename_to_uri(prefs, null));
        const window = new Adw.PreferencesWindow();
        new Preferences().fillPreferencesWindow(window);
        const rows = descendants(window, Adw.EntryRow);
        assertEqual(rows.map(row => row.text), settings.get_value('presets').deepUnpack().map(([name]) => name), 'editor rows');
        assertEqual(rows.map(row => descendants(row, Gtk.MenuButton).length), rows.map(() => 1), 'contrast buttons');
        const groups = descendants(window, Adw.PreferencesGroup);
        assertEqual(groups.map(group => group.title).filter(Boolean), ['Presets', 'Schedule'], 'groups on one page');
        const [toggle] = descendants(groups[1], Adw.SwitchRow);
        assertEqual([toggle.title, toggle.subtitle], ['Follow Schedule', 'Changes presets at set times'], 'schedule switch');
        assertEqual(descendants(groups[1], Adw.ComboRow).length, readSchedule(settings).length, 'schedule rows');
        window.close();
    } finally {
        for (const file of [stub, prefs])
            GLib.unlink(file);
        GLib.rmdir(dir);
    }
});

useFake();
let failures = 0;
const app = new Adw.Application({application_id: 'com.maksforge.MonitorBrightnessPresets.Smoke'});
app.connect('activate', async () => {
    const settings = loadSettings();
    const win = new BrightnessWindow(app, settings, {watchExtensionState: fakeExtensionWatch});
    win.present();
    for (const {name, fn} of steps) {
        try {
            await fn(win, settings);
            print(`ok   ${name}`);
        } catch (error) {
            failures++;
            print(`FAIL ${name}\n     ${error.message}`);
        }
    }
    print(`\n${steps.length - failures}/${steps.length} passed`);
    win.close();
    app.quit();
});
app.run([System.programInvocationName]);
GLib.unlink(log);
System.exit(failures ? 1 : 0);
