import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseBrightness, parseDisplays, percentToValue} from './ddc.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export class DdcutilMissingError extends Error {}

export class NoMonitorsError extends Error {}

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

export class Monitors {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._detection = null;
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
        // A monitor that did not answer may only be waking up, so ask again next time.
        if (detection.unreachable.length === 0)
            this._detection = detection;
        return detection;
    }

    async _detect() {
        const detected = parseDisplays(await ddcutil(['detect', '--terse'], this._cancellable));
        const maxima = await Promise.all(detected.map(display =>
            display.valid ? this._readMax(display.bus) : null));
        const displays = [];
        const unreachable = [];
        detected.forEach(({bus, name}, i) => {
            if (maxima[i] === null)
                unreachable.push({bus, name});
            else
                displays.push({bus, name, max: maxima[i]});
        });
        if (displays.length === 0)
            throw new NoMonitorsError('No monitor answered over DDC/CI');
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
        if (failed.length > 0)
            this.forget();
        return {displays, failed, unreachable};
    }

    destroy() {
        this._cancellable.cancel();
    }
}
