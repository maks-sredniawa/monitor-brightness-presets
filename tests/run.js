import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {parseBrightness, parseDisplays, parseVcp, percentToValue, valueToPercent} from '../extension/lib/ddc.js';
import {DdcutilMissingError, Monitors, NoMonitorsError} from '../extension/lib/monitors.js';
import {format} from '../extension/lib/format.js';
import {collectPresets, readPresets} from '../extension/lib/presets.js';
import {acceptedBrightness, describeProblems} from '../extension/lib/problems.js';
import {
    catchUpSlot, currentSlot, formatTime, handledAfterEdit, markHandPick, meridiem, nextChange, nextChangeLabel,
    nextFreeHour, normalizeSchedule, readSchedule, renameInSchedule, scheduleState, scheduleStatus,
} from '../extension/lib/schedule.js';

const testsDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const fakeBin = GLib.build_filenamev([testsDir, 'fake-bin']);
const systemPath = GLib.getenv('PATH');
const tests = [];
const test = (name, fn) => tests.push({name, fn});

function assertEqual(actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`expected ${e}\n       got ${a}`);
}

function useFakeDdcutil({failBus = '', getvcpFail = '', invalidDisplay = false, busyDisplay = false, laptopPanel = false, answeringDisplays = true, noContrast = '', failContrastBus = ''} = {}) {
    const [fd, log] = GLib.file_open_tmp('ddcutil-XXXXXX.log');
    GLib.close(fd);
    GLib.setenv('PATH', `${fakeBin}:${systemPath}`, true);
    GLib.setenv('FAKE_DDCUTIL_LOG', log, true);
    GLib.setenv('FAKE_DDCUTIL_FAIL_BUS', failBus, true);
    GLib.setenv('FAKE_DDCUTIL_GETVCP_FAIL', getvcpFail, true);
    GLib.setenv('FAKE_DDCUTIL_INVALID_DISPLAY', invalidDisplay ? '1' : '', true);
    GLib.setenv('FAKE_DDCUTIL_BUSY_DISPLAY', busyDisplay ? '1' : '', true);
    GLib.setenv('FAKE_DDCUTIL_LAPTOP_PANEL', laptopPanel ? '1' : '', true);
    GLib.setenv('FAKE_DDCUTIL_NO_ANSWERING_DISPLAYS', answeringDisplays ? '' : '1', true);
    GLib.setenv('FAKE_DDCUTIL_NO_CONTRAST', noContrast, true);
    GLib.setenv('FAKE_DDCUTIL_FAIL_CONTRAST_BUS', failContrastBus, true);
    return () => new TextDecoder().decode(GLib.file_get_contents(log)[1]).trim().split('\n');
}

async function rejection(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected a rejection');
}

const detections = calls => calls().filter(call => call === 'detect --terse').length;

test('parseDisplays keeps every external display with its bus, model and status', () => {
    const output = `Display 1
   I2C bus:  /dev/i2c-4
   Monitor:                 GSM:LG ULTRAGEAR:

Invalid display
   I2C bus:  /dev/i2c-7
   Monitor:                 XXX:Broken:

Display 2
   I2C bus:  /dev/i2c-6
   Monitor:                 IVM::1234

Invalid display
   I2C bus:          /dev/i2c-9
   DRM connector:    card1-DP-3

Invalid display
   I2C bus:          /dev/i2c-1
   DRM connector:    card1-eDP-1
   Monitor:          BOE:NE135FBM-N41:

Phantom display
   I2C bus:  /dev/i2c-10
   Monitor:                 GSM:LG ULTRAGEAR:

Busy display
   I2C bus:          /dev/i2c-11
   DRM_connector:    card1-DP-4
   I2C device is busy

DDC_disabled
   I2C bus:          /dev/i2c-12
   DRM_connector:    card1-HDMI-A-2
   Monitor:          DEL:U2720Q:
   DDC communication disabled

Busy display
   I2C bus:          /dev/i2c-2
   DRM_connector:    card1-eDP-2
`;
    assertEqual(parseDisplays(output), [
        {bus: 4, name: 'LG ULTRAGEAR', status: 'ok'},
        {bus: 7, name: 'Broken', status: 'invalid'},
        {bus: 6, name: 'IVM', status: 'ok'},
        {bus: 9, name: 'DP-3', status: 'invalid'},
        {bus: 11, name: 'DP-4', status: 'busy'},
        {bus: 12, name: 'U2720Q', status: 'disabled'},
    ]);
});

test('parseDisplays tells monitors of the same model apart by connector, or by bus without one', () => {
    const output = `Display 1
   I2C bus:  /dev/i2c-8
   DRM_connector:           card1-HDMI-A-1
   Monitor:                 IVM:PL2745Q:A1

Display 2
   I2C bus:  /dev/i2c-9
   DRM_connector:           card1-DP-1
   Monitor:                 IVM:PL2745Q:A2

Display 3
   I2C bus:  /dev/i2c-4
   Monitor:                 GSM:LG ULTRAGEAR:

Display 4
   I2C bus:  /dev/i2c-5
   Monitor:                 GSM:LG ULTRAGEAR:

Display 5
   I2C bus:  /dev/i2c-6
   DRM_connector:           card1-DP-2
   Monitor:                 DEL:U2720Q:
`;
    assertEqual(parseDisplays(output).map(display => display.name), [
        'PL2745Q (HDMI-A-1)',
        'PL2745Q (DP-1)',
        'LG ULTRAGEAR (I2C bus 4)',
        'LG ULTRAGEAR (I2C bus 5)',
        'U2720Q',
    ]);
});

test('parseBrightness reads current and max, or null on error', () => {
    assertEqual(parseBrightness('VCP 10 C 37 100\n'), {current: 37, max: 100});
    assertEqual(parseBrightness('VCP 10 ERR\n'), null);
});

test('percentToValue scales to the monitor maximum and clamps', () => {
    assertEqual([percentToValue(60, 100), percentToValue(60, 50), percentToValue(25, 255)], [60, 30, 64]);
    assertEqual([percentToValue(-5, 100), percentToValue(140, 100)], [0, 100]);
});

test('setBrightness sets every monitor, scaled to its maximum', async () => {
    const calls = useFakeDdcutil();
    const result = await new Monitors().setBrightness(60);
    assertEqual(result.failed, []);
    assertEqual(calls().filter(call => call.includes('setvcp')).sort(), [
        '--bus 4 setvcp 10 60',
        '--bus 6 setvcp 10 30',
    ]);
});

test('setBrightness detects once and reuses the monitor list', async () => {
    const calls = useFakeDdcutil();
    const monitors = new Monitors();
    await monitors.setBrightness(100);
    await monitors.setBrightness(25);
    assertEqual(detections(calls), 1);
});

test('quick successive presets leave the last one applied', async () => {
    const calls = useFakeDdcutil();
    const monitors = new Monitors();
    await Promise.all([10, 20, 30].map(percent => monitors.setBrightness(percent)));
    const lastForBus4 = calls().filter(call => call.startsWith('--bus 4 setvcp')).at(-1);
    assertEqual(lastForBus4, '--bus 4 setvcp 10 30');
});

test('a monitor that fails is reported and the others still change', async () => {
    const calls = useFakeDdcutil({failBus: '6'});
    const result = await new Monitors().setBrightness(50);
    assertEqual(result.failed.map(display => display.name), ['PL2745Q']);
    assertEqual(result.rejected, {6: ['brightness']});
    assertEqual(calls().includes('--bus 4 setvcp 10 50'), true);
});

test('a failed write makes the next preset detect the monitors again', async () => {
    const calls = useFakeDdcutil({failBus: '6'});
    const monitors = new Monitors();
    await monitors.setBrightness(50);
    await monitors.setBrightness(60);
    assertEqual(detections(calls), 2);
});

test('a monitor that keeps rejecting writes after a fresh detection stops causing detections', async () => {
    const calls = useFakeDdcutil({failBus: '6'});
    const monitors = new Monitors();
    for (const percent of [50, 60, 70, 80])
        await monitors.setBrightness(percent);
    assertEqual(detections(calls), 2);
});

test('a monitor that newly fails makes the next preset detect again', async () => {
    const calls = useFakeDdcutil({failBus: '6'});
    const monitors = new Monitors();
    await monitors.setBrightness(50);
    await monitors.setBrightness(60);
    GLib.setenv('FAKE_DDCUTIL_FAIL_BUS', '4', true);
    await monitors.setBrightness(70);
    await monitors.setBrightness(80);
    assertEqual(detections(calls), 3);
});

test('a monitor that does not answer is named and the others still change', async () => {
    const calls = useFakeDdcutil({getvcpFail: '6'});
    const result = await new Monitors().setBrightness(50);
    assertEqual(result.displays.map(display => display.name), ['LG ULTRAGEAR']);
    assertEqual(result.unreachable, [{bus: 6, name: 'PL2745Q', reason: 'silent'}]);
    assertEqual(calls().filter(call => call.includes('setvcp')), ['--bus 4 setvcp 10 50']);
});

test('an invalid display is named without being asked for its brightness', async () => {
    const calls = useFakeDdcutil({invalidDisplay: true});
    const result = await new Monitors().setBrightness(50);
    assertEqual(result.unreachable, [{bus: 7, name: 'DP-2', reason: 'invalid'}]);
    assertEqual(calls().some(call => call.startsWith('--bus 7')), false);
});

test('a busy display is named as busy without being asked for its brightness', async () => {
    const calls = useFakeDdcutil({busyDisplay: true});
    const result = await new Monitors().setBrightness(50);
    assertEqual(result.unreachable, [{bus: 5, name: 'DP-3', reason: 'busy'}]);
    assertEqual(calls().some(call => call.startsWith('--bus 5')), false);
});

test('a laptop panel is neither reported nor keeps the detection from being reused', async () => {
    const calls = useFakeDdcutil({laptopPanel: true});
    const monitors = new Monitors();
    const result = await monitors.setBrightness(50);
    await monitors.setBrightness(60);
    assertEqual(result.unreachable, []);
    assertEqual(calls().some(call => call.startsWith('--bus 1 ')), false);
    assertEqual(detections(calls), 1);
});

test('a busy display does not keep the detection from being reused', async () => {
    const calls = useFakeDdcutil({busyDisplay: true});
    const monitors = new Monitors();
    await monitors.setBrightness(50);
    await monitors.setBrightness(60);
    assertEqual(detections(calls), 1);
});

test('a detection with a monitor that did not answer is not reused', async () => {
    const calls = useFakeDdcutil({getvcpFail: '6'});
    const monitors = new Monitors();
    await monitors.setBrightness(50);
    await monitors.setBrightness(60);
    assertEqual(detections(calls), 2);
});

test('no monitor answering is reported as such', async () => {
    const calls = useFakeDdcutil({getvcpFail: '4 6'});
    const error = await rejection(new Monitors().setBrightness(50));
    assertEqual(error instanceof NoMonitorsError, true);
    assertEqual(calls().some(call => call.includes('setvcp')), false);
});

test('no monitor answering because every one is busy carries the busy displays', async () => {
    const calls = useFakeDdcutil({busyDisplay: true, answeringDisplays: false});
    const error = await rejection(new Monitors().setBrightness(50));
    assertEqual(error instanceof NoMonitorsError, true);
    assertEqual(error.unreachable, [{bus: 5, name: 'DP-3', reason: 'busy'}]);
    assertEqual(calls().some(call => call.startsWith('--bus 5')), false);
});

test('a missing ddcutil is reported as such', async () => {
    useFakeDdcutil();
    GLib.setenv('PATH', '/nonexistent', true);
    const error = await rejection(new Monitors().setBrightness(50));
    assertEqual(error instanceof DdcutilMissingError, true);
});

const writes = calls => calls().filter(call => call.includes('setvcp'));

test('valueToPercent turns a monitor value back into a percent of its maximum', () => {
    assertEqual([valueToPercent(30, 50), valueToPercent(64, 255), valueToPercent(5, 0)], [60, 25, 0]);
});

test('read gives every monitor its current brightness as a percent of its maximum', async () => {
    useFakeDdcutil();
    const result = await new Monitors().read();
    assertEqual(result.displays.map(({bus, name, percent}) => ({bus, name, percent})), [
        {bus: 4, name: 'LG ULTRAGEAR', percent: 70},
        {bus: 6, name: 'PL2745Q', percent: 40},
    ]);
    assertEqual(result.unreachable, []);
});

test('read names a monitor that stopped answering and detects again next time', async () => {
    const calls = useFakeDdcutil();
    const monitors = new Monitors();
    await monitors.read();
    GLib.setenv('FAKE_DDCUTIL_GETVCP_FAIL', '6', true);
    const result = await monitors.read();
    assertEqual(result.displays.map(display => display.bus), [4]);
    assertEqual(result.unreachable, [{bus: 6, name: 'PL2745Q', reason: 'silent'}]);
    await monitors.read();
    assertEqual(detections(calls), 2);
});

test('setMonitorBrightness sets only that monitor, scaled to its maximum', async () => {
    const calls = useFakeDdcutil();
    const result = await new Monitors().setMonitorBrightness(6, 60);
    assertEqual(result.displays.map(display => display.bus), [6]);
    assertEqual(result.failed, []);
    assertEqual(writes(calls), ['--bus 6 setvcp 10 30']);
});

test('setMonitorBrightness reports a monitor that rejects the write', async () => {
    useFakeDdcutil({failBus: '6'});
    const result = await new Monitors().setMonitorBrightness(6, 60);
    assertEqual(result.failed.map(display => display.name), ['PL2745Q']);
});

test('setMonitorBrightness for a monitor that is gone changes nothing', async () => {
    const calls = useFakeDdcutil();
    const result = await new Monitors().setMonitorBrightness(9, 60);
    assertEqual(result.displays, []);
    assertEqual(writes(calls), []);
});

test('dragging one slider leaves its last value applied without dropping another monitor', async () => {
    const calls = useFakeDdcutil();
    const monitors = new Monitors();
    await Promise.all([
        monitors.setMonitorBrightness(4, 10),
        monitors.setMonitorBrightness(4, 20),
        monitors.setMonitorBrightness(6, 50),
        monitors.setMonitorBrightness(4, 30),
    ]);
    assertEqual(writes(calls).filter(call => call.startsWith('--bus 4')).at(-1), '--bus 4 setvcp 10 30');
    assertEqual(writes(calls).includes('--bus 6 setvcp 10 25'), true);
});

test('a preset replaces waiting single-monitor writes and hands their callers its result', async () => {
    const calls = useFakeDdcutil();
    const monitors = new Monitors();
    const first = monitors.setBrightness(100);
    const dragged = monitors.setMonitorBrightness(6, 10);
    const preset = monitors.setBrightness(60);
    await first;
    assertEqual((await dragged).displays.length, 2);
    await preset;
    assertEqual(writes(calls).some(call => call === '--bus 6 setvcp 10 5'), false);
    assertEqual(writes(calls).slice(-2).sort(), ['--bus 4 setvcp 10 60', '--bus 6 setvcp 10 30']);
});

test('a single-monitor write after a waiting preset still applies after it', async () => {
    const calls = useFakeDdcutil();
    const monitors = new Monitors();
    await Promise.all([
        monitors.setBrightness(100),
        monitors.setBrightness(60),
        monitors.setMonitorBrightness(6, 10),
    ]);
    assertEqual(writes(calls).at(-1), '--bus 6 setvcp 10 5');
});

test('reads wait for writes so ddcutil never talks to a monitor twice at once', async () => {
    const calls = useFakeDdcutil();
    const monitors = new Monitors();
    await monitors.read();
    const before = calls().length;
    await Promise.all([monitors.setBrightness(60), monitors.read()]);
    assertEqual(calls().slice(before).map(call => call.split(' ')[2]), ['setvcp', 'setvcp', 'getvcp', 'getvcp', 'getvcp', 'getvcp']);
});

test('a failed job does not stop the ones queued behind it', async () => {
    useFakeDdcutil();
    const monitors = new Monitors();
    GLib.setenv('PATH', '/nonexistent', true);
    const failing = rejection(monitors.setBrightness(50));
    GLib.setenv('PATH', `${fakeBin}:${systemPath}`, true);
    const next = monitors.setMonitorBrightness(4, 30);
    assertEqual((await failing) instanceof DdcutilMissingError, true);
    assertEqual((await next).failed, []);
});

test('parseVcp reads any feature by its code', () => {
    assertEqual(parseVcp('VCP 12 C 80 100\n', '12'), {current: 80, max: 100});
    assertEqual(parseVcp('VCP 10 C 80 100\n', '12'), null);
});

test('read gives each monitor its contrast too, scaled to its own maximum', async () => {
    useFakeDdcutil();
    const result = await new Monitors().read();
    assertEqual(result.displays.map(({bus, contrastPercent}) => [bus, contrastPercent]), [[4, 50], [6, 50]]);
});

test('a monitor without contrast reads as such and is still controllable', async () => {
    useFakeDdcutil({noContrast: '6'});
    const result = await new Monitors().read();
    assertEqual(result.displays.map(({bus, contrastPercent}) => [bus, contrastPercent]), [[4, 50], [6, null]]);
    assertEqual(result.unreachable, []);
});

test('a preset with contrast sets brightness then contrast on every monitor, scaled', async () => {
    const calls = useFakeDdcutil();
    const result = await new Monitors().apply({brightness: 60, contrast: 40});
    assertEqual(result.failed, []);
    assertEqual(writes(calls).sort(), [
        '--bus 4 setvcp 10 60', '--bus 4 setvcp 12 40', '--bus 6 setvcp 10 30', '--bus 6 setvcp 12 24',
    ]);
});

test('a preset with contrast skips contrast on a monitor without it', async () => {
    const calls = useFakeDdcutil({noContrast: '6'});
    const result = await new Monitors().apply({brightness: 60, contrast: 40});
    assertEqual(result.failed, []);
    assertEqual(writes(calls).filter(call => call.startsWith('--bus 6')), ['--bus 6 setvcp 10 30']);
});

test('a monitor that rejects a contrast write is reported', async () => {
    useFakeDdcutil({failContrastBus: '6'});
    const result = await new Monitors().apply({brightness: 60, contrast: 40});
    assertEqual(result.failed.map(display => display.bus), [6]);
    assertEqual(result.rejected, {6: ['contrast']});
});

test('setMonitorContrast sets only that monitor contrast', async () => {
    const calls = useFakeDdcutil();
    await new Monitors().setMonitorContrast(6, 50);
    assertEqual(writes(calls), ['--bus 6 setvcp 12 30']);
});

test('a brightness-only preset does not swallow a waiting contrast write', async () => {
    const calls = useFakeDdcutil();
    const monitors = new Monitors();
    await Promise.all([
        monitors.setBrightness(100),
        monitors.setMonitorContrast(4, 20),
        monitors.setBrightness(60),
    ]);
    assertEqual(writes(calls).includes('--bus 4 setvcp 12 20'), true);
});

test('a preset with contrast replaces a waiting contrast drag', async () => {
    const calls = useFakeDdcutil();
    const monitors = new Monitors();
    await Promise.all([
        monitors.setBrightness(100),
        monitors.setMonitorContrast(4, 20),
        monitors.apply({brightness: 60, contrast: 70}),
    ]);
    assertEqual(writes(calls).includes('--bus 4 setvcp 12 20'), false);
});

test('a preset without contrast does not swallow a waiting contrast drag', async () => {
    const calls = useFakeDdcutil();
    const monitors = new Monitors();
    await Promise.all([
        monitors.setBrightness(100),
        monitors.setMonitorContrast(4, 20),
        monitors.apply({brightness: 60, contrast: null}),
    ]);
    assertEqual(writes(calls).includes('--bus 4 setvcp 12 20'), true);
});

function memorySettings() {
    const schemaDir = GLib.build_filenamev([testsDir, '..', 'extension', 'schemas']);
    const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, null, false);
    return new Gio.Settings({
        settings_schema: source.lookup('org.gnome.shell.extensions.monitor-brightness-presets', false),
        backend: Gio.memory_settings_backend_new(),
    });
}

test('presets saved before contrast existed read back without contrast', () => {
    const settings = memorySettings();
    settings.set_value('presets', new GLib.Variant('a(si)', [['Day', 100], ['Night', 25]]));
    assertEqual(readPresets(settings), [
        {name: 'Day', brightness: 100, contrast: null},
        {name: 'Night', brightness: 25, contrast: null},
    ]);
});

test('a preset contrast is read back by name', () => {
    const settings = memorySettings();
    settings.set_value('preset-contrast', new GLib.Variant('a{si}', {Day: 70}));
    assertEqual(readPresets(settings).map(preset => preset.contrast), [70, null, null]);
});

test('collectPresets saves contrast only for named rows that have one', () => {
    const rows = [{name: 'Day', percent: 100, contrast: 70}, {name: 'Night', percent: 25, contrast: null}, {name: '', percent: 5, contrast: 10}];
    assertEqual(collectPresets(rows).contrasts, {Day: 70});
});

const row = (name, percent) => ({name, percent});

test('renaming the active preset carries the active preset over', () => {
    const night = row('Late', 25);
    const result = collectPresets([row('Day', 100), night], night);
    assertEqual(result.presets, [['Day', 100], ['Late', 25]]);
    assertEqual(result.active, 'Late');
});

test('a preset whose name is cleared is unticked, and ticked again when it is retyped', () => {
    const night = row('', 25);
    const rows = [row('Day', 100), night];
    assertEqual(collectPresets(rows, night).presets, [['Day', 100]]);
    assertEqual(collectPresets(rows, night).active, '');
    night.name = 'Night';
    assertEqual(collectPresets(rows, night).active, 'Night');
});

test('a duplicate name is flagged and not saved', () => {
    const rows = [row('Day', 100), row('Day', 25)];
    const result = collectPresets(rows);
    assertEqual(result.presets, [['Day', 100]]);
    assertEqual([...result.duplicates].map(r => r.percent), [25]);
    assertEqual(result.saved.map(r => r.percent), [100]);
});

test('typing the active name into a row above it ticks neither, until the clash is gone', () => {
    const day = row('Night', 100);
    const night = row('Night', 25);
    const rows = [day, night];
    assertEqual(collectPresets(rows, night).active, '');
    day.name = 'Day';
    assertEqual(collectPresets(rows, night).active, 'Night');
});

test('naming a new preset does not mark it active when none is', () => {
    assertEqual(collectPresets([row('Day', 100), row('Dusk', 40)]).active, '');
});

test('format fills %s and %d in order and keeps a literal percent', () => {
    assertEqual(format('%s, brightness %d%%, contrast %d%%', 'Evening', 60, 80), 'Evening, brightness 60%, contrast 80%');
});

const ngettext = (singular, plural, count) => count === 1 ? singular : plural;
const lg = {bus: 4, name: 'LG'};
const pl = {bus: 6, name: 'PL'};
const dell = {bus: 7, name: 'Dell'};

test('a preset ticks when at least one monitor took its brightness, whatever its contrast did', () => {
    assertEqual(acceptedBrightness([lg, pl], {6: ['contrast'], 4: ['contrast']}), true);
    assertEqual(acceptedBrightness([lg, pl], {4: ['brightness'], 6: ['brightness', 'contrast']}), false);
    assertEqual(acceptedBrightness([], {}), false);
});

test('rejected brightness keeps its sentence unchanged', () => {
    assertEqual(describeProblems(ngettext, [pl], {6: ['brightness']}, []),
        'PL did not change its brightness. Its own menu may be locking it, for example an ECO mode or picture preset.');
});

test('rejected contrast gets its own sentence, in the plural for several monitors', () => {
    assertEqual(describeProblems(ngettext, [lg, pl], {4: ['contrast'], 6: ['contrast']}, []),
        'LG and PL did not change their contrast. Their own menus may be locking them, for example an ECO mode or picture preset.');
});

test('a monitor that rejected both is named only in the sentence for both', () => {
    assertEqual(describeProblems(ngettext, [lg, pl, dell], {4: ['brightness'], 6: ['brightness', 'contrast'], 7: ['contrast']}, [{name: 'DP-3', reason: 'busy'}]), [
        'LG did not change its brightness. Its own menu may be locking it, for example an ECO mode or picture preset.',
        'Dell did not change its contrast. Its own menu may be locking it, for example an ECO mode or picture preset.',
        'PL did not change its brightness or contrast. Its own menu may be locking them, for example an ECO mode or picture preset.',
        'DP-3 is in use by another program, such as the ddcci kernel module, so it was left as it is.',
    ].join(' '));
});

const WARSAW = GLib.TimeZone.new_identifier('Europe/Warsaw');
const at = (month, day, hour, minute, second = 0) => GLib.DateTime.new(WARSAW, 2026, month, day, hour, minute, second);
const unix = (...args) => at(...args).to_unix();
const DAY_EVENING_NIGHT = normalizeSchedule([[450, 'Day'], [1080, 'Evening'], [1350, 'Night']]);
const ALL = ['Day', 'Evening', 'Night'];
const slotOf = slot => slot && [slot.preset, slot.at];

test('normalizeSchedule sorts by time, drops times outside the day and keeps the first of equal times', () => {
    assertEqual(normalizeSchedule([[1350, 'Night'], [450, 'Day'], [-1, 'Bad'], [1440, 'Late'], [450, 'Dup'], [12.5, 'Half'], [0, 'Midnight']]), [
        {minutes: 0, preset: 'Midnight'},
        {minutes: 450, preset: 'Day'},
        {minutes: 1350, preset: 'Night'},
    ]);
});

test('readSchedule tolerates a hand-edited key', () => {
    const settings = memorySettings();
    settings.set_value('schedule', new GLib.Variant('a(is)', [[1350, 'Night'], [450, 'Day'], [450, 'Other'], [5000, 'Never']]));
    assertEqual(readSchedule(settings), [{minutes: 450, preset: 'Day'}, {minutes: 1350, preset: 'Night'}]);
    assertEqual(readSchedule(memorySettings()), []);
});

test('the current slot is the latest time at or before now', () => {
    assertEqual(slotOf(currentSlot(DAY_EVENING_NIGHT, ALL, at(6, 10, 12, 0))), ['Day', unix(6, 10, 7, 30)]);
    assertEqual(slotOf(currentSlot(DAY_EVENING_NIGHT, ALL, at(6, 10, 18, 0))), ['Evening', unix(6, 10, 18, 0)]);
    assertEqual(slotOf(currentSlot(DAY_EVENING_NIGHT, ALL, at(6, 10, 17, 59, 59))), ['Day', unix(6, 10, 7, 30)]);
});

test('the current slot wraps past midnight to yesterday’s last time', () => {
    assertEqual(slotOf(currentSlot(DAY_EVENING_NIGHT, ALL, at(6, 10, 3, 0))), ['Night', unix(6, 9, 22, 30)]);
    assertEqual(slotOf(currentSlot(DAY_EVENING_NIGHT, ALL, at(6, 10, 0, 0))), ['Night', unix(6, 9, 22, 30)]);
    assertEqual(slotOf(currentSlot(DAY_EVENING_NIGHT, ALL, at(6, 1, 3, 0))), ['Night', unix(5, 31, 22, 30)]);
});

test('a single time is the current slot all day and the next change every day', () => {
    const one = normalizeSchedule([[1080, 'Evening']]);
    assertEqual(slotOf(currentSlot(one, ALL, at(6, 10, 9, 0))), ['Evening', unix(6, 9, 18, 0)]);
    assertEqual(slotOf(currentSlot(one, ALL, at(6, 10, 19, 0))), ['Evening', unix(6, 10, 18, 0)]);
    assertEqual(slotOf(nextChange(one, ALL, at(6, 10, 9, 0))), ['Evening', unix(6, 10, 18, 0)]);
    assertEqual(slotOf(nextChange(one, ALL, at(6, 10, 18, 0))), ['Evening', unix(6, 11, 18, 0)]);
});

test('an empty schedule has no slot and no next change', () => {
    assertEqual(currentSlot([], ALL, at(6, 10, 12, 0)), null);
    assertEqual(nextChange([], ALL, at(6, 10, 12, 0)), null);
    assertEqual(catchUpSlot({enabled: true, entries: [], names: ALL, handled: 0, now: at(6, 10, 12, 0)}), null);
});

test('the next change is strictly after now and wraps to tomorrow', () => {
    assertEqual(slotOf(nextChange(DAY_EVENING_NIGHT, ALL, at(6, 10, 12, 0))), ['Evening', unix(6, 10, 18, 0)]);
    assertEqual(slotOf(nextChange(DAY_EVENING_NIGHT, ALL, at(6, 10, 18, 0))), ['Night', unix(6, 10, 22, 30)]);
    assertEqual(slotOf(nextChange(DAY_EVENING_NIGHT, ALL, at(6, 10, 23, 0))), ['Day', unix(6, 11, 7, 30)]);
});

test('a time whose preset was removed is skipped: the slot falls back to the time before it', () => {
    const names = ['Day', 'Night'];
    assertEqual(slotOf(currentSlot(DAY_EVENING_NIGHT, names, at(6, 10, 19, 0))), ['Day', unix(6, 10, 7, 30)]);
    assertEqual(slotOf(nextChange(DAY_EVENING_NIGHT, names, at(6, 10, 12, 0))), ['Night', unix(6, 10, 22, 30)]);
    assertEqual(currentSlot(DAY_EVENING_NIGHT, [], at(6, 10, 19, 0)), null);
    assertEqual(nextChange(DAY_EVENING_NIGHT, ['Other'], at(6, 10, 19, 0)), null);
});

test('local time follows daylight saving: the wall-clock time is kept across the change', () => {
    const entries = normalizeSchedule([[150, 'Gap'], [480, 'Day'], [1350, 'Night']]);
    const names = ['Gap', 'Day', 'Night'];
    const springNight = at(3, 29, 1, 0);
    assertEqual(nextChange(entries, names, springNight).preset, 'Gap');
    assertEqual(nextChange(entries, names, at(3, 29, 3, 30)).at - at(3, 29, 3, 30).to_unix(), (8 - 3.5) * 3600);
    assertEqual(unix(3, 29, 8, 0) - springNight.to_unix(), 6 * 3600);
    const gapSlot = currentSlot(entries, names, at(3, 29, 3, 30));
    assertEqual(gapSlot.preset, 'Gap');
    assertEqual(gapSlot.at <= at(3, 29, 3, 30).to_unix(), true);
    assertEqual(slotOf(currentSlot(entries, names, at(10, 25, 12, 0))), ['Day', unix(10, 25, 8, 0)]);
    assertEqual(unix(10, 25, 8, 0) - unix(10, 24, 22, 30), 10.5 * 3600);
    assertEqual(slotOf(currentSlot(entries, names, at(10, 25, 1, 0))), ['Night', unix(10, 24, 22, 30)]);
});

test('catch-up applies the current slot only when its time is later than the last one handled', () => {
    const state = {enabled: true, entries: DAY_EVENING_NIGHT, names: ALL};
    const evening = unix(6, 10, 18, 0);
    assertEqual(slotOf(catchUpSlot({...state, handled: unix(6, 10, 7, 30), now: at(6, 10, 19, 0)})), ['Evening', evening]);
    assertEqual(catchUpSlot({...state, handled: evening, now: at(6, 10, 19, 0)}), null);
    assertEqual(catchUpSlot({...state, enabled: false, handled: 0, now: at(6, 10, 19, 0)}), null);
});

test('a preset picked by hand stays until the next scheduled time, then catch-up takes over', () => {
    const state = {enabled: true, entries: DAY_EVENING_NIGHT, names: ALL};
    const pickedDuringEvening = unix(6, 10, 18, 0);
    assertEqual(catchUpSlot({...state, handled: pickedDuringEvening, now: at(6, 10, 22, 29)}), null);
    assertEqual(slotOf(catchUpSlot({...state, handled: pickedDuringEvening, now: at(6, 10, 22, 31)})), ['Night', unix(6, 10, 22, 30)]);
    assertEqual(slotOf(catchUpSlot({...state, handled: unix(6, 9, 22, 30), now: at(6, 11, 8, 0)})), ['Day', unix(6, 11, 7, 30)]);
});

test('a hand pick marks the current slot handled, so a later catch-up skips it until the next time', () => {
    const settings = memorySettings();
    settings.set_value('schedule', new GLib.Variant('a(is)', [[450, 'Day'], [1080, 'Evening'], [1350, 'Night']]));
    settings.set_int64('schedule-handled', unix(6, 10, 7, 30));
    markHandPick(settings, at(6, 10, 19, 0));
    assertEqual(settings.get_int64('schedule-handled'), unix(6, 10, 7, 30));

    settings.set_boolean('schedule-enabled', true);
    markHandPick(settings, at(6, 10, 19, 0));
    assertEqual(settings.get_int64('schedule-handled'), unix(6, 10, 18, 0));
    assertEqual(catchUpSlot(scheduleState(settings, at(6, 10, 21, 0))), null);
    assertEqual(slotOf(catchUpSlot(scheduleState(settings, at(6, 10, 22, 31)))), ['Night', unix(6, 10, 22, 30)]);

    markHandPick(settings, at(6, 10, 18, 30));
    assertEqual(settings.get_int64('schedule-handled'), unix(6, 10, 18, 0));
});

test('editing the schedule keeps the current period handled unless a catch-up was still due', () => {
    const slot = at => ({at});
    assertEqual(handledAfterEdit({handled: 100, before: slot(100), after: slot(150)}), 150);
    assertEqual(handledAfterEdit({handled: 100, before: null, after: slot(150)}), 150);
    assertEqual(handledAfterEdit({handled: 100, before: slot(120), after: slot(150)}), 100);
    assertEqual(handledAfterEdit({handled: 100, before: slot(100), after: slot(80)}), 100);
    assertEqual(handledAfterEdit({handled: 100, before: slot(100), after: null}), 100);
});

test('a new time defaults to the next full hour that is free, wrapping past midnight', () => {
    assertEqual(nextFreeHour([], at(6, 10, 13, 20)), 14 * 60);
    assertEqual(nextFreeHour([{minutes: 840}], at(6, 10, 13, 20)), 15 * 60);
    assertEqual(nextFreeHour([], at(6, 10, 23, 10)), 0);
    const full = Array.from({length: 24}, (_v, hour) => ({minutes: hour * 60}));
    assertEqual(nextFreeHour(full, at(6, 10, 13, 20)), 14 * 60);
});

test('formatTime shows 24 h with leading zeros and 12 h with AM/PM, never an empty one', () => {
    assertEqual([formatTime(450, '24h'), formatTime(0, '24h'), formatTime(1439, '24h')], ['07:30', '00:00', '23:59']);
    assertEqual(formatTime(450, '12h'), `7:30 ${meridiem(7)}`);
    assertEqual(formatTime(1350, '12h'), `10:30 ${meridiem(22)}`);
    assertEqual([formatTime(0, '12h'), formatTime(720, '12h')], [`12:00 ${meridiem(0)}`, `12:00 ${meridiem(12)}`]);
    assertEqual(meridiem(0) !== '' && meridiem(0) !== meridiem(12), true);
});

test('the status line says what the schedule will do next', () => {
    const _ = text => text;
    const base = {enabled: true, entries: DAY_EVENING_NIGHT, names: ALL, now: at(6, 10, 12, 0), clockFormat: '24h'};
    assertEqual(scheduleStatus({...base, enabled: false}, _), 'Changes presets at set times');
    assertEqual(scheduleStatus(base, _), 'Next: Evening at 18:00');
    assertEqual(scheduleStatus({...base, entries: []}, _), 'No times set');
    assertEqual(scheduleStatus({...base, names: ['Other']}, _), 'Every time points at a removed preset');
    assertEqual(scheduleStatus({...base, extensionActive: false}, _), 'Needs the Monitor brightness presets extension turned on');
    assertEqual(scheduleStatus({...base, extensionActive: null}, _), 'Next: Evening at 18:00');
    assertEqual(nextChangeLabel({...base, now: at(6, 10, 23, 0)}, _), 'Next: Day at 07:30');
    assertEqual(nextChangeLabel({...base, enabled: false}, _), null);
    assertEqual(nextChangeLabel({...base, names: []}, _), null);
});

const named = (name, savedName = name) => ({name, savedName, percent: 50});

test('renaming a saved preset is reported as a rename from the name it was saved under', () => {
    assertEqual(collectPresets([named('Day'), named('Late', 'Night')]).renames, {Night: 'Late'});
    assertEqual(collectPresets([named('Day'), named('Night')]).renames, {});
});

test('a preset whose name is cleared keeps its old name until it is saved again', () => {
    const night = named('', 'Night');
    assertEqual(collectPresets([named('Day'), night]).renames, {});
    night.name = 'Late';
    assertEqual(collectPresets([named('Day'), night]).renames, {Night: 'Late'});
});

test('a duplicate is not renamed, and a name another preset took over is not carried away', () => {
    assertEqual(collectPresets([named('Day'), named('Day', 'Night')]).renames, {});
    assertEqual(collectPresets([named('Night', 'Day'), named('Dusk', 'Night')]).renames, {Day: 'Night'});
    assertEqual(collectPresets([named('Night'), named('Dusk', 'Night')]).renames, {});
    assertEqual(collectPresets([named('New', '')]).renames, {});
});

test('renameInSchedule moves every time of a renamed preset and leaves the rest', () => {
    const raw = [[450, 'Day'], [1080, 'Evening'], [1200, 'Day'], [1350, 'Gone']];
    assertEqual(renameInSchedule(raw, {Day: 'Daylight', Gone: 'Back'}), [[450, 'Daylight'], [1080, 'Evening'], [1200, 'Daylight'], [1350, 'Back']]);
    assertEqual(renameInSchedule(raw, {Day: 'Evening', Evening: 'Day'}), [[450, 'Evening'], [1080, 'Day'], [1200, 'Evening'], [1350, 'Gone']]);
});

const loop = new GLib.MainLoop(null, false);
let failures = 0;
(async () => {
    for (const {name, fn} of tests) {
        try {
            await fn();
            print(`ok   ${name}`);
        } catch (error) {
            failures++;
            print(`FAIL ${name}\n     ${error.message}`);
        }
    }
    print(`\n${tests.length - failures}/${tests.length} passed`);
    loop.quit();
})();
loop.run();
System.exit(failures ? 1 : 0);
