// 12-hour (AM/PM) picker for <input type="time">.
// A native time input shows 24-hour or 12-hour depending on the computer's region, and a page cannot
// change that. So each time input gets Hour / Minute / AM-PM selects next to it. The original input stays in the
// page (visually hidden) and keeps holding the value as "HH:MM" or "HH:MM:SS", so every script that reads
// or sets input.value keeps working, and its "input"/"change" events still fire.
(function () {
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

  function option(value, text) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    return o;
  }

  function enhance(input) {
    if (input.dataset.time12) return;
    input.dataset.time12 = "1";
    const optional = !input.required;
    const withSeconds = input.step === "1";
    const label = input.closest("label")?.querySelector("span")?.textContent?.trim() || "Time";

    const wrap = document.createElement("span");
    wrap.className = "time12";
    const hour = document.createElement("select");
    const minute = document.createElement("select");
    const ampm = document.createElement("select");
    hour.setAttribute("aria-label", `${label} hour`);
    minute.setAttribute("aria-label", `${label} minute`);
    ampm.setAttribute("aria-label", `${label} AM or PM`);
    if (optional) {
      hour.append(option("", "--"));
      minute.append(option("", "--"));
    }
    for (let h = 1; h <= 12; h++) hour.append(option(String(h), String(h)));
    for (let m = 0; m < 60; m++) minute.append(option(String(m).padStart(2, "0"), String(m).padStart(2, "0")));
    ampm.append(option("AM", "AM"), option("PM", "PM"));
    wrap.append(hour, minute, ampm);
    input.after(wrap);
    input.classList.add("time12-native");
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");

    // value "HH:MM[:SS]" -> selects
    function render() {
      const v = nativeValue.get.call(input);
      const m = /^(\d{1,2}):(\d{2})/.exec(v || "");
      if (!m) {
        hour.value = optional ? "" : "9";
        minute.value = optional ? "" : "00";
        ampm.value = "AM";
        return;
      }
      const h24 = Number(m[1]);
      hour.value = String(h24 % 12 || 12);
      minute.value = m[2];
      ampm.value = h24 >= 12 ? "PM" : "AM";
    }

    // selects -> value, then tell the page it changed
    function commit() {
      let next = "";
      if (hour.value) {
        if (!minute.value) minute.value = "00";
        const h12 = Number(hour.value) % 12;
        const h24 = ampm.value === "PM" ? h12 + 12 : h12;
        next = `${String(h24).padStart(2, "0")}:${minute.value}`;
        if (withSeconds) {
          const secs = /^\d{1,2}:\d{2}:(\d{2})/.exec(nativeValue.get.call(input) || "");
          next += `:${secs ? secs[1] : "00"}`;
        }
      } else {
        minute.value = "";
      }
      nativeValue.set.call(input, next);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    [hour, minute, ampm].forEach((s) => s.addEventListener("change", commit));

    // Scripts that set input.value (presets, edit dialogs) update the selects too.
    Object.defineProperty(input, "value", {
      configurable: true,
      get() { return nativeValue.get.call(this); },
      set(v) { nativeValue.set.call(this, v); render(); },
    });
    input.addEventListener("input", render); // e.g. typed or filled directly
    render();
  }

  function enhanceAll(root = document) {
    root.querySelectorAll('input[type="time"]').forEach(enhance);
  }

  window.enhanceTimeInputs = enhanceAll;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => enhanceAll());
  } else {
    enhanceAll();
  }
})();
