import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TRANSPARENCY = 'transparency';
const DARK_FULL_SCREEN = 'dark-full-screen';
const DISABLE_TEXT_SHADOW = 'disable-text-shadow';
const AUTO_FOREGROUND_COLOR = 'auto-foreground-color';
const FOREGROUND_LUMINANCE_THRESHOLD = 'foreground-luminance-threshold';
const SAMPLE_COUNT = 'sample-count';

export default class TransparentTopBarPrefsWidget extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings('com.ftpix.transparentbar');

        window.search_enabled = true;
        window.default_width = 500;
        window.default_height = 650;

        const page = new Adw.PreferencesPage({
            title: _('Transparent Top Bar'),
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const barGroup = new Adw.PreferencesGroup({
            title: _('Top Bar'),
        });

        const opacityRow = new Adw.ActionRow({
            title: _('Opacity'),
            subtitle: _('How much black is drawn behind the panel'),
        });

        const opacityScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                page_increment: 10,
            }),
            digits: 0,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_request: 220,
        });
        settings.bind(TRANSPARENCY, opacityScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);

        opacityRow.add_suffix(opacityScale);
        opacityRow.activatable_widget = opacityScale;
        barGroup.add(opacityRow);

        const opaqueRow = new Adw.SwitchRow({
            title: _('Opaque when a window touches the bar'),
        });
        settings.bind(DARK_FULL_SCREEN, opaqueRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        barGroup.add(opaqueRow);

        const shadowRow = new Adw.SwitchRow({
            title: _('Disable text shadow'),
        });
        settings.bind(DISABLE_TEXT_SHADOW, shadowRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        barGroup.add(shadowRow);

        const colorGroup = new Adw.PreferencesGroup({
            title: _('Automatic foreground color'),
            description: _('Sample the background behind the top bar and pick dark or light text for contrast'),
        });

        const autoRow = new Adw.SwitchRow({
            title: _('Follow the background brightness'),
        });
        settings.bind(AUTO_FOREGROUND_COLOR, autoRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        colorGroup.add(autoRow);

        const thresholdRow = new Adw.SpinRow({
            title: _('Dark text threshold'),
            subtitle: _('Use dark text when the background luminance is higher than this'),
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.1,
                upper: 0.9,
                step_increment: 0.05,
                page_increment: 0.1,
            }),
        });
        settings.bind(FOREGROUND_LUMINANCE_THRESHOLD, thresholdRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind(AUTO_FOREGROUND_COLOR, thresholdRow, 'sensitive', Gio.SettingsBindFlags.GET);
        colorGroup.add(thresholdRow);

        const sampleRow = new Adw.SpinRow({
            title: _('Sample points'),
            subtitle: _('More points are more reliable but take slightly longer'),
            adjustment: new Gtk.Adjustment({
                lower: 3,
                upper: 32,
                step_increment: 1,
                page_increment: 4,
            }),
        });
        settings.bind(SAMPLE_COUNT, sampleRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind(AUTO_FOREGROUND_COLOR, sampleRow, 'sensitive', Gio.SettingsBindFlags.GET);
        colorGroup.add(sampleRow);

        page.add(barGroup);
        page.add(colorGroup);
        window.add(page);
    }
}
