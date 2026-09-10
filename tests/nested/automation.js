// Nested-session test for transparent-top-bar, run via --automation-script.
//
// Covered:
//  A. Samples taken while the overview transition is running must be discarded
//     (they are a mix of the desktop and the overview background).
//  B. The panel background transition must survive the opaque -> transparent
//     change when the panel style is touched again while St animates it.
//  C. Overview samples are taken while stable and end up cached.
//  D. The black and white text shadows have independent settings; only the
//     one matching the active foreground decides the no-text-shadow class.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const METRICS = {};

const UUID = 'transparent-top-bar@icookie-tea.github.io';
const TAG = '[TTB-TEST]';
const failures = [];

function check(name, ok, detail = '') {
    const suffix = detail ? ` (${detail})` : '';
    print(`${TAG} ${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`);
    if (!ok)
        failures.push(name);
}

function info(...args) {
    print(`${TAG} INFO ${args.join(' ')}`);
}

const sleep = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

const nowMs = () => GLib.get_monotonic_time() / 1000;

async function waitFor(fn, timeoutMs = 15000, stepMs = 100) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    for (;;) {
        const value = fn();
        if (value)
            return value;
        if (GLib.get_monotonic_time() > deadline)
            throw new Error('waitFor: timed out');
        await sleep(stepMs);
    }
}

Gio._promisify(Shell.Screenshot.prototype, 'pick_color');

let screenshot = null;
async function samplePixel(x, y) {
    if (screenshot === null)
        screenshot = new Shell.Screenshot();
    const [color] = await screenshot.pick_color(x, y);
    if (!color)
        return null;
    return (0.3 * color.red + 0.59 * color.green + 0.11 * color.blue) / 255;
}

// Median of a few points in the top row of the panel (below the text/icons)
async function panelLuminance() {
    const monitor = Main.layoutManager.primaryMonitor;
    const [, panelY] = Main.panel.get_transformed_position();
    const y = Math.round(panelY + 1);
    const values = [];
    for (let i = 1; i <= 9; i++) {
        const value = await samplePixel(Math.round(monitor.x + monitor.width * i / 10), y);
        if (value !== null)
            values.push(value);
    }
    if (values.length === 0)
        return null;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
}

function rectString(win) {
    const r = win.get_frame_rect();
    return `x${r.x} y${r.y} ${r.width}x${r.height}`;
}

function findTestWindow() {
    return global.get_window_actors()
        .map(actor => actor.meta_window)
        .find(window => window &&
            window.get_window_type() === Meta.WindowType.NORMAL &&
            !window.skip_taskbar &&
            window.get_title() === 'TTB Test Window');
}

export async function run() {
    print(`${TAG} START`);
    try {
        const ext = await waitFor(() => Main.extensionManager.lookup(UUID)?.stateObj, 20000);
        info('extension instance found');

        // GNOME Shell may boot straight into the overview (no windows yet)
        if (Main.overview.visible)
            Main.overview.hide();
        await waitFor(() => !Main.overview.visible, 5000, 100);
        await sleep(1500);

        await waitFor(() => ext._luminance.size > 0, 10000, 200);
        const desktopLum = ext._luminance.get('desktop');
        check('initial desktop sample exists', desktopLum !== undefined, `desktop=${desktopLum}`);

        // --- A: overview transition guard --------------------------------
        const extHasDeadline = typeof ext._unstableUntilMs === 'number';
        const waitStable = async () => {
            if (extHasDeadline)
                await waitFor(() => ext._unstableUntilMs <= nowMs(), 3000, 50);
            else
                await sleep(600); // overview transition is 250ms
        };

        const originalSample = ext._sampleBackgroundLuminance;
        const SENTINEL = 0.42;
        ext._sampleBackgroundLuminance = async () => SENTINEL;
        ext._luminance.delete('overview');

        Main.overview.show();
        await sleep(80);
        if (extHasDeadline) {
            check('background is marked unstable during the overview transition',
                ext._unstableUntilMs > nowMs(),
                `unstableUntil-now=${(ext._unstableUntilMs - nowMs()).toFixed(0)}ms`);
        } else {
            info('pre-fix code: no instability deadline');
        }
        await ext._refreshBackgroundLuminance();
        check('sample during transition is discarded',
            ext._luminance.get('overview') === undefined,
            `overview=${ext._luminance.get('overview')}`);

        await waitStable();
        await ext._refreshBackgroundLuminance();
        check('sample after transition is accepted',
            ext._luminance.get('overview') === SENTINEL,
            `overview=${ext._luminance.get('overview')}`);

        ext._sampleBackgroundLuminance = originalSample;
        ext._luminance.delete('overview');
        ext._darkText.delete('overview');

        Main.overview.hide();
        await waitFor(() => !Main.overview.visible, 5000, 50);
        await sleep(500);

        // --- B: panel background transition on window leave --------------
        const win = await waitFor(findTestWindow, 25000, 250);
        info('test window found');

        const [, panelY] = Main.panel.get_transformed_position();
        const panelBottom = panelY + Main.panel.get_height();

        win.move_frame(true, 60, 0);
        await sleep(300);
        info('window frame near panel:', rectString(win));

        try {
            await waitFor(() => !Main.panel.has_style_class_name('transparent-top-bar'), 3000, 100);
            check('panel becomes opaque when the window touches it', true);
        } catch (e) {
            check('panel becomes opaque when the window touches it', false,
                `frame=${rectString(win)} ` +
                `panelTransparent=${ext._panelTransparent} overview=${Main.overview.visible} ` +
                `hasWindows=${Main.sessionMode.hasWindows} darkFullScreen=${ext._darkFullScreen} ` +
                `onPrimary=${win.is_on_primary_monitor()} showing=${win.showing_on_its_workspace()} ` +
                `skip=${win.skip_taskbar} type=${win.get_window_type()}`);
        }

        await sleep(500);
        const opaqueLum = await panelLuminance();
        check('opaque panel is black', opaqueLum !== null && opaqueLum < 0.15,
            `panel=${opaqueLum} classes="${Main.panel.get_style_class_name()}" frame=${rectString(win)}`);

        win.move_frame(true, 60, Math.round(panelBottom + 400));
        await sleep(250);               // leave transition is running (500 ms)
        ext._updateTransparent();       // as a stray ::allocation would
        await sleep(50);
        const midLum = await panelLuminance();
        await sleep(900);
        const finalLum = await panelLuminance();

        check('panel is transparent after the window left',
            finalLum !== null && finalLum > 0.5, `panel=${finalLum}`);
        check('panel background is still fading mid-way',
            opaqueLum !== null && midLum !== null && finalLum !== null &&
            midLum > opaqueLum + 0.05 && midLum < finalLum - 0.05,
            `opaque=${opaqueLum} mid=${midLum} final=${finalLum} ` +
            `classes="${Main.panel.get_style_class_name()}" frame=${rectString(win)}`);

        // --- C: real overview sampling -----------------------------------
        const beforeOverview = ext._luminance.get('desktop');
        Main.overview.show();
        await waitStable();
        await sleep(500);
        const overviewLum = ext._luminance.get('overview');
        check('overview sample recorded while stable', overviewLum !== undefined,
            `desktop=${beforeOverview} overview=${overviewLum}`);
        Main.overview.hide();
        await sleep(600);

        // --- D: separate black/white text shadow settings ----------------
        if (typeof ext._disableWhiteTextShadow === 'boolean') {
            const hasNoShadow = () => Main.panel.has_style_class_name('no-text-shadow');
            const hasDarkText = () => Main.panel.has_style_class_name('transparent-top-bar-dark-text');
            const setThreshold = async value => {
                ext._settings.set_double('foreground-luminance-threshold', value);
                await sleep(300);
            };
            const setShadow = async (key, value) => {
                ext._settings.set_boolean(key, value);
                await sleep(400);   // the extension debounces the change by 250ms
            };

            // The test background has luminance 0.8: a low threshold forces
            // dark text, a high one forces light text
            await setThreshold(0.1);
            check('dark text is active before the shadow checks', hasDarkText());

            await setShadow('disable-black-text-shadow', false);
            await setShadow('disable-white-text-shadow', false);
            check('shadows enabled adds no no-text-shadow class', !hasNoShadow());

            await setShadow('disable-white-text-shadow', true);
            check('white shadow setting applies to dark text', hasNoShadow());

            await setShadow('disable-white-text-shadow', false);
            await setShadow('disable-black-text-shadow', true);
            check('black shadow setting does not affect dark text', !hasNoShadow());

            await setThreshold(0.9);
            check('light text is active with a high threshold', !hasDarkText());
            check('black shadow setting applies to light text', hasNoShadow());

            await setShadow('disable-black-text-shadow', false);
            check('black shadow can be re-enabled', !hasNoShadow());

            await setThreshold(0.7);
            ext._settings.reset('disable-black-text-shadow');
            ext._settings.reset('disable-white-text-shadow');

            // The deprecated single switch is migrated on the next enable
            ext._settings.set_boolean('disable-text-shadow', true);
            ext.disable();
            ext.enable();
            await sleep(600);
            const migratedBlack = ext._settings.get_boolean('disable-black-text-shadow');
            const migratedWhite = ext._settings.get_boolean('disable-white-text-shadow');
            const oldValue = ext._settings.get_boolean('disable-text-shadow');
            check('deprecated shadow switch migrates to both new keys',
                migratedBlack && migratedWhite && !oldValue,
                `black=${migratedBlack} white=${migratedWhite} old=${oldValue}`);
            ext._settings.reset('disable-black-text-shadow');
            ext._settings.reset('disable-white-text-shadow');
        } else {
            info('pre-fix code: no separate text shadow settings');
        }
    } catch (e) {
        failures.push(String(e));
        logError(e, `${TAG} test run failed`);
    }

    print(`${TAG} SUMMARY ${failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.join('; ')}`}`);
    global.context.terminate();
}
