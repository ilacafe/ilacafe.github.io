// Café Ila — why the tills stopped asking you to sign in twice a day.
//
// THE SESSION WAS NEVER THE PROBLEM
//
// Firebase keeps the sign-in itself. It restores it out of IndexedDB on the device,
// with no network and no credentials, and it has been doing that all along. What
// none of these pages kept was the ROLE — and every one of them refuses to show
// anything until it has read users/<uid> back from the database.
//
// So the shape of every app open was: paint the login form (it is in the markup with
// nothing hiding it), restore the session, then wait on a round trip over café wifi
// before taking the form down. For the whole of that wait a member of staff is
// looking at a sign-in screen, on a device that is already signed in. They read that
// as "it has signed me out again", because that is exactly what it looks like, and
// they start typing. Which is the complaint, and it was never wrong.
//
// Two things fix it, and both live here so that six pages cannot drift apart:
//
//   the role is remembered next to the session, so the second open has both and
//   goes straight in — then re-reads the role in the background and corrects
//   itself if it has changed;
//
//   the login box is not shown until something actually knows a sign-in is needed.
//   The whole box, not the fields inside it — hiding the inputs and leaving the box
//   up was the first attempt, and it was worse: a password field that appears in the
//   DOM is what makes a phone offer to fill it and open the keyboard, which it then
//   did on devices that were already signed in.
//
// THE REMEMBERED ROLE IS A CACHE FOR THE UI, AND ONLY THAT
//
// Safe to be exactly that, and worth being explicit about. Every role check inside
// these pages is advice to a cooperating browser — docs/database-access.md says so
// in as many words — and database.rules.json is what actually stops a read or a
// write. Editing this value in localStorage gets somebody a differently shaped
// screen and precisely the same permissions they had before.
//
// It is keyed by uid, so signing in as somebody else can never inherit the last
// person's role, and it is forgotten on sign-out and on any answer that says the
// account has no access.

(function () {
  var KEY = 'ila.role.v1';

  function stored() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }

  window.ilaRole = {
    // What we already knew about THIS uid, or null.
    recall: function (uid) {
      var r = stored();
      if (!r || !uid || r.uid !== uid || !r.role) return null;
      return { role: r.role, name: r.name || '' };
    },
    remember: function (uid, prof) {
      if (!uid || !prof || !prof.role) return;
      try {
        localStorage.setItem(KEY, JSON.stringify({
          uid: uid, role: prof.role, name: prof.name || ''
        }));
      } catch (e) {}
    },
    forget: function () { try { localStorage.removeItem(KEY); } catch (e) {} }
  };

  // ---------------------------------------------------------------- the box
  // No CSS anywhere: these pages each carry their own <style>, and six copies of a
  // rule is six chances to get one of them wrong. They already share the one class
  // that matters — #login-overlay.hidden { display: none } — so this only ever
  // toggles that.
  //
  // What it must NOT do is touch the fields inside. The first version hid the email
  // and password inputs and put "Checking sign-in…" in their place, which is worse
  // than what it replaced: a password field appearing in the DOM is what makes a
  // phone offer to fill it and throw up the keyboard, and it did that on devices
  // that were already signed in. The overlay is hidden or it is not.
  var FALLBACK_MS = 10000;
  var timer = null;

  function overlay() { return document.getElementById('login-overlay'); }
  function errorLine() { return document.getElementById('login-error'); }

  window.ilaLoginBox = {
    // Called the moment the page script runs. The markup already carries `hidden`
    // so there is no flash of a login box to hide — this only arms the safety net.
    checking: function () {
      clearTimeout(timer);
      // If auth never resolves at all — the SDK did not arrive — a device that shows
      // nothing and explains nothing is worse than one showing the form it used to.
      timer = setTimeout(function () { window.ilaLoginBox.ready(''); }, FALLBACK_MS);
    },
    ready: function (msg) {
      clearTimeout(timer);
      var o = overlay(); if (o) o.classList.remove('hidden');
      var e = errorLine(); if (e) e.innerText = msg || '';
    },
    hide: function () {
      clearTimeout(timer);
      var o = overlay(); if (o) o.classList.add('hidden');
      var e = errorLine(); if (e) e.innerText = '';
    }
  };
})();
