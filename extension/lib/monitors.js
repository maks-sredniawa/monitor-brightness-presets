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
        this._displays = null;
        this._applying = null;
        this._pendingPercent = null;
    }

    forget() {
        this._displays = null;
    }

    async list() {
        this._displays ??= await this._detect();
        return this._displays;
    }

    async _detect() {
        const detected = parseDisplays(await ddcutil(['detect', '--terse'], this._cancellable));
        const readings = await Promise.allSettled(detected.map(display =>
            ddcutil(['--bus', `${display.bus}`, 'getvcp', '10', '--brief'], this._cancellable)));
        const displays = detected.flatMap((display, i) => {
            const brightness = readings[i].status === 'fulfilled' ? parseBrightness(readings[i].value) : null;
            return brightness ? [{...display, max: brightness.max}] : [];
        });
        if (displays.length === 0)
            throw new NoMonitorsError('No monitor answered over DDC/CI');
        return displays;
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
        const displays = await this.list();
        const outcomes = await Promise.allSettled(displays.map(display =>
            ddcutil(['--bus', `${display.bus}`, 'setvcp', '10',
                `${percentToValue(percent, display.max)}`], this._cancellable)));
        const failed = displays.filter((_display, i) => outcomes[i].status === 'rejected');
        if (failed.length > 0)
            this.forget();
        return {displays, failed};
    }

    destroy() {
        this._cancellable.cancel();
    }
}
