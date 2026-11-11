import GLib from 'gi://GLib';
import System from 'system';

import {parseBrightness, parseDisplays, percentToValue} from '../extension/lib/ddc.js';
import {DdcutilMissingError, Monitors} from '../extension/lib/monitors.js';

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

function useFakeDdcutil({failBus = ''} = {}) {
    const [fd, log] = GLib.file_open_tmp('ddcutil-XXXXXX.log');
    GLib.close(fd);
    GLib.setenv('PATH', `${fakeBin}:${systemPath}`, true);
    GLib.setenv('FAKE_DDCUTIL_LOG', log, true);
    GLib.setenv('FAKE_DDCUTIL_FAIL_BUS', failBus, true);
    return () => new TextDecoder().decode(GLib.file_get_contents(log)[1]).trim().split('\n');
}

test('parseDisplays keeps valid displays with their bus and model', () => {
    const output = `Display 1
   I2C bus:  /dev/i2c-4
   Monitor:                 GSM:LG ULTRAGEAR:

Invalid display
   I2C bus:  /dev/i2c-7
   Monitor:                 XXX:Broken:

Display 2
   I2C bus:  /dev/i2c-6
   Monitor:                 IVM::1234
`;
    assertEqual(parseDisplays(output), [{bus: 4, name: 'LG ULTRAGEAR'}, {bus: 6, name: 'IVM'}]);
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
    assertEqual(calls().filter(call => call === 'detect --terse').length, 1);
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

test('a missing ddcutil is reported as such', async () => {
    useFakeDdcutil();
    GLib.setenv('PATH', '/nonexistent', true);
    try {
        await new Monitors().setBrightness(50);
    } catch (error) {
        assertEqual(error instanceof DdcutilMissingError, true);
        return;
    }
    throw new Error('expected DdcutilMissingError');
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
