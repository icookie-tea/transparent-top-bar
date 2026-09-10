import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TRANSPARENCY = 'transparency';
const DARK_FULL_SCREEN = 'dark-full-screen';
const DISABLE_TEXT_SHADOW = 'disable-text-shadow';
const AUTO_FOREGROUND_COLOR = 'auto-foreground-color';

export default class TransparentTopBarPrefsWidget extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        window._settings = this.getSettings('com.ftpix.transparentbar');
        const opacity = window._settings.get_int(TRANSPARENCY);
        const opaqueWhenTouched = window._settings.get_boolean(DARK_FULL_SCREEN);
        const disableTextShadow = window._settings.get_boolean(DISABLE_TEXT_SHADOW);
        const autoForegroundColor = window._settings.get_boolean(AUTO_FOREGROUND_COLOR);

        const page = new Adw.PreferencesPage();

        const group = new Adw.PreferencesGroup({
            title: _('Top bar opacity (%)'),
        });

        // scale
        const scale = new Gtk.Scale();
        scale.set_digits(0);
        scale.set_round_digits(0);

        scale.set_range(0, 100);
        scale.set_draw_value(true);

        // setting value last as it might not work if the scale is not set up properly
        scale.set_value(opacity);
        scale.connect('value-changed', (scale) => {
            window._settings.set_int(TRANSPARENCY, scale.get_value());
        });
        group.add(scale);

        // Switch for full opacity when window touch the bar
        const row = new Gtk.Box();
        row.set_orientation(Gtk.HORIZONTAL);
        row.set_margin_top(20);
        row.set_margin_bottom(20);
        //row.set_homogeneous(true);

        const sw = new Gtk.Switch();
        sw.set_active(opaqueWhenTouched);
        sw.connect('state-set', (sw) => {
            window._settings.set_boolean(DARK_FULL_SCREEN, sw.get_active());
        });
        sw.set_halign(Gtk.Align.END);

        const label = Gtk.Label.new('Opaque top bar when a window touches it');
        label.set_hexpand(true);
        label.set_halign(Gtk.Align.START);

        row.append(label);
        row.append(sw);
        group.add(row);

        const autoColorRow = new Gtk.Box();
        autoColorRow.set_orientation(Gtk.HORIZONTAL);
        autoColorRow.set_margin_top(20);
        autoColorRow.set_margin_bottom(20);

        const autoColorSwitch = new Gtk.Switch();
        autoColorSwitch.set_active(autoForegroundColor);
        autoColorSwitch.connect('state-set', (sw) => {
            window._settings.set_boolean(AUTO_FOREGROUND_COLOR, sw.get_active());
        });
        autoColorSwitch.set_halign(Gtk.Align.END);

        const autoColorLabel = Gtk.Label.new('Dark or light text depending on the wallpaper');
        autoColorLabel.set_hexpand(true);
        autoColorLabel.set_halign(Gtk.Align.START);

        autoColorRow.append(autoColorLabel);
        autoColorRow.append(autoColorSwitch);
        group.add(autoColorRow);

        const shadowRow = new Gtk.Box();
        shadowRow.set_orientation(Gtk.HORIZONTAL);
        shadowRow.set_margin_top(20);
        shadowRow.set_margin_bottom(20);

        const shadowSwitch = new Gtk.Switch();
        shadowSwitch.set_active(disableTextShadow);
        shadowSwitch.connect('state-set', (sw) => {
            window._settings.set_boolean(DISABLE_TEXT_SHADOW, sw.get_active());
        });
        shadowSwitch.set_halign(Gtk.Align.END);

        const shadowLabel = Gtk.Label.new('Disable text shadow');
        shadowLabel.set_hexpand(true);
        shadowLabel.set_halign(Gtk.Align.START);

        shadowRow.append(shadowLabel);
        shadowRow.append(shadowSwitch);
        group.add(shadowRow);

        page.add(group);

        window.add(page);
    }

    onValueChanged(scale) {
        this.settings.set_int("transparency", this._opacity.get_value());
    }

    onDarkFullScreenChanged(gtkSwitch) {
        this.settings.set_boolean("dark-full-screen", this._darkFullScreen.get_active());
    }
}

