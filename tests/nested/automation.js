// Nested-session test for transparent-top-bar, run via --automation-script.
//
// Covered:
//  A. Samples taken while the overview transition is running must be discarded
//     (they are a mix of the desktop and the overview background).
//  B. The panel background transition must survive the opaque -> transparent
//     change when the panel style is touched again while St animates it.
//  C. Overview samples are taken while stable and end up cached.
//  D. A window in front of the panel must not be sampled as the desktop
//     background: after an overview round trip the panel still has to fade
//     out instead of flipping the foreground class mid-transition.
//  E. The black and white text shadows have independent settings; only the
//     one matching the active foreground decides the no-text-shadow class.
//  F. The optional edge shadow renders a gradient, preserves background
//     sampling/work area/input, and follows foreground/fullscreen/lifecycle.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';

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
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');

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

async function captureTopEdge(name) {
    const monitor = Main.layoutManager.primaryMonitor;
    const path = GLib.build_filenamev([GLib.get_home_dir(), '..', `${name}.png`]);
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    try {
        const capture = new Shell.Screenshot();
        await capture.screenshot_area(monitor.x, monitor.y, monitor.width, 200, stream);
    } finally {
        stream.close(null);
    }
    info('screenshot:', path);
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

        // Start from a hidden, settled overview: the shell re-shows the
        // startup overview while the session settles, and show() on an
        // already visible overview emits nothing
        if (Main.overview.visible)
            Main.overview.hide();
        await waitFor(() => !Main.overview.visible &&
                            (!extHasDeadline || ext._unstableUntilMs <= nowMs()), 5000, 100);

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

        // --- D: no sampling through a window in front of the panel --------
        // An overview round trip with a fullscreen-like window keeps the
        // panel opaque; a desktop sample taken then reads the window content
        // and the corrected value arrives after the panel started fading
        // out, so the foreground class change killed the transition.
        const monitor = Main.layoutManager.primaryMonitor;
        const coverProbeY = Math.round(panelY + Main.panel.get_height() + 4);

        win.move_resize_frame(true, monitor.x, monitor.y, monitor.width, monitor.height);
        await waitFor(() => !Main.panel.has_style_class_name('transparent-top-bar'), 3000, 100);
        await sleep(600);
        const coveredLum = await samplePixel(Math.round(monitor.x + monitor.width / 2), coverProbeY);
        const beforeOverviewLum = ext._luminance.get('desktop');

        Main.overview.show();
        await waitStable();
        await sleep(400);
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible, 5000, 50);
        await sleep(700);

        const afterOverviewLum = ext._luminance.get('desktop');
        check('window content is not sampled as the desktop background',
            coveredLum !== null && afterOverviewLum !== undefined &&
            Math.abs(afterOverviewLum - coveredLum) > 0.2,
            `covered=${coveredLum?.toFixed(3)} wallpaper=${beforeOverviewLum?.toFixed(3)} ` +
            `desktop=${afterOverviewLum?.toFixed(3)}`);

        win.move_resize_frame(true, 60, Math.round(panelBottom + 400), 500, 300);
        ext._updateTransparent();
        await sleep(250);               // leave transition is running (500 ms)
        const leaveMidLum = await panelLuminance();
        await sleep(900);
        const leaveFinalLum = await panelLuminance();
        check('panel background still fades after an overview round trip',
            leaveMidLum !== null && leaveFinalLum !== null &&
            leaveMidLum > 0.05 && leaveMidLum < leaveFinalLum - 0.05,
            `mid=${leaveMidLum} final=${leaveFinalLum} ` +
            `classes="${Main.panel.get_style_class_name()}"`);

        // --- E: separate black/white text shadow settings ----------------
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

        // --- F: real top-edge shadow rendering and lifecycle -------------
        check('top edge shadow is disabled by default',
            !ext._settings.get_boolean('top-edge-shadow'));
        const workspace = global.workspace_manager.get_active_workspace();
        const areaBefore = workspace.get_work_area_for_monitor(monitor.index);
        const probeX = Math.round(monitor.x + monitor.width / 3);
        const probeY = Math.round(panelBottom + 4);
        const setEdgeShadow = async enabled => {
            ext._settings.set_boolean('top-edge-shadow', enabled);
            await sleep(800);
        };

        // Force light text to exercise the full-strength gradient.
        ext._settings.set_boolean('auto-foreground-color', false);
        await sleep(700);
        const unshaded = await samplePixel(probeX, probeY);
        await captureTopEdge('edge-shadow-off');
        await setEdgeShadow(true);
        const shaded = await samplePixel(probeX, probeY);
        const shadow = ext._topEdgeShadow;
        const shadowBottom = shadow.y + shadow.height;
        const halfway = await samplePixel(probeX, Math.round((probeY + shadowBottom) / 2));
        const below = await samplePixel(probeX, Math.ceil(shadowBottom + 4));
        const fullStrengthTop = await panelLuminance();
        check('enabled shadow darkens the strip below the panel',
            unshaded !== null && shaded !== null && shaded < unshaded - 0.025,
            `off=${unshaded} on=${shaded}`);
        check('shadow gently fades to the unchanged background',
            halfway > shaded && below > halfway && Math.abs(below - unshaded) < 0.015,
            `near=${shaded} middle=${halfway} below=${below}`);
        const areaAfter = workspace.get_work_area_for_monitor(monitor.index);
        check('shadow does not change the work area',
            areaBefore.x === areaAfter.x && areaBefore.y === areaAfter.y &&
            areaBefore.width === areaAfter.width && areaBefore.height === areaAfter.height);
        check('shadow does not intercept pointer events',
            !shadow.reactive && !shadow.can_focus &&
            global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, probeX, probeY) !== shadow);
        await captureTopEdge('edge-shadow-on');

        const compensated = await ext._sampleBackgroundLuminance('desktop');
        check('background sampling compensates for the rendered shadow',
            compensated !== null && Math.abs(compensated - unshaded) < 0.02,
            `wallpaper=${unshaded} sample=${compensated}`);

        ext._settings.set_double('foreground-luminance-threshold', 0.1);
        ext._settings.set_boolean('auto-foreground-color', true);
        await ext._refreshBackgroundLuminance();
        await sleep(800);
        const reducedTop = await panelLuminance();
        check('shadow is reduced behind dark text',
            Main.panel.has_style_class_name('transparent-top-bar-dark-text') &&
            reducedTop > fullStrengthTop + 0.06,
            `lightText=${fullStrengthTop} darkText=${reducedTop}`);
        for (let i = 0; i < 3; i++) {
            await ext._refreshBackgroundLuminance();
            await sleep(100);
        }
        check('repeated samples keep the wallpaper luminance and dark text stable',
            Math.abs(ext._luminance.get('desktop') - unshaded) < 0.02 &&
            Main.panel.has_style_class_name('transparent-top-bar-dark-text'));
        await captureTopEdge('edge-shadow-dark-text');

        ext._settings.set_boolean('auto-foreground-color', false);
        await sleep(800);
        ext._settings.set_int('top-edge-shadow-strength', 45);
        await sleep(800);
        const stronger = await samplePixel(probeX, probeY);
        check('strength setting changes the rendered gradient', stronger < shaded - 0.025,
            `default=${shaded} stronger=${stronger}`);
        ext._settings.set_int('top-edge-shadow-height', 128);
        await sleep(800);
        const extended = await samplePixel(probeX, Math.ceil(shadowBottom + 4));
        check('height setting extends the rendered shadow', extended < below - 0.025,
            `short=${below} tall=${extended}`);
        ext._settings.set_int('top-edge-shadow-strength', 0);
        await sleep(500);
        check('zero strength leaves the background unchanged',
            Math.abs(await samplePixel(probeX, probeY) - unshaded) < 0.015);
        ext._settings.reset('top-edge-shadow-strength');
        ext._settings.reset('top-edge-shadow-height');
        await sleep(800);

        win.move_frame(true, 60, 0);
        await waitFor(() => ext._panelTransparent === false);
        await sleep(700);
        check('shadow disappears when a window makes the bar opaque', shadow.opacity === 0);
        win.move_frame(true, 60, Math.round(panelBottom + 400));
        await waitFor(() => ext._panelTransparent === true);
        await sleep(800);
        check('shadow returns when the panel becomes transparent', shadow.opacity === 255);

        win.make_fullscreen();
        await waitFor(() => !Main.layoutManager.panelBox.visible);
        check('fullscreen hides the shadow with the panel', !shadow.visible);
        win.unmake_fullscreen();
        await waitFor(() => Main.layoutManager.panelBox.visible);
        win.move_frame(true, 60, Math.round(panelBottom + 400));
        await sleep(800);

        Main.overview.show();
        await waitStable();
        await sleep(500);
        // The overview is very dark: use the top row, where the gradient
        // has its full strength, instead of a tiny absolute delta below it.
        const shadedOverview = await panelLuminance();
        await setEdgeShadow(false);
        const plainOverview = await panelLuminance();
        check('shadow also renders over the overview background',
            plainOverview > shadedOverview + 0.015,
            `off=${plainOverview} on=${shadedOverview}`);
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible);
        await sleep(700);
        check('switching the shadow off restores the background',
            Math.abs(await samplePixel(probeX, probeY) - unshaded) < 0.015 && shadow.opacity === 0);

        await setEdgeShadow(true);
        ext.disable();
        check('disabling the extension removes the shadow actor',
            !Main.layoutManager.uiGroup.get_children().some(actor =>
                actor.name === 'transparent-top-bar-edge-shadow'));
        ext.enable();
        await sleep(800);
        check('re-enabling restores one shadow with the saved switch',
            ext._topEdgeShadow.opacity === 255 &&
            Main.layoutManager.uiGroup.get_children().filter(actor =>
                actor.name === 'transparent-top-bar-edge-shadow').length === 1);
        ext._settings.reset('top-edge-shadow');
        ext._settings.set_double('foreground-luminance-threshold', 0.7);
        ext._settings.set_boolean('auto-foreground-color', true);
    } catch (e) {
        failures.push(String(e));
        logError(e, `${TAG} test run failed`);
    }

    print(`${TAG} SUMMARY ${failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.join('; ')}`}`);
    global.context.terminate();
}
