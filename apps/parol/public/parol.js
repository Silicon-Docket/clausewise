/*
 * Parol's one script. Every page works with it blocked: it only adds shortcuts, scrolls a quote
 * into view, stops a double submit and refreshes a running review's progress. Text from the server
 * is only ever written with textContent, never as markup, and the one request it makes goes to a
 * same-origin path the page itself names.
 */
(function () {
  "use strict";

  var doc = document;
  var win = window;

  function typingIn(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    return (
      tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true
    );
  }

  function prefersReducedMotion() {
    return (
      typeof win.matchMedia === "function" &&
      win.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  /* Keyboard: j and k move through the issue table, Enter opens the row, ? lists the keys. The
     letter keys act only while focus is inside the table (WCAG 2.1.4). */
  function setupKeys() {
    var table = doc.querySelector("[data-issue-table]");
    var help = doc.querySelector("[data-keys-help]");
    if (!table) return;
    var links = Array.prototype.slice.call(table.querySelectorAll("[data-row-link]"));
    var index = -1;
    links.forEach(function (link, i) {
      if (link.getAttribute("aria-current") === "true") index = i;
    });

    function mark(i) {
      links.forEach(function (link, k) {
        var row = link.closest("tr");
        if (row) row.classList.toggle("is-current", k === i);
      });
    }

    function move(step) {
      if (links.length === 0) return;
      if (index === -1) index = step > 0 ? 0 : links.length - 1;
      else index = Math.min(links.length - 1, Math.max(0, index + step));
      mark(index);
      var link = links[index];
      link.focus();
      link.scrollIntoView({ block: "nearest" });
    }

    doc.addEventListener("keydown", function (event) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      var key = event.key;
      var at = event.target;
      if (key === "Escape" && help && help.open) help.open = false;
      if (typingIn(at) || !at || typeof at.closest !== "function") return;
      if (!at.closest('[data-zone="issues"]')) return;
      if (key === "j" || key === "k") {
        event.preventDefault();
        move(key === "j" ? 1 : -1);
      } else if (key === "Enter") {
        // A focused link opens itself. This covers focus on the table's own box.
        if (index >= 0 && at.getAttribute("data-zone") === "issues") {
          event.preventDefault();
          links[index].click();
        }
      } else if (key === "?" && help) {
        event.preventDefault();
        help.open = !help.open;
        var summary = help.querySelector("summary");
        if (help.open && summary) summary.focus();
      }
    });
  }

  /* Show the highlighted quote and the chosen row, and put focus on the evidence inspector when
     the page opens on a chosen finding, so a keyboard user starts at the evidence. */
  function showSelection() {
    var quote = doc.querySelector("mark[data-quote]");
    var row = doc.querySelector("[data-issue-table] tr.is-selected");
    var pane = doc.querySelector("[data-inspector]");
    var behavior = prefersReducedMotion() ? "auto" : "smooth";
    if (row) row.scrollIntoView({ block: "nearest" });
    if (row && pane && !win.location.hash && doc.activeElement === doc.body) {
      pane.focus({ preventScroll: true });
    }
    if (quote) quote.scrollIntoView({ block: "center", behavior: behavior });
  }

  /* A submitted form cannot be submitted twice. The buttons come back if the page is restored
     from the back-forward cache, or if the response was a download that left the page in place. */
  function setupBusyButtons() {
    function restore(buttons) {
      buttons.forEach(function (button) {
        button.disabled = false;
        button.removeAttribute("data-busy");
      });
    }

    doc.addEventListener("submit", function (event) {
      var form = event.target;
      if (!form || form.tagName !== "FORM") return;
      var buttons = Array.prototype.filter.call(form.elements, function (el) {
        return el.type === "submit" && !el.disabled;
      });
      // After the event, so a clicked button's own name and value are still sent.
      win.setTimeout(function () {
        buttons.forEach(function (button) {
          button.disabled = true;
          button.setAttribute("data-busy", "");
        });
      }, 0);
      win.setTimeout(function () {
        restore(buttons);
      }, 15000);
    });

    win.addEventListener("pageshow", function (event) {
      if (event.persisted) restore(Array.prototype.slice.call(doc.querySelectorAll("[data-busy]")));
    });
  }

  /* Progress of a running review, from a JSON route the page names in data-status-url. */
  var TERMINAL = /^(succeeded|failed|cancelled|superseded)$/;
  var INTERVAL_MS = 2000;
  var MAX_FAILURES = 5;

  function sameOriginPath(value) {
    return (
      typeof value === "string" &&
      value.charAt(0) === "/" &&
      value.charAt(1) !== "/" &&
      value.indexOf("\\") === -1
    );
  }

  function setText(root, role, text) {
    var el = root.querySelector('[data-role="' + role + '"]');
    if (el) el.textContent = String(text);
  }

  /* Reloads at most three times a minute, so a page and a status route that disagree cannot
     loop. Returns whether a reload was started. */
  function reloadOnce() {
    try {
      var parts = String(win.sessionStorage.getItem("parol-reload") || "0:0").split(":");
      var count = Number(parts[0]);
      var since = Number(parts[1]);
      if (Date.now() - since > 60000) {
        count = 0;
        since = Date.now();
      }
      if (count >= 3) return false;
      win.sessionStorage.setItem("parol-reload", String(count + 1) + ":" + String(since));
    } catch (e) {
      /* Storage can be blocked. Then one reload is all this page tab gets. */
    }
    win.location.reload();
    return true;
  }

  /* Returns whether to keep polling. An answer that is not shaped like a status is an error. */
  function applyStatus(live, data) {
    if (!data || typeof data !== "object" || typeof data.status !== "string") {
      throw new Error("shape");
    }
    var finished = data.finished === true || TERMINAL.test(data.status);
    if (finished) {
      // Do not throw away what someone is typing. Say it is done and stop.
      if (typingIn(doc.activeElement) || !reloadOnce()) {
        setText(live, "stage", "Finished. Reload the page to see the results.");
      }
      return false;
    }
    if (typeof data.label === "string") setText(live, "stage", data.label);
    var progress = data.progress;
    if (progress && Number.isFinite(progress.done) && Number.isFinite(progress.total)) {
      setText(live, "done", progress.done);
      setText(live, "total", progress.total);
      var bar = live.querySelector('[data-role="bar"]');
      if (bar) {
        bar.max = Math.max(progress.total, 1);
        bar.value = progress.done;
      }
    }
    return true;
  }

  function setupPolling() {
    var live = doc.querySelector("[data-status-url]");
    if (!live) return;
    var url = live.getAttribute("data-status-url");
    if (!sameOriginPath(url) || typeof win.fetch !== "function") return;
    var failures = 0;

    function schedule() {
      win.setTimeout(tick, INTERVAL_MS);
    }

    function tick() {
      if (doc.hidden) return schedule();
      win
        .fetch(url, {
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        })
        .then(function (response) {
          if (!response.ok) throw new Error("status");
          return response.json();
        })
        .then(function (data) {
          var again = applyStatus(live, data);
          failures = 0;
          return again;
        })
        .catch(function () {
          failures += 1;
          return failures < MAX_FAILURES;
        })
        .then(function (again) {
          if (again) schedule();
        });
    }

    schedule();
  }

  function start() {
    setupKeys();
    showSelection();
    setupBusyButtons();
    setupPolling();
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start);
  else start();
})();
