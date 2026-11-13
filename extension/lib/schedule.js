import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {format} from './format.js';
import {readPresets} from './presets.js';

export const MINUTES_PER_DAY = 24 * 60;

export function normalizeSchedule(raw) {
    const seen = new Set();
    const entries = [];
    for (const [minutes, preset] of raw) {
        if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY || seen.has(minutes))
            continue;
        seen.add(minutes);
        entries.push({minutes, preset});
    }
    return entries.sort((a, b) => a.minutes - b.minutes);
}

export function readSchedule(settings) {
    return normalizeSchedule(settings.get_value('schedule').deepUnpack());
}

export function scheduleState(settings, now) {
    return {
        enabled: settings.get_boolean('schedule-enabled'),
        entries: readSchedule(settings),
        names: readPresets(settings).map(preset => preset.name),
        handled: settings.get_int64('schedule-handled'),
        now,
    };
}

export function scheduleVariant(entries) {
    return new GLib.Variant('a(is)', entries.map(({minutes, preset}) => [minutes, preset]));
}

export function renameInSchedule(raw, renames) {
    return raw.map(([minutes, preset]) => [minutes, renames[preset] ?? preset]);
}

function occurrences(entries, names, now, days) {
    const zone = now.get_timezone();
    const found = [];
    for (const offset of days) {
        const day = now.add_days(offset);
        for (const entry of entries) {
            if (!names.includes(entry.preset))
                continue;
            const at = GLib.DateTime.new(zone, day.get_year(), day.get_month(), day.get_day_of_month(),
                Math.floor(entry.minutes / 60), entry.minutes % 60, 0);
            found.push({...entry, at: at.to_unix()});
        }
    }
    return found;
}

// Entries are compared by the instant they fall on, not by their minutes, so a time
// moved by a daylight-saving change still sorts where the clock puts it.
export function currentSlot(entries, names, now) {
    const nowAt = now.to_unix();
    let best = null;
    for (const slot of occurrences(entries, names, now, [-1, 0])) {
        if (slot.at <= nowAt && (!best || slot.at > best.at || (slot.at === best.at && slot.minutes > best.minutes)))
            best = slot;
    }
    return best;
}

export function nextChange(entries, names, now) {
    const nowAt = now.to_unix();
    let best = null;
    for (const slot of occurrences(entries, names, now, [0, 1])) {
        if (slot.at > nowAt && (!best || slot.at < best.at))
            best = slot;
    }
    return best;
}

export function catchUpSlot({enabled, entries, names, handled, now}) {
    if (!enabled)
        return null;
    const slot = currentSlot(entries, names, now);
    return slot && slot.at > handled ? slot : null;
}

export function handledAfterEdit({handled, before, after}) {
    const pending = before !== null && before.at > handled;
    return !pending && after !== null && after.at > handled ? after.at : handled;
}

export function nextFreeHour(entries, now) {
    const taken = new Set(entries.map(entry => entry.minutes));
    const first = (now.get_hour() + 1) % 24;
    for (let step = 0; step < 24; step++) {
        const minutes = ((first + step) % 24) * 60;
        if (!taken.has(minutes))
            return minutes;
    }
    return first * 60;
}

export function meridiem(hour) {
    return GLib.DateTime.new_utc(2000, 1, 1, hour, 0, 0).format('%p') || (hour < 12 ? 'AM' : 'PM');
}

export function formatTime(minutes, clockFormat) {
    const time = GLib.DateTime.new_utc(2000, 1, 1, Math.floor(minutes / 60), minutes % 60, 0);
    if (clockFormat !== '12h')
        return time.format('%H:%M');
    return `${time.format('%l:%M').trim()} ${meridiem(time.get_hour())}`;
}

export function scheduleStatus({enabled, entries, names, now, clockFormat, extensionActive = null}, _) {
    if (extensionActive === false)
        return _('Needs the Monitor brightness presets extension turned on');
    if (!enabled)
        return _('Changes presets at set times');
    if (entries.length === 0)
        return _('No times set');
    const next = nextChange(entries, names, now);
    if (!next)
        return _('Every time points at a removed preset');
    return format(_('Next: %s at %s'), next.preset, formatTime(next.minutes, clockFormat));
}

export function nextChangeLabel({enabled, entries, names, now, clockFormat}, _) {
    const next = enabled ? nextChange(entries, names, now) : null;
    return next ? format(_('Next: %s at %s'), next.preset, formatTime(next.minutes, clockFormat)) : null;
}

export function msUntil(at, now) {
    return Math.max(0, at * 1000 - (now.to_unix() * 1000 + Math.floor(now.get_microsecond() / 1000)));
}

export function interfaceSettings() {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup('org.gnome.desktop.interface', true);
    return schema?.has_key('clock-format') ? new Gio.Settings({settings_schema: schema}) : null;
}

export function clockFormat(settings) {
    return settings?.get_string('clock-format') ?? '24h';
}
