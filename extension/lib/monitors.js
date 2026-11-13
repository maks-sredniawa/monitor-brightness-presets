import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseBrightness, parseDisplays, percentToValue, valueToPercent} from './ddc.js';

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

function covers(job, waiting) {
    if (job.kind !== waiting.kind)
        return false;
    return job.kind === 'read' || job.bus === null || job.bus === waiting.bus;
}

export class Monitors {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._detection = null;
        this._failingBuses = new Set();
        this._queue = [];
        this._draining = false;
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
        return (await this._readBrightness(bus))?.max ?? null;
    }

    async _readBrightness(bus) {
        try {
            const output = await ddcutil(['--bus', `${bus}`, 'getvcp', '10', '--brief'], this._cancellable);
            return parseBrightness(output);
        } catch (error) {
            if (isCancelled(error))
                throw error;
            return null;
        }
    }

    setBrightness(percent) {
        return this._enqueue({kind: 'write', bus: null, percent});
    }

    setMonitorBrightness(bus, percent) {
        return this._enqueue({kind: 'write', bus, percent});
    }

    read() {
        return this._enqueue({kind: 'read'});
    }

    // Dragging a slider or clicking presets in quick succession must leave the last
    // value applied, so ddcutil runs one job at a time and a waiting job is dropped,
    // its callers handed the newer job's result, once a newer one covers it.
    _enqueue(job) {
        return new Promise((resolve, reject) => {
            const covered = this._queue.filter(waiting => covers(job, waiting));
            this._queue = this._queue.filter(waiting => !covered.includes(waiting));
            job.callers = [{resolve, reject}, ...covered.flatMap(waiting => waiting.callers)];
            this._queue.push(job);
            if (!this._draining)
                this._drain();
        });
    }

    async _drain() {
        this._draining = true;
        while (this._queue.length > 0) {
            const job = this._queue.shift();
            try {
                const result = job.kind === 'read'
                    ? await this._readAll()
                    : await this._write(job.bus, job.percent);
                job.callers.forEach(caller => caller.resolve(result));
            } catch (error) {
                job.callers.forEach(caller => caller.reject(error));
            }
        }
        this._draining = false;
    }

    async _write(bus, percent) {
        const {displays, unreachable} = await this.list();
        const targets = bus === null ? displays : displays.filter(display => display.bus === bus);
        const outcomes = await Promise.allSettled(targets.map(display =>
            ddcutil(['--bus', `${display.bus}`, 'setvcp', '10',
                `${percentToValue(percent, display.max)}`], this._cancellable)));
        const failed = targets.filter((_display, i) => outcomes[i].status === 'rejected');
        // A monitor that rejects writes on a fresh detection too is ignoring DDC writes,
        // not sitting on a stale bus, so detecting again for it would only slow every pick.
        if (failed.some(display => !this._failingBuses.has(display.bus)))
            this.forget();
        for (const display of targets) {
            if (failed.includes(display))
                this._failingBuses.add(display.bus);
            else
                this._failingBuses.delete(display.bus);
        }
        return {displays: targets, failed, unreachable};
    }

    async _readAll() {
        const {displays, unreachable} = await this.list();
        const readings = await Promise.all(displays.map(display => this._readBrightness(display.bus)));
        const silent = displays.filter((_display, i) => readings[i] === null);
        if (silent.length > 0)
            this.forget();
        return {
            displays: displays.flatMap((display, i) => readings[i] === null ? [] : [{
                ...display,
                percent: valueToPercent(readings[i].current, readings[i].max),
            }]),
            unreachable: [...unreachable, ...silent.map(({bus, name}) => ({bus, name, reason: 'silent'}))],
        };
    }

    destroy() {
        this._cancellable.cancel();
    }
}
