// Café Ila — masking a staff PIN without telling Safari it is a password.
//
// WHY THIS EXISTS RATHER THAN type="password"
//
// iOS scans the document when a page loads, and if it finds a field it considers
// SECURE it offers to fill it: "Sign in to ila.cafe with your password for …",
// over a working till, in the middle of service, on a device already signed in.
//
// Two things make a field secure to WebKit, and both were tried here:
//
//   type="password"                the PIN prompt had this from the beginning
//   -webkit-text-security          what it was changed to, which is no better
//
// The second is the part worth writing down, because it looks like a fix and is
// not: the input becomes type="text" and Safari still classifies it as secure,
// because the classification follows the masking rather than the type. Changing
// the type and keeping the CSS bought exactly nothing, and cost a deploy to find
// out.
//
// So there is no secure field. The input is a plain numeric text box, the digits
// live here, and the box shows bullets. Nothing in the document says password.
//
// IF THIS FILE DOES NOT LOAD the field still works and still reads correctly —
// value() falls back to the element's own value, which is exactly what the user
// typed. The PIN would be visible while typing, which is a worse screen but not a
// broken till, and that is the right way round.

(function () {
  var BULLET = '•';
  var digits = new WeakMap();

  function onInput(el) {
    var shown = el.value || '';
    var had = digits.get(el) || '';

    // The box holds bullets for everything already entered, so anything that is
    // not a bullet is a keystroke that has just landed. Shorter than before means
    // a backspace. Both cases are decided by length, which is all a fixed-length
    // numeric PIN needs — no cursor arithmetic, nothing to get subtly wrong.
    var typed = shown.replace(new RegExp(BULLET, 'g'), '').replace(/\D/g, '');
    var next;
    if (shown.length < had.length) next = had.slice(0, shown.length);
    else next = (had + typed);

    var max = parseInt(el.getAttribute('maxlength'), 10) || 4;
    next = next.slice(0, max);
    digits.set(el, next);
    el.value = new Array(next.length + 1).join(BULLET);
  }

  window.ilaPin = {
    // Call once per PIN field. Safe to call again.
    bind: function (el) {
      if (!el || el.__ilaPinBound) return;
      el.__ilaPinBound = true;
      digits.set(el, '');
      el.addEventListener('input', function () { onInput(el); });
    },
    // What was actually typed. Falls back to the box itself, so a page that never
    // bound the field — or never loaded this script — still reads a real PIN.
    value: function (el) {
      if (!el) return '';
      var d = digits.get(el);
      return (d === undefined ? (el.value || '') : d);
    },
    clear: function (el) {
      if (!el) return;
      digits.set(el, '');
      el.value = '';
    }
  };

  // Bind anything marked in the markup, once the document has it.
  function bindAll() {
    var els = document.querySelectorAll('input[data-pin]');
    for (var i = 0; i < els.length; i++) window.ilaPin.bind(els[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindAll);
  else bindAll();
})();
