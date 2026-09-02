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

    window.ilaAskText = function (title, detail, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var parts = build({ title: title, detail: detail });
            var input = document.createElement('input');
            input.type = opts.type || 'text';
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
            yes.addEventListener('click', function () { done(input.value); });
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
            });
            try { input.focus(); input.select(); } catch (e) {}
        });
    };
})();
