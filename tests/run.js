import GLib from 'gi://GLib';
import System from 'system';

import {parseBrightness, parseDisplays, percentToValue} from '../extension/lib/ddc.js';
import {DdcutilMissingError, Monitors, NoMonitorsError} from '../extension/lib/monitors.js';
import {collectPresets} from '../extension/lib/presets.js';

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

function useFakeDdcutil({failBus = '', getvcpFail = '', invalidDisplay = false, busyDisplay = false, laptopPanel = false, answeringDisplays = true} = {}) {
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
