export function parseDisplays(detectOutput) {
    const displays = [];
    let current = null;
    for (const line of detectOutput.split('\n')) {
        if (/^(Display \d+|Invalid display)/.test(line)) {
            current = {bus: null, name: '', valid: line.startsWith('Display')};
            displays.push(current);
        } else if (/^\S/.test(line)) {
            current = null;
        } else if (current) {
            const bus = line.match(/I2C bus:\s+\/dev\/i2c-(\d+)/);
            if (bus)
                current.bus = Number(bus[1]);
            const connector = line.match(/DRM[_ ]connector:\s+card\d+-(\S+)/);
            if (connector)
                current.name ||= connector[1];
            const monitor = line.match(/Monitor:\s+([^:]*):([^:]*):/);
            if (monitor)
                current.name = monitor[2].trim() || monitor[1].trim() || current.name;
        }
    }
    return displays
        .filter(display => display.bus !== null)
        .map(display => ({...display, name: display.name || `I2C bus ${display.bus}`}));
}

export function parseBrightness(getvcpOutput) {
    const match = getvcpOutput.match(/^VCP 10 C (\d+) (\d+)/m);
    return match ? {current: Number(match[1]), max: Number(match[2])} : null;
}

export function percentToValue(percent, max) {
    const clamped = Math.min(100, Math.max(0, percent));
    return Math.round(clamped * max / 100);
}
