import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

import {loadSettings} from '../app/settings.js';
import {BrightnessWindow} from '../app/window.js';

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
        window.destroy();
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
    const win = new BrightnessWindow(app, settings);
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
