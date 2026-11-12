import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseBrightness, parseDisplays, percentToValue} from './ddc.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export class DdcutilMissingError extends Error {}

export class NoMonitorsError extends Error {
    constructor(unreachable) {
        super('No monitor answered over DDC/CI');
        this.unreachable = unreachable;
    }
}

export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

async function ddcutil(args, cancellable) {
    let proc;
    try {
        proc = Gio.Subprocess.new(['ddcutil', ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (error) {
        if (error.matches(GLib.SpawnError, GLib.SpawnError.NOENT))
            throw new DdcutilMissingError('ddcutil is not installed');
        throw error;
    }
    const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
    if (!proc.get_successful())
        throw new Error(stderr.trim() || stdout.trim() || `ddcutil ${args.join(' ')} failed`);
    return stdout;
}

// A silent, invalid or DDC-disabled monitor may be waking up or just had DDC/CI
// turned on in its menu, so only a bus another driver holds is worth skipping
// until the monitor layout changes.
function isHeldByAnotherDriver(display) {
    return display.reason === 'busy';
}

export class Monitors {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._detection = null;
        this._failingBuses = new Set();
        this._applying = null;
        this._pendingPercent = null;
    }

    forget() {
        this._detection = null;
    }

    async list() {
        if (this._detection)
            return this._detection;
        const detection = await this._detect();
        if (detection.unreachable.every(isHeldByAnotherDriver))
            this._detection = detection;
        return detection;
    }

    async _detect() {
        const detected = parseDisplays(await ddcutil(['detect', '--terse'], this._cancellable));
        const maxima = await Promise.all(detected.map(display =>
            display.status === 'ok' ? this._readMax(display.bus) : null));
        const displays = [];
        const unreachable = [];
        detected.forEach(({bus, name, status}, i) => {
            if (maxima[i] === null)
                unreachable.push({bus, name, reason: status === 'ok' ? 'silent' : status});
            else
                displays.push({bus, name, max: maxima[i]});
        });
        if (displays.length === 0)
            throw new NoMonitorsError(unreachable);
        return {displays, unreachable};
    }

    async _readMax(bus) {
        try {
            const output = await ddcutil(['--bus', `${bus}`, 'getvcp', '10', '--brief'], this._cancellable);
            return parseBrightness(output)?.max ?? null;
        } catch (error) {
            if (isCancelled(error))
                throw error;
            return null;
        }
    }

    // Clicking presets in quick succession must leave the last one applied, so
    // runs are serialised and only the newest waiting percent is kept.
    setBrightness(percent) {
        this._pendingPercent = percent;
        this._applying ??= this._drain().finally(() => {
            this._applying = null;
        });
        return this._applying;
    }

    async _drain() {
        let result;
        while (this._pendingPercent !== null) {
            const percent = this._pendingPercent;
            this._pendingPercent = null;
            result = await this._setAll(percent);
        }
        return result;
    }

    async _setAll(percent) {
        const {displays, unreachable} = await this.list();
        const outcomes = await Promise.allSettled(displays.map(display =>
            ddcutil(['--bus', `${display.bus}`, 'setvcp', '10',
                `${percentToValue(percent, display.max)}`], this._cancellable)));
        const failed = displays.filter((_display, i) => outcomes[i].status === 'rejected');
        // A monitor that rejects writes on a fresh detection too is ignoring DDC writes,
        // not sitting on a stale bus, so detecting again for it would only slow every pick.
        if (failed.some(display => !this._failingBuses.has(display.bus)))
            this.forget();
        this._failingBuses = new Set(failed.map(display => display.bus));
        return {displays, failed, unreachable};
    }

    destroy() {
        this._cancellable.cancel();
    }
}
