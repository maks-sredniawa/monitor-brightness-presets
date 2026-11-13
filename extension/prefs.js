import Adw from 'gi://Adw';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildPresetsEditor} from './lib/presetsEditor.js';
import {buildScheduleEditor} from './lib/scheduleEditor.js';

export default class MonitorBrightnessPresetsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const presets = buildPresetsEditor(settings, _);
        const schedule = buildScheduleEditor(settings, _);
        const page = new Adw.PreferencesPage();
        page.add(presets.group);
        page.add(schedule.group);
        window.add(page);
        window.connect('close-request', () => {
            presets.destroy();
            schedule.destroy();
        });
    }
}
