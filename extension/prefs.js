import Adw from 'gi://Adw';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildPresetsEditor} from './lib/presetsEditor.js';

export default class MonitorBrightnessPresetsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const editor = buildPresetsEditor(this.getSettings(), _);
        const page = new Adw.PreferencesPage();
        page.add(editor.group);
        window.add(page);
        window.connect('close-request', () => editor.destroy());
    }
}
