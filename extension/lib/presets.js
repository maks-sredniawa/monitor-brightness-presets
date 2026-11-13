export function collectPresets(rows, activeRow) {
    const owners = new Map();
    const duplicates = new Set();
    for (const row of rows) {
        if (!row.name)
            continue;
        if (owners.has(row.name))
            duplicates.add(row);
        else
            owners.set(row.name, row);
    }
    const saved = [...owners.values()];
    const renames = {};
    for (const row of saved) {
        if (row.savedName && row.savedName !== row.name && !owners.has(row.savedName))
            renames[row.savedName] = row.name;
    }
    return {
        presets: saved.map(row => [row.name, row.percent]),
        contrasts: Object.fromEntries(saved
            .filter(row => row.contrast !== null && row.contrast !== undefined)
            .map(row => [row.name, row.contrast])),
        saved,
        duplicates,
        renames,
        active: activeRow && owners.get(activeRow.name) === activeRow ? activeRow.name : '',
    };
}

export function readPresets(settings) {
    const contrasts = settings.get_value('preset-contrast').deepUnpack();
    return settings.get_value('presets').deepUnpack()
        .map(([name, brightness]) => ({name, brightness, contrast: contrasts[name] ?? null}));
}
