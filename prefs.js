import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TRANSPARENCY = 'transparency';
const DARK_FULL_SCREEN = 'dark-full-screen';
const DISABLE_BLACK_TEXT_SHADOW = 'disable-black-text-shadow';
const DISABLE_WHITE_TEXT_SHADOW = 'disable-white-text-shadow';
const AUTO_FOREGROUND_COLOR = 'auto-foreground-color';
const FOREGROUND_LUMINANCE_THRESHOLD = 'foreground-luminance-threshold';
const SAMPLE_COUNT = 'sample-count';
const DEBUG_LOGGING = 'debug-logging';
const TOP_EDGE_SHADOW = 'top-edge-shadow';
const TOP_EDGE_SHADOW_STRENGTH = 'top-edge-shadow-strength';
const TOP_EDGE_SHADOW_HEIGHT = 'top-edge-shadow-height';

export default class TransparentTopBarPrefsWidget extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();

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

        const blackShadowRow = new Adw.SwitchRow({
            title: _('Disable black text shadow'),
            subtitle: _('Behind the default light top bar text and icons'),
        });
        settings.bind(DISABLE_BLACK_TEXT_SHADOW, blackShadowRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        barGroup.add(blackShadowRow);

        const whiteShadowRow = new Adw.SwitchRow({
            title: _('Disable white text shadow'),
            subtitle: _('Behind the dark text and icons used on bright backgrounds'),
        });
        settings.bind(DISABLE_WHITE_TEXT_SHADOW, whiteShadowRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        barGroup.add(whiteShadowRow);

        const edgeShadowGroup = new Adw.PreferencesGroup({
            title: _('Top edge shadow'),
            description: _('A soft shadow fading down from the top of the screen. Reduced behind dark text and hidden when the bar is opaque.'),
        });
        const edgeShadowRow = new Adw.SwitchRow({
            title: _('Enable top edge shadow'),
        });
        settings.bind(TOP_EDGE_SHADOW, edgeShadowRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        edgeShadowGroup.add(edgeShadowRow);

        const shadowStrengthRow = new Adw.SpinRow({
            title: _('Shadow strength (%)'),
            subtitle: _('Maximum darkness at the top edge'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        settings.bind(TOP_EDGE_SHADOW_STRENGTH, shadowStrengthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind(TOP_EDGE_SHADOW, shadowStrengthRow, 'sensitive', Gio.SettingsBindFlags.GET);
        edgeShadowGroup.add(shadowStrengthRow);

        const shadowHeightRow = new Adw.SpinRow({
            title: _('Shadow height (px)'),
            subtitle: _('Distance from the top edge to fully transparent, scaled for the display'),
            adjustment: new Gtk.Adjustment({
                lower: 48,
                upper: 160,
                step_increment: 4,
                page_increment: 16,
            }),
        });
        settings.bind(TOP_EDGE_SHADOW_HEIGHT, shadowHeightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind(TOP_EDGE_SHADOW, shadowHeightRow, 'sensitive', Gio.SettingsBindFlags.GET);
        edgeShadowGroup.add(shadowHeightRow);

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
        page.add(edgeShadowGroup);
        page.add(colorGroup);

        const debugGroup = new Adw.PreferencesGroup({
            title: _('Debug'),
        });

        const debugRow = new Adw.SwitchRow({
            title: _('Log background samples'),
            subtitle: _('Write the sampled luminance to the system log'),
        });
        settings.bind(DEBUG_LOGGING, debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        debugGroup.add(debugRow);

        page.add(debugGroup);
        window.add(page);
    }
}
