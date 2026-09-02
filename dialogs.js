// Café Ila — the app's own way of saying something, instead of the browser's.
//
// WHY alert() IS NOT A COSMETIC PROBLEM HERE
//
// Every device in this café is an iPad, an iPhone or an Android phone running these
// pages as a standalone app, and there were 86 calls to alert(), confirm() and
// prompt() across five of them. Four things are wrong with that, and only the first
// is about looks:
//
//   1. In a standalone web app the system renders a sheet naming the site. To staff
//      that reads as the browser interrupting, not as the till asking — it looks
//      like something has gone wrong with the app itself.
//
//   2. IT STOPS THE PAGE. alert() is synchronous: it blocks the event loop, so
//      every Firebase listener, every timer and every render is frozen until
//      somebody taps OK. A till left with an unattended alert is not merely showing
//      a dialog — it has stopped receiving orders, payments and menu changes. A
//      kitchen board goes quietly stale. That is the same silent failure the
//      connection bar exists to catch, caused deliberately.
//
//   3. Both Safari and Chrome offer to suppress repeated alerts. Once anyone taps
//      that, every later warning in the session is swallowed — the error path can
//      be switched off by the person it is warning.
//
//   4. It cannot show a list, carry the brand, be read across a kitchen, or — for
//      prompt() — say which keypad to open, which is the whole of what a number
//      field needs on a device with no keyboard.
//
// So: four ways of saying something, and choosing between them is the point.
//
//   ilaToast(text)                  transient. Nothing to decide, nothing to lose.
//   ilaFieldError(el, text)         a field is wrong. Marks it, says why, focuses it.
//   ilaTell(title, detail)          must be seen and acknowledged. One button.
//   ilaAsk(title, detail, opts)     must be decided. Two buttons, and can be armed.
//   ilaAskText(title, detail, opts) must be typed. Carries an inputmode.
//
// The last three return promises, so a call site reads the way confirm() did:
//
//     if (!await ilaAsk('End the day?', '…')) return;
//
// Styling is inline for the same reason connection.js does it: one file, five pages,
// no per-page CSS to keep in step.

(function () {
    'use strict';

    var BG = 'var(--brand-bg,#8D6E52)';
    var FG = 'var(--brand-text,#ffffff)';
    // Above the login overlay (99999), because a wrong PIN has to be sayable while
    // that overlay is up — which is exactly when it happens.
    var Z = 100000;

    var stack = [];

    function css(el, s) { el.style.cssText = s; return el; }

    function el(tag, style, text) {
        var n = document.createElement(tag);
        if (style) n.style.cssText = style;
        if (text != null) n.textContent = text;      // textContent, never innerHTML
        return n;
    }

    // --------------------------------------------------------------- the toast
    var toastHost = null;
    function host() {
        if (toastHost && toastHost.parentNode) return toastHost;
        toastHost = css(document.createElement('div'),
            'position:fixed;top:calc(12px + env(safe-area-inset-top));left:50%;' +
            'transform:translateX(-50%);width:92%;max-width:360px;z-index:' + Z + ';' +
            'display:flex;flex-direction:column;gap:8px;pointer-events:none');
        document.body.appendChild(toastHost);
        return toastHost;
    }

    window.ilaToast = function (text) {
        var t = el('div',
            'background:' + FG + ';color:' + BG + ';font-family:Quicksand,sans-serif;' +
            'font-size:0.9rem;font-weight:700;border-radius:8px;padding:13px 16px;' +
            'text-align:center;box-shadow:0 6px 20px rgba(0,0,0,0.25)', text);
        host().appendChild(t);
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3600);
    };

    // -------------------------------------------------- a field that is wrong
    //
    // No dialog at all. A modal for "address required" costs two taps and covers the
    // very field it is talking about — the largest group of these was this shape.
    window.ilaFieldError = function (target, text) {
        var f = (typeof target === 'string') ? document.getElementById(target) : target;
        if (!f) { window.ilaToast(text); return; }
        window.ilaClearFieldError(f);

        f.setAttribute('aria-invalid', 'true');
        f.dataset.ilaOutline = f.style.outline || '';
        f.style.outline = '2px solid ' + FG;
        f.style.outlineOffset = '1px';

        var msg = el('div',
            'font-family:Quicksand,sans-serif;font-size:0.78rem;font-weight:700;' +
            'letter-spacing:0.5px;color:' + FG + ';margin:6px 0 2px;text-align:left', text);
        msg.className = 'ila-field-error';
        msg.setAttribute('role', 'alert');
        if (f.parentNode) f.parentNode.insertBefore(msg, f.nextSibling);

        var clear = function () { window.ilaClearFieldError(f); };
        f.addEventListener('input', clear, { once: true });
        f.addEventListener('change', clear, { once: true });

        try { f.focus({ preventScroll: false }); } catch (e) { try { f.focus(); } catch (e2) {} }
    };

    window.ilaClearFieldError = function (target) {
        var f = (typeof target === 'string') ? document.getElementById(target) : target;
        if (!f) return;
        f.removeAttribute('aria-invalid');
        if (f.dataset && f.dataset.ilaOutline !== undefined) {
            f.style.outline = f.dataset.ilaOutline;
            delete f.dataset.ilaOutline;
        } else { f.style.outline = ''; }
        var sib = f.nextSibling;
        if (sib && sib.className === 'ila-field-error' && sib.parentNode) sib.parentNode.removeChild(sib);
    };

    // ------------------------------------------------------------ the dialogs
    function build(opts) {
        var overlay = css(document.createElement('div'),
            'position:fixed;inset:0;z-index:' + Z + ';background:rgba(0,0,0,0.55);' +
            'display:flex;align-items:center;justify-content:center;' +
            'padding:calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom))');
        overlay.className = 'ila-dialog';

        var card = css(document.createElement('div'),
            'background:' + BG + ';color:' + FG + ';border:1px solid rgba(255,255,255,0.25);' +
            'border-radius:12px;padding:22px;width:100%;max-width:380px;' +
            'font-family:Quicksand,sans-serif;max-height:100%;overflow-y:auto;' +
            'box-shadow:0 10px 40px rgba(0,0,0,0.35)');
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');

        var titleId = 'ila-dlg-t' + Math.random().toString(36).slice(2, 8);
        var h = el('div',
            'font-size:1rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;' +
            'margin-bottom:' + (opts.detail ? '10px' : '18px'), opts.title);
        h.id = titleId;
        card.setAttribute('aria-labelledby', titleId);
        card.appendChild(h);

        if (opts.detail) {
            // white-space:pre-line so the "\n- item" lists these replaced still read as
            // lists rather than as one run-on paragraph, which is how alert() showed them.
            card.appendChild(el('div',
                'font-size:0.92rem;line-height:1.55;white-space:pre-line;margin-bottom:18px',
                opts.detail));
        }
        return { overlay: overlay, card: card };
    }

    function button(text, primary) {
        var b = el('button',
            'flex:1 1 0;min-width:0;min-height:44px;padding:12px 14px;border-radius:6px;' +
            'font-family:Quicksand,sans-serif;font-size:0.9rem;font-weight:700;' +
            'text-transform:uppercase;letter-spacing:1px;cursor:pointer;' +
            (primary ? 'background:' + FG + ';color:' + BG + ';border:1px solid ' + FG
                     : 'background:transparent;color:' + FG + ';border:1px solid rgba(255,255,255,0.45)'),
            text);
        b.type = 'button';
        return b;
    }

    // One open/close path for all three, so focus restore and the key handling cannot
    // drift between them.
    function open(parts, onKeyEscape) {
        var previous = document.activeElement;
        parts.overlay.appendChild(parts.card);
        document.body.appendChild(parts.overlay);
        stack.push(parts.overlay);

        var focusables = function () {
            return Array.prototype.slice.call(parts.card.querySelectorAll(
                'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'))
                .filter(function (n) { return n.offsetWidth > 0 || n.offsetHeight > 0; });
        };

        parts.onKey = function (e) {
            if (stack[stack.length - 1] !== parts.overlay) return;   // only the top one
            if (e.key === 'Escape') { e.preventDefault(); onKeyEscape(); return; }
            if (e.key !== 'Tab') return;
            var f = focusables(); if (!f.length) return;
            var first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', parts.onKey, true);

        parts.close = function () {
            document.removeEventListener('keydown', parts.onKey, true);
            var i = stack.indexOf(parts.overlay); if (i >= 0) stack.splice(i, 1);
            if (parts.overlay.parentNode) parts.overlay.parentNode.removeChild(parts.overlay);
            try { if (previous && previous.focus) previous.focus(); } catch (e) {}
        };

        var f = focusables();
        if (f.length) { try { f[0].focus(); } catch (e) {} }
        return parts;
    }

    window.ilaTell = function (title, detail) {
        return new Promise(function (resolve) {
            var parts = build({ title: title, detail: detail });
            var row = el('div', 'display:flex;gap:10px');
            var ok = button('Okay', true);
            row.appendChild(ok);
            parts.card.appendChild(row);
            open(parts, function () { parts.close(); resolve(); });
            ok.addEventListener('click', function () { parts.close(); resolve(); });
        });
    };

    window.ilaAsk = function (title, detail, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var parts = build({ title: title, detail: detail });
            var row = el('div', 'display:flex;gap:10px');
            var no = button(opts.cancel || 'Cancel', false);
            var yes = button(opts.ok || 'Continue', true);
            // Cancel first, so the destructive answer is never the one under the thumb
            // that was already moving toward the button that opened this.
            row.appendChild(no); row.appendChild(yes);
            parts.card.appendChild(row);
            var done = function (v) { parts.close(); resolve(v); };
            open(parts, function () { done(false); });                 // Escape means no
            parts.overlay.addEventListener('click', function (e) {
                if (e.target === parts.overlay) done(false);           // backdrop means no
            });
            no.addEventListener('click', function () { done(false); });
            yes.addEventListener('click', function () { done(true); });
        });
    };

    // ------------------------------------------------- picking one of a list
    //
    // What a <select> raises is the platform's own wheel, and on iOS that is a grey
    // drum at the bottom of the screen with the app's colours nowhere in it. Same for
    // the date field. They are the correct CONTROLS, but they are not this app's
    // controls, and the till and the admin page are now the only screens that hand off
    // to something that does not look like the café.
    //
    // The native element STAYS. It is hidden, it keeps the value, and it is what every
    // `.value` read and every `onchange=` on these pages still talks to — thirteen
    // controls across two pages, none of whose call sites had to change. What changes
    // is what a thumb touches: a branded button that opens a branded list.
    window.ilaChoose = function (title, options, current) {
        return new Promise(function (resolve) {
            var parts = build({ title: title });
            var list = el('div', 'display:flex;flex-direction:column;gap:8px;margin-bottom:4px');
            options.forEach(function (o) {
                var on = String(o.value) === String(current);
                var b = el('button',
                    'display:block;width:100%;text-align:left;min-height:44px;padding:12px 14px;' +
                    'border-radius:6px;font-family:Quicksand,sans-serif;font-size:0.95rem;' +
                    'cursor:pointer;' +
                    // The one already chosen is filled, the way a selected chip is
                    // everywhere else here — not ticked, which reads as a checkbox.
                    (on ? 'background:' + FG + ';color:' + BG + ';border:1px solid ' + FG + ';font-weight:700'
                        : 'background:transparent;color:' + FG + ';border:1px solid rgba(255,255,255,0.35);font-weight:500'),
                    o.label);
                b.type = 'button';
                if (on) b.setAttribute('aria-current', 'true');
                b.addEventListener('click', function () { parts.close(); resolve(o.value); });
                list.appendChild(b);
            });
            parts.card.appendChild(list);
            var row = el('div', 'display:flex;gap:10px;margin-top:14px');
            var no = button('Cancel', false);
            row.appendChild(no);
            parts.card.appendChild(row);
            var done = function () { parts.close(); resolve(null); };
            open(parts, done);
            parts.overlay.addEventListener('click', function (e) { if (e.target === parts.overlay) done(); });
            no.addEventListener('click', done);
        });
    };

    // ------------------------------------------------------------ picking a date
    var MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    var iso = function (d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
               '-' + String(d.getDate()).padStart(2, '0');
    };

    window.ilaPickDate = function (title, currentISO) {
        return new Promise(function (resolve) {
            var picked = currentISO ? new Date(currentISO + 'T00:00:00') : new Date();
            if (isNaN(picked.getTime())) picked = new Date();
            var shown = new Date(picked.getFullYear(), picked.getMonth(), 1);

            var parts = build({ title: title });
            var head = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:10px');
            var prev = button('‹', false), label = el('div',
                'flex:1 1 auto;text-align:center;font-weight:700;font-size:0.95rem;' +
                'text-transform:uppercase;letter-spacing:1px'), next = button('›', false);
            prev.style.flex = '0 0 44px'; next.style.flex = '0 0 44px';
            prev.setAttribute('aria-label', 'Previous month');
            next.setAttribute('aria-label', 'Next month');
            head.appendChild(prev); head.appendChild(label); head.appendChild(next);
            parts.card.appendChild(head);

            var dows = el('div', 'display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:4px');
            ['M','T','W','T','F','S','S'].forEach(function (d) {
                dows.appendChild(el('div',
                    'text-align:center;font-size:0.7rem;font-weight:700;letter-spacing:1px', d));
            });
            parts.card.appendChild(dows);

            var grid = el('div', 'display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:14px');
            parts.card.appendChild(grid);

            function draw() {
                label.textContent = MONTHS[shown.getMonth()] + ' ' + shown.getFullYear();
                grid.textContent = '';
                // Monday-first, because the café's week is.
                var lead = (shown.getDay() + 6) % 7;
                for (var i = 0; i < lead; i++) grid.appendChild(el('div', ''));
                var days = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();
                for (var d = 1; d <= days; d++) {
                    var cell = new Date(shown.getFullYear(), shown.getMonth(), d);
                    var on = iso(cell) === iso(picked);
                    var b = el('button',
                        'min-height:44px;border-radius:6px;font-family:Quicksand,sans-serif;' +
                        'font-size:0.9rem;cursor:pointer;padding:0;' +
                        (on ? 'background:' + FG + ';color:' + BG + ';border:1px solid ' + FG + ';font-weight:700'
                            : 'background:transparent;color:' + FG + ';border:1px solid rgba(255,255,255,0.2)'),
                        String(d));
                    b.type = 'button';
                    b.setAttribute('aria-label', d + ' ' + MONTHS[shown.getMonth()] + ' ' + shown.getFullYear());
                    if (on) b.setAttribute('aria-current', 'date');
                    (function (when) {
                        b.addEventListener('click', function () { parts.close(); resolve(iso(when)); });
                    })(cell);
                    grid.appendChild(b);
                }
            }
            prev.addEventListener('click', function () { shown.setMonth(shown.getMonth() - 1); draw(); });
            next.addEventListener('click', function () { shown.setMonth(shown.getMonth() + 1); draw(); });
            draw();

            var row = el('div', 'display:flex;gap:10px');
            var no = button('Cancel', false);
            row.appendChild(no);
            parts.card.appendChild(row);
            var done = function () { parts.close(); resolve(null); };
            open(parts, done);
            parts.overlay.addEventListener('click', function (e) { if (e.target === parts.overlay) done(); });
            no.addEventListener('click', done);
        });
    };

    window.ilaAskText = function (title, detail, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var parts = build({ title: title, detail: detail });
            var input = document.createElement('input');
            // NEVER type="password", AND NEVER -webkit-text-security.
            //
            // This shipped with type="password" on the three PIN prompts, which put back
            // the exact thing pin-mask.js exists to keep out: iOS scans the document for a
            // field it considers SECURE and offers to fill it — "Sign in to ila.cafe with
            // your password for …" — over a working till, mid-service, on a device that is
            // already signed in. A system sheet, in the middle of a void.
            //
            // pin-mask.js has the note in full, including that changing the type and
            // keeping the CSS bought nothing: WebKit classifies on the masking, not the
            // type. So there is no secure field here either. `mask: true` gives a plain
            // numeric text box whose digits live in pin-mask.js and whose box shows
            // bullets, and nothing in the document says password.
            input.type = 'text';
            if (opts.mask) {
                input.setAttribute('data-pin', '');
                input.setAttribute('autocomplete', 'off');
                input.setAttribute('autocorrect', 'off');
                input.setAttribute('autocapitalize', 'off');
                input.setAttribute('spellcheck', 'false');
                if (!opts.maxlength) input.maxLength = 4;
            }
            // The reason prompt() had to go: on a device with no keyboard, the keypad a
            // field raises IS its input method, and prompt() cannot ask for one.
            if (opts.inputmode) input.setAttribute('inputmode', opts.inputmode);
            if (opts.placeholder) input.placeholder = opts.placeholder;
            if (opts.value != null) input.value = String(opts.value);
            if (opts.maxlength) input.maxLength = opts.maxlength;
            input.setAttribute('aria-label', opts.label || title);
            css(input,
                'width:100%;box-sizing:border-box;min-height:44px;padding:12px;' +
                'border-radius:6px;border:1px solid rgba(255,255,255,0.45);' +
                'background:rgba(0,0,0,0.15);color:' + FG + ';font-family:Quicksand,sans-serif;' +
                'font-size:1rem;margin-bottom:16px');
            parts.card.appendChild(input);
            // If pin-mask.js is not on this page the field still works and still reads
            // correctly — the PIN is visible while typing, which is a worse screen but
            // not a broken till. That is pin-mask's own trade-off, kept.
            if (opts.mask && window.ilaPin && window.ilaPin.bind) window.ilaPin.bind(input);
            var read = function () {
                return (opts.mask && window.ilaPin && window.ilaPin.value)
                    ? window.ilaPin.value(input) : input.value;
            };

            var row = el('div', 'display:flex;gap:10px');
            var no = button(opts.cancel || 'Cancel', false);
            var yes = button(opts.ok || 'Okay', true);
            row.appendChild(no); row.appendChild(yes);
            parts.card.appendChild(row);

            var done = function (v) { parts.close(); resolve(v); };
            open(parts, function () { done(null); });
            parts.overlay.addEventListener('click', function (e) {
                if (e.target === parts.overlay) done(null);
            });
            no.addEventListener('click', function () { done(null); });
            yes.addEventListener('click', function () { done(read()); });
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); done(read()); }
            });
            try { input.focus(); input.select(); } catch (e) {}
        });
    };
    // ---------------------------------------- wearing the app's clothes instead
    //
    // The native control keeps the value and keeps every listener. It is moved out of
    // sight rather than removed, so `.value`, `.selectedIndex`, `onchange=` and every
    // read on these pages go on working exactly as they did — thirteen controls across
    // admin and analytics, and not one call site changed.
    //
    // What a thumb touches is a button in the app's own language, which opens the app's
    // own list or calendar. Changing the value dispatches a real `change` event, which
    // is what those `onchange=` attributes are listening for.
    //
    // If this never runs — a script error, an old cache — every one of those controls
    // is still a working native select or date field. The screen is less consistent and
    // nothing is broken, which is the right way round.
    function faceFor(src) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ila-face';
        // Layout comes from wherever the native control got it; appearance does not.
        var st = src.style;
        b.style.cssText =
            'display:flex;align-items:center;justify-content:space-between;gap:10px;' +
            'min-height:44px;padding:12px 14px;border-radius:6px;box-sizing:border-box;' +
            'background:transparent;color:' + FG + ';border:1px solid rgba(255,255,255,0.4);' +
            'font-family:Quicksand,sans-serif;font-size:0.95rem;font-weight:500;' +
            'text-align:left;cursor:pointer;width:100%;' +
            (st.flex ? 'flex:' + st.flex + ';' : '') +
            (st.minWidth ? 'min-width:' + st.minWidth + ';' : '') +
            (st.margin ? 'margin:' + st.margin + ';' : '');
        return b;
    }

    function paint(btn, text, chevron) {
        // Idempotent on purpose. The observer below re-syncs every face whenever the
        // document changes, and rewriting a button's children IS a document change —
        // so a paint that always writes feeds itself and pins the main thread. Writing
        // only when the text actually differs makes the loop converge on the first
        // pass, which is the difference between this working and the page hanging.
        if (btn.__ilaText === text) return;
        btn.__ilaText = text;
        btn.textContent = '';
        var t = document.createElement('span');
        t.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        t.textContent = text;
        var c = document.createElement('span');
        // NOT opacity. 0.7 white on this brown is 3.92:1 and the contrast suite caught
        // it, which is the same mistake this app already made once and fixed: hierarchy
        // comes from size, not from dimming, because the brown has no room to dim into.
        c.style.cssText = 'flex:0 0 auto;font-size:0.75em';
        c.textContent = chevron;
        btn.appendChild(t); btn.appendChild(c);
    }

    function hide(el) {
        // Out of sight, still in the document, still the thing that holds the value.
        el.style.position = 'absolute';
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        el.style.width = '1px';
        el.style.height = '1px';
        el.setAttribute('tabindex', '-1');
        el.setAttribute('aria-hidden', 'true');
    }

    function named(el) {
        // Whatever the control is called on screen, so the modal has a title rather
        // than a bare list: its aria-label, its <label>, or the section above it.
        return el.getAttribute('aria-label') ||
               (el.id && (document.querySelector('label[for="' + el.id + '"]') || {}).textContent) ||
               (el.previousElementSibling && /LABEL|DIV|SPAN/.test(el.previousElementSibling.tagName) &&
                (el.previousElementSibling.textContent || '').trim().slice(0, 40)) ||
               'Choose';
    }

    function enhanceSelect(sel) {
        if (sel.__ilaFaced || sel.multiple) return;
        sel.__ilaFaced = true;
        var btn = faceFor(sel);
        var title = named(sel).trim() || 'Choose';

        var sync = function () {
            var o = sel.options[sel.selectedIndex];
            paint(btn, o ? o.text : '', '▾');
            btn.disabled = sel.disabled;
            btn.style.opacity = sel.disabled ? '0.5' : '1';
            btn.setAttribute('aria-label', title + ': ' + (o ? o.text : ''));
        };

        btn.addEventListener('click', async function () {
            if (sel.disabled) return;
            var opts = Array.prototype.map.call(sel.querySelectorAll('option'), function (o) {
                return { value: o.value, label: o.text };
            });
            if (!opts.length) return;
            var picked = await window.ilaChoose(title, opts, sel.value);
            if (picked === null) return;
            sel.value = picked;
            sync();
            // A real event, because that is what every onchange= on these pages is on.
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        });

        sel.parentNode.insertBefore(btn, sel);
        hide(sel);
        sel.__ilaSync = sync;
        sync();
    }

    function enhanceDate(inp) {
        if (inp.__ilaFaced) return;
        inp.__ilaFaced = true;
        var btn = faceFor(inp);
        var title = named(inp).trim() || 'Pick a date';

        var sync = function () {
            var v = inp.value;
            var shown = v;
            if (v) {
                var d = new Date(v + 'T00:00:00');
                if (!isNaN(d.getTime())) shown = d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear();
            }
            paint(btn, shown || (inp.placeholder || 'Pick a date'), '▾');
            btn.setAttribute('aria-label', title + ': ' + (shown || 'not set'));
        };

        btn.addEventListener('click', async function () {
            var picked = await window.ilaPickDate(title, inp.value);
            if (picked === null) return;
            inp.value = picked;
            sync();
            inp.dispatchEvent(new Event('change', { bubbles: true }));
        });

        inp.parentNode.insertBefore(btn, inp);
        hide(inp);
        inp.__ilaSync = sync;
        sync();
    }

    window.ilaEnhanceControls = function (root) {
        var r = root || document;
        if (!r.querySelectorAll) return;

        // The root ITSELF, first. querySelectorAll only ever returns descendants, and
        // the node the observer hands over is frequently the control — `innerHTML = '…
        // <select>…'` adds the select, not a wrapper around it. Looking only at
        // descendants left every runtime-built control bare, which is both of the two
        // on admin that are built at runtime.
        if (r.matches) {
            try {
                if (r.matches('select:not([data-ila-native])')) { enhanceSelect(r); return; }
                if (r.matches('input[type="date"]:not([data-ila-native])')) { enhanceDate(r); return; }
            } catch (e) {}
        }

        var sels = r.querySelectorAll('select:not([data-ila-native])');
        for (var i = 0; i < sels.length; i++) { try { enhanceSelect(sels[i]); } catch (e) {} }
        var dates = r.querySelectorAll('input[type="date"]:not([data-ila-native])');
        for (var j = 0; j < dates.length; j++) { try { enhanceDate(dates[j]); } catch (e) {} }
    };

    // Two of these are built at runtime — the role picker on each staff row, and the
    // ingredient rows on a recipe — so watching is not optional. And a page that sets
    // select.value in code has to be able to say so: __ilaSync re-reads it.
    function watch() {
        window.ilaEnhanceControls(document);
        if (!window.MutationObserver) return;
        new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                var added = muts[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    if (added[j].nodeType === 1) window.ilaEnhanceControls(added[j]);
                }
            }
            // Anything re-rendered under a face that still exists may hold a new value.
            var faced = document.querySelectorAll('select, input[type="date"]');
            for (var k = 0; k < faced.length; k++) {
                if (faced[k].__ilaSync) faced[k].__ilaSync();
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
    else watch();
})();
