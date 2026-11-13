const BUILT_IN_PANEL = /^(eDP|LVDS|DSI)-/;
const HEADERS = [
    [/^Display \d+/, 'ok'],
    [/^Invalid display/, 'invalid'],
    [/^Busy display/, 'busy'],
    [/^DDC[_ ]disabled/, 'disabled'],
];

export function parseDisplays(detectOutput) {
    const displays = [];
    let current = null;
    for (const line of detectOutput.split('\n')) {
        const status = HEADERS.find(([header]) => header.test(line))?.[1];
        if (status) {
            current = {bus: null, name: '', status, connector: ''};
            displays.push(current);
        } else if (/^\S/.test(line)) {
            current = null;
        } else if (current) {
            const bus = line.match(/I2C bus:\s+\/dev\/i2c-(\d+)/);
            if (bus)
                current.bus = Number(bus[1]);
            const connector = line.match(/DRM[_ ]connector:\s+card\d+-(\S+)/);
            if (connector) {
                current.connector = connector[1];
                current.name ||= connector[1];
            }
            const monitor = line.match(/Monitor:\s+([^:]*):([^:]*):/);
            if (monitor)
                current.name = monitor[2].trim() || monitor[1].trim() || current.name;
        }
    }
    const kept = displays
        .filter(display => display.bus !== null)
        .filter(display => display.status === 'ok' || !BUILT_IN_PANEL.test(display.connector))
        .map(display => ({...display, name: display.name || `I2C bus ${display.bus}`}));
    const shared = kept.filter(display => kept.filter(other => other.name === display.name).length > 1);
    return kept.map(({bus, name, status, connector}) => ({
        bus,
        name: shared.some(display => display.bus === bus) ? `${name} (${connector || `I2C bus ${bus}`})` : name,
        status,
    }));
}

export function parseBrightness(getvcpOutput) {
    const match = getvcpOutput.match(/^VCP 10 C (\d+) (\d+)/m);
    return match ? {current: Number(match[1]), max: Number(match[2])} : null;
}

export function percentToValue(percent, max) {
    const clamped = Math.min(100, Math.max(0, percent));
    return Math.round(clamped * max / 100);
}

export function valueToPercent(value, max) {
    return max > 0 ? Math.round(value * 100 / max) : 0;
}
