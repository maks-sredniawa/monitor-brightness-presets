import {format} from './format.js';

function listNames(displays) {
    return new Intl.ListFormat(undefined, {type: 'conjunction'}).format(displays.map(display => display.name));
}

function rejectedFeatures(rejected, display) {
    return rejected[display.bus] ?? ['brightness'];
}

export function acceptedBrightness(displays, rejected) {
    return displays.some(display => !rejected[display.bus]?.includes('brightness'));
}

export function describeProblems(ngettext, failed, rejected, unreachable) {
    const sentences = [];
    const rejectedOnly = feature => failed.filter(display => {
        const features = rejectedFeatures(rejected, display);
        return features.length === 1 && features[0] === feature;
    });
    const brightness = rejectedOnly('brightness');
    const contrast = rejectedOnly('contrast');
    const both = failed.filter(display => rejectedFeatures(rejected, display).length > 1);
    if (brightness.length > 0) {
        sentences.push(format(ngettext(
            '%s did not change its brightness. Its own menu may be locking it, for example an ECO mode or picture preset.',
            '%s did not change their brightness. Their own menus may be locking them, for example an ECO mode or picture preset.',
            brightness.length), listNames(brightness)));
    }
    if (contrast.length > 0) {
        sentences.push(format(ngettext(
            '%s did not change its contrast. Its own menu may be locking it, for example an ECO mode or picture preset.',
            '%s did not change their contrast. Their own menus may be locking them, for example an ECO mode or picture preset.',
            contrast.length), listNames(contrast)));
    }
    if (both.length > 0) {
        sentences.push(format(ngettext(
            '%s did not change its brightness or contrast. Its own menu may be locking them, for example an ECO mode or picture preset.',
            '%s did not change their brightness or contrast. Their own menus may be locking them, for example an ECO mode or picture preset.',
            both.length), listNames(both)));
    }
    const busy = unreachable.filter(display => display.reason === 'busy');
    const silent = unreachable.filter(display => display.reason !== 'busy');
    if (busy.length > 0) {
        sentences.push(format(ngettext(
            '%s is in use by another program, such as the ddcci kernel module, so it was left as it is.',
            '%s are in use by another program, such as the ddcci kernel module, so they were left as they are.',
            busy.length), listNames(busy)));
    }
    if (silent.length > 0) {
        sentences.push(format(ngettext(
            '%s did not answer over DDC/CI. Check that DDC/CI is on in its own menu.',
            '%s did not answer over DDC/CI. Check that DDC/CI is on in each one’s own menu.',
            silent.length), listNames(silent)));
    }
    return sentences.join(' ');
}
