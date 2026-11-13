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
    for (const name of ['FAIL_BUS', 'GETVCP_FAIL', 'BUSY_DISPLAY', 'NO_ANSWERING_DISPLAYS'])
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
    win._monitorRows.get(4)._scale.set_value(55);
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
    win._monitorRows.get(4)._scale.set_value(80);
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
