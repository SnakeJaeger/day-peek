/* Day Peek — mini calendar + the selected day's daily note, editable in place.
 * Made by Tailnet 4 in 2026 (written by Big Len, the team's Claude Code). Plain JS, no build step.
 * Uses the core Daily notes settings (folder, format, template).
 * The editor is Obsidian's own embedded markdown editor (same trick Kanban uses).
 */
const { Plugin, ItemView, TFile, Notice, normalizePath, moment, Platform,
  PluginSettingTab, Setting, MarkdownRenderer, setIcon, Modal } = require("obsidian");

const VIEW_TYPE = "day-peek";
const DEFAULTS = { openLocation: "auto", gridMode: "month", lastShown: "month", openOnStartup: "mobile", hideWhileTyping: "mobile", foldStyle: "slide", hideStatusBar: false, sidebarWidth: "", sidebarMaxWidth: "" };
const MODES = ["month", "week", "none"];   // what sits under the header: month grid, one-week strip, nothing

// ---------- daily-note helpers ----------
function dnOptions(app) {
  const o = app.internalPlugins?.getPluginById?.("daily-notes")?.instance?.options || {};
  return {
    format: o.format || "YYYY-MM-DD",
    folder: (o.folder || "").replace(/^\/+|\/+$/g, ""),
    template: (o.template || "").trim(),
  };
}
function notePath(app, m) {
  const { format, folder } = dnOptions(app);
  const name = m.format(format) + ".md";
  return normalizePath(folder ? `${folder}/${name}` : name);
}
function getNote(app, m) {
  const f = app.vault.getAbstractFileByPath(notePath(app, m));
  return f instanceof TFile ? f : null;
}
function inDailyFolder(app, path) {
  const { folder } = dnOptions(app);
  return !folder || path.startsWith(folder + "/");
}
// Same variables as the core Daily notes / Calendar plugins.
function fillTemplate(text, m, format) {
  const title = m.format(format);
  return text
    .replace(/{{\s*date\s*}}/gi, title)
    .replace(/{{\s*time\s*}}/gi, moment().format("HH:mm"))
    .replace(/{{\s*title\s*}}/gi, title)
    .replace(/{{\s*(date|time)\s*(([+-]\d+)([yqmwdhs]))?\s*(:.+?)?}}/gi,
      (_all, kind, calc, n, unit, fmt) => {
        const t = m.clone().set({ hour: moment().hour(), minute: moment().minute(), second: 0 });
        if (calc) t.add(parseInt(n, 10), unit);
        return fmt ? t.format(fmt.substring(1).trim()) : t.format(kind === "time" ? "HH:mm" : format);
      })
    .replace(/{{\s*yesterday\s*}}/gi, m.clone().subtract(1, "day").format(format))
    .replace(/{{\s*tomorrow\s*}}/gi, m.clone().add(1, "day").format(format));
}
async function createNote(app, m) {
  const { format, folder, template } = dnOptions(app);
  let body = "";
  if (template) {
    const tf = app.vault.getAbstractFileByPath(normalizePath(template)) ||
      app.vault.getAbstractFileByPath(normalizePath(template + ".md")) ||
      app.metadataCache.getFirstLinkpathDest(template, "");
    if (tf instanceof TFile) body = await app.vault.cachedRead(tf);
    else new Notice(`Day Peek: template "${template}" not found, creating an empty note`);
  }
  if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
  return app.vault.create(notePath(app, m), fillTemplate(body, m, format));
}

// ---------- the view ----------
// 0.8.0 layout:
//   header:  [▲▼ cycle month] | Nov | '26 | ‹ 9 › | TODAY
//   below:   the calendar, drawn over the top of the note's scroll area. Scrolling the note
//            folds it away in steps (rows → the selected week → its numbers slide under the
//            weekday names → the names slide under the header); scrolling back unfolds it.
// Nothing in the header or calendar takes focus, so the phone keyboard stays up.
const FOLDS = ["slide", "cascade", "off"];

function triangleBtn(parent, up, label) {
  const b = parent.createEl("button", { cls: "dp-tri", attr: { "aria-label": label } });
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 12");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", up ? "M2 11 L12 2 L22 11 Z" : "M2 1 L12 10 L22 1 Z");
  svg.appendChild(p);
  b.appendChild(svg);
  return b;
}

class DayPeekView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.date = moment().startOf("day");
    this.month = this.date.clone().startOf("month");   // the month the calendar shows (can differ while browsing)
    this.peek = null;                                   // null | "days" | "months" | "years": shown full, over the note
    this.embed = null;
    this.file = null;
    this.lastToday = moment().format("YYYY-MM-DD");
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Day Peek"; }
  getIcon() { return "calendar-days"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("day-peek");

    const head = root.createDiv("day-peek-head");
    const cyc = head.createDiv("dp-cycle");
    triangleBtn(cyc, true, "Previous month").onclick = () => this.browse(-1);
    triangleBtn(cyc, false, "Next month").onclick = () => this.browse(1);
    head.createDiv("dp-sep");
    this.monthBtn = head.createEl("button", { cls: "dp-month", attr: { "aria-label": "Pick a month" } });
    head.createDiv("dp-sep");
    this.yearBtn = head.createEl("button", { cls: "dp-year", attr: { "aria-label": "Pick a year" } });
    head.createDiv("dp-sep");
    const dayBox = head.createDiv("dp-daybox");
    const prev = dayBox.createEl("button", { cls: "dp-step", text: "‹", attr: { "aria-label": "Previous day" } });
    this.dayBtn = dayBox.createEl("button", { cls: "dp-day", attr: { "aria-label": "Show the calendar" } });
    const next = dayBox.createEl("button", { cls: "dp-step", text: "›", attr: { "aria-label": "Next day" } });
    head.createDiv("dp-sep");
    this.todayBtn = head.createEl("button", { cls: "dp-today", attr: { "aria-label": "Go to today" } });
    this.todayBtn.createSpan({ text: "Today" });

    this.monthBtn.onclick = () => this.togglePeek("months");
    this.yearBtn.onclick = () => this.togglePeek("years");
    this.dayBtn.onclick = () => this.togglePeek("days");
    prev.onclick = () => this.select(this.date.clone().subtract(1, "day"));
    next.onclick = () => this.select(this.date.clone().add(1, "day"));
    this.todayBtn.onclick = () => this.select(moment().startOf("day"));

    const stage = root.createDiv("day-peek-stage");
    this.bodyEl = stage.createDiv("day-peek-body");
    this.spacerEl = this.bodyEl.createDiv("day-peek-spacer");
    this.noteEl = this.bodyEl.createDiv("day-peek-note");
    this.calEl = stage.createDiv("day-peek-cal");
    this.gridEl = this.calEl;   // (old name, kept for anything that still asks)

    // Keep the keyboard up: a tap on the header or calendar must not take focus from the note.
    for (const el of [head, this.calEl]) this.registerDomEvent(el, "mousedown", (e) => e.preventDefault());

    // the fold follows the note's scroll position
    this.registerDomEvent(this.bodyEl, "scroll", () => this.queueLayout(), { passive: true });
    // a calendar shown with a tap goes away when you go back to the note
    const unpeek = () => { if (this.peek) { this.peek = null; this.renderGrid(); } };
    this.registerDomEvent(this.bodyEl, "wheel", unpeek, { passive: true });
    this.registerDomEvent(this.bodyEl, "touchstart", unpeek, { passive: true });
    this.registerDomEvent(this.bodyEl, "mousedown", unpeek);
    if (window.ResizeObserver) {
      this.resizeObs = new ResizeObserver(() => this.queueLayout(true));
      this.resizeObs.observe(stage);
    }

    // keep dots + note in step with the vault (Syncthing, other devices, etc.)
    const touch = (file, oldPath) => {
      const p = file?.path || "";
      if (!inDailyFolder(this.app, p) && !(oldPath && inDailyFolder(this.app, oldPath))) return;
      this.renderGrid();
      const want = notePath(this.app, this.date);
      if ((p === want || oldPath === want || this.file?.path === oldPath) && !this.isTyping()) this.showNote();
    };
    // save when leaving the editor, and when the app goes to the background (phone)
    this.registerDomEvent(this.bodyEl, "focusout", () => {
      this.flush();
      window.setTimeout(() => { if (!this.isTyping()) this.setTyping(false); }, 0);   // focus left the note
    });
    // typing on a phone: fold the calendar away so the note gets the room (setting)
    this.registerDomEvent(this.bodyEl, "focusin", (e) => {
      // Obsidian's editor focuses itself when a note loads: on a phone that pops the keyboard
      // up on every day you tap. If you weren't typing, give the focus straight back.
      if (this.guardFocus()) return;
      this.setTyping(true);
    });
    this.registerDomEvent(document, "visibilitychange", () => { if (document.hidden) this.flush(); });
    this.registerEvent(this.app.vault.on("create", (f) => touch(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => touch(f)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => touch(f, old)));
    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f === this.file && !this.isTyping()) this.reloadIfChanged();
    }));
    // roll over to the new day at midnight if we were on "today"
    this.registerInterval(window.setInterval(() => {
      const now = moment().format("YYYY-MM-DD");
      if (now === this.lastToday) return;
      const wasToday = this.date.format("YYYY-MM-DD") === this.lastToday;
      this.lastToday = now;
      if (wasToday && !this.isTyping()) this.select(moment().startOf("day"));
      else this.renderGrid();
    }, 60 * 1000));

    await this.select(this.date);
  }

  async onClose() {
    if (this.resizeObs) this.resizeObs.disconnect();
    await this.dropEmbed();
  }

  /** ▲▼ : show the previous/next month without changing the selected day. */
  browse(dir) {
    this.month = this.month.clone().add(dir, "month");
    // nothing of the grid on screen? show it, otherwise you'd be paging blind
    if (!this.peek && this.rowsHidden()) this.peek = "days";
    if (this.peek && this.peek !== "days") this.peek = "days";
    this.renderGrid();
  }

  togglePeek(what) {
    this.peek = this.peek === what ? null : what;
    if (this.peek === "years") this.yearsAt = null;   // centre on the shown year again
    this.renderGrid();
  }

  /** Right after a note loads: if the editor took focus you didn't give it, hand it back. */
  guardFocus() {
    if (Date.now() >= (this.noFocusUntil || 0) || !this.bodyEl.contains(document.activeElement)) return false;
    document.activeElement.blur();
    this.prevFocus?.focus?.({ preventScroll: true });
    return true;
  }

  /** While the note has focus (typing), fold the calendar away if the setting says so. Not saved. */
  setTyping(on) {
    const s = this.plugin.settings.hideWhileTyping;
    const allowed = s === "always" || (s === "mobile" && Platform.isMobile);
    const want = !!(on && allowed);
    if (want === !!this.typing) return;
    this.typing = want;
    this.contentEl.toggleClass("is-typing", want);
    this.queueLayout(true);
  }

  isTyping() {
    const host = this.bodyEl;
    return !!(host && document.activeElement && host.contains(document.activeElement));
  }

  async select(m) {
    this.date = m.clone().startOf("day");
    this.month = this.date.clone().startOf("month");
    this.peek = null;
    this.renderGrid();
    await this.showNote();
  }

  weekStart(m) {
    const first = moment.localeData().firstDayOfWeek();
    const d = m.clone().startOf("day");
    return d.subtract((d.day() - first + 7) % 7, "day");
  }

  dayCell(parent, d, today, otherMonth) {
    const cell = parent.createEl("button", { cls: "day-peek-day" });
    cell.createSpan({ text: String(d.date()) });
    if (otherMonth) cell.addClass("is-other-month");
    if (d.isSame(today, "day")) cell.addClass("is-today");
    if (d.isSame(this.date, "day")) cell.addClass("is-selected");
    if (getNote(this.app, d)) cell.createDiv("day-peek-dot");
    const pick = d.clone();
    cell.onclick = () => this.select(pick);
  }

  /** Header labels + whatever the calendar area shows (month grid or a picker). */
  renderGrid() {
    if (!this.calEl) return;
    const today = moment().startOf("day");
    this.monthBtn.setText(this.month.format("MMM"));
    this.yearBtn.setText("'" + this.month.format("YY"));
    this.dayBtn.setText(String(this.date.date()));
    // browsing another month: the day number is the selected day's, not this month's
    this.dayBtn.toggleClass("is-elsewhere", !this.date.isSame(this.month, "month"));
    this.dayBtn.setAttr("aria-label", `${this.date.format("ddd D MMM YYYY")}: ${this.peek === "days" ? "hide" : "show"} the calendar`);
    this.todayBtn.toggleClass("is-active", this.date.isSame(today, "day"));
    this.monthBtn.toggleClass("is-open", this.peek === "months");
    this.yearBtn.toggleClass("is-open", this.peek === "years");
    this.dayBtn.toggleClass("is-open", this.peek === "days");

    const c = this.calEl;
    c.empty();
    c.toggleClass("is-peek", !!this.peek);
    c.toggleClass("is-picker", this.peek === "months" || this.peek === "years");
    this.rowEls = null;

    if (this.peek === "months") {
      const g = c.createDiv("dp-picker dp-months");
      for (let i = 0; i < 12; i++) {
        const m = this.month.clone().month(i);
        const b = g.createEl("button", { cls: "dp-pick", text: m.format("MMM") });
        if (i === this.month.month()) b.addClass("is-current");
        if (m.isSame(today, "month")) b.addClass("is-today");
        b.onclick = () => { this.month = m.startOf("month"); this.peek = "days"; this.renderGrid(); };
      }
      return this.queueLayout(true);
    }
    if (this.peek === "years") {
      const box = c.createDiv("dp-picker dp-years");
      const shown = this.month.year();
      for (let y = shown - 60; y <= shown + 40; y++) {
        const b = box.createEl("button", { cls: "dp-pick", text: String(y) });
        if (y === shown) { b.addClass("is-current"); this.yearCur = b; }
        if (y === today.year()) b.addClass("is-today");
        const yy = y;
        b.onclick = () => { this.month = this.month.clone().year(yy).startOf("month"); this.peek = "days"; this.renderGrid(); };
      }
      return this.queueLayout(true);
    }

    // month grid: weekday names + week rows, positioned by layout()
    const first = moment.localeData().firstDayOfWeek();
    this.dowEl = c.createDiv("dp-row dp-dow");
    for (let i = 0; i < 7; i++) this.dowEl.createDiv({ cls: "day-peek-dow", text: moment().day((first + i) % 7).format("ddd") });
    this.rowEls = [];
    const start = this.weekStart(this.month);
    const end = this.month.clone().endOf("month");
    let k = -1;
    for (const w = start.clone(); w.isSameOrBefore(end, "day"); w.add(1, "week")) {
      const row = c.createDiv("dp-row dp-week day-peek-days");
      for (let i = 0; i < 7; i++) {
        const d = w.clone().add(i, "day");
        this.dayCell(row, d, today, !d.isSame(this.month, "month"));
      }
      const last = w.clone().add(6, "day");
      if (k < 0 && this.date.isBetween(w, last, "day", "[]")) k = this.rowEls.length;
      this.rowEls.push(row);
    }
    // the week that stays longest: the selected day's, else today's, else the first
    if (k < 0) k = this.rowEls.findIndex((r, i) => today.isBetween(start.clone().add(i, "week"), start.clone().add(i, "week").add(6, "day"), "day", "[]"));
    this.keepRow = Math.max(0, k);
    this.queueLayout(true);
  }

  // ---- fold layout ----
  queueLayout(measure) {
    if (measure) this.needMeasure = true;
    if (this.layoutQueued) return;
    this.layoutQueued = true;
    window.requestAnimationFrame(() => { this.layoutQueued = false; this.layout(); });
  }

  rowsHidden() {
    const m = this.metrics;
    return !m || this.collapse >= m.full - m.hD - 0.5;
  }

  layout() {
    const c = this.calEl;
    if (!c || !c.isShown()) return;
    const s = this.plugin.settings;
    const body = this.bodyEl;

    if (!this.rowEls) {               // a picker: its own height, over the note
      c.style.height = "";
      if (this.peek === "years" && this.yearCur && !this.yearsAt) {
        const box = this.yearCur.parentElement;
        // exactly three rows of years visible (the template's 4 × 3), the rest a scroll away
        const rowH = this.yearCur.offsetHeight + 2;
        box.style.maxHeight = (3 * rowH + 12) + "px";
        box.scrollTop = this.yearCur.offsetTop - box.clientHeight / 2 + this.yearCur.offsetHeight / 2;
        this.yearsAt = true;
      }
      return;
    }
    if (this.needMeasure || !this.metrics) {
      const hD = this.dowEl.offsetHeight, hR = this.rowEls[0] ? this.rowEls[0].offsetHeight : 0;
      if (!hD || !hR) return;          // not laid out yet (hidden pane); the ResizeObserver brings us back
      this.metrics = { hD, hR, n: this.rowEls.length, full: hD + this.rowEls.length * hR };
      this.needMeasure = false;
    }
    const { hD, hR, n, full } = this.metrics;
    const k = Math.min(this.keepRow || 0, n - 1);
    const fold = FOLDS.includes(s.foldStyle) ? s.foldStyle : "slide";

    // how much is folded away when the note is at the top
    let rest = s.gridMode === "none" ? full : s.gridMode === "week" ? full - hD - hR : 0;
    if (this.typing) rest = full;
    const spacer = full - rest;
    // the spacer reserves the calendar's room at the top of the note; while a tapped-open
    // calendar is showing, leave it alone (the calendar covers the note instead of pushing it)
    if (!this.peek && this.spacerH !== spacer) { this.spacerEl.style.height = spacer + "px"; this.spacerH = spacer; }
    let cl = rest + (fold === "off" ? 0 : Math.min(Math.max(body.scrollTop, 0), this.spacerH ?? spacer));
    if (this.peek === "days") cl = 0;
    cl = Math.min(cl, full);
    this.collapse = cl;

    // Fold order. slide: the weeks above slide up under the weekday names, then the weeks below
    // slide up under the kept week as one block. cascade: the bottom week tucks under the one
    // above it, then the next, and so on. Then (both) the kept week's numbers slide under the
    // weekday names, and finally the names fade a little and slide under the header.
    const above = [...Array(k).keys()];
    const below = [...Array(n - k - 1).keys()].map((i) => k + 1 + i);
    const order = fold === "cascade" ? [...below.reverse(), ...above] : [...above, ...below];
    const v = new Array(n).fill(hR);
    let left = cl;
    for (const i of [...order, k]) { const t = Math.min(left, hR); v[i] -= t; left -= t; }
    const vD = hD - Math.min(left, hD);

    // top to bottom: each piece sits with its bottom edge at its visible end, tucked under the one above
    let y = 0;
    this.dowEl.style.transform = `translateY(${y + vD - hD}px)`;
    this.dowEl.style.opacity = String(0.45 + 0.55 * (vD / hD));
    y += vD;
    for (let i = 0; i < n; i++) {
      const r = this.rowEls[i];
      r.style.transform = `translateY(${y + v[i] - hR}px)`;
      r.style.zIndex = String(50 - Math.abs(i - k));
      r.toggleClass("is-gone", v[i] <= 0);
      y += v[i];
    }
    c.style.height = y + "px";
    c.toggleClass("is-empty", y <= 0);
  }

  // Write any pending edit now (the embed otherwise saves on a ~2 s debounce).
  async flush() {
    const e = this.embed;
    if (!e || !e.file || e === this.dropping) return;
    try {
      const text = e.editMode?.get?.() ?? e.editMode?.editor?.getValue?.();
      if (typeof text !== "string") return;
      // 0.8.0 safety net: an editor that's being torn down reads as "" and saving that would
      // wipe the note. Never write an empty note over one that isn't (Obsidian's own autosave
      // still saves a note you really emptied).
      if (!text.trim()) {
        const disk = await this.app.vault.read(e.file).catch(() => "");
        if (disk.trim()) return;
      }
      await e.save(text, true);
    } catch (err) { console.error("Day Peek: save failed", err); }
  }

  async dropEmbed() {
    const e = this.embed;
    if (!e) return;
    await this.flush();
    // Forget it BEFORE removing it: removing a focused editor fires focusout, which would
    // otherwise flush the half-destroyed editor (it reads as empty).
    this.embed = null;
    this.file = null;
    this.dropping = e;
    try { this.removeChild(e); } catch (_) {}
    this.dropping = null;
  }

  async showNote() {
    const wasTyping = this.isTyping();
    this.prevFocus = wasTyping ? null : document.activeElement;
    this.noFocusUntil = wasTyping ? 0 : Date.now() + 700;     // see the focusin handler
    await this.dropEmbed();
    const body = this.noteEl;
    body.empty();
    const m = this.date.clone();
    const file = getNote(this.app, m);

    if (!file) {
      const empty = body.createDiv("day-peek-empty");
      empty.createDiv({ text: `No daily note for ${m.format("ddd D MMM YYYY")}.` });
      const btn = empty.createEl("button", { cls: "mod-cta", text: "Create it" });
      btn.onclick = async () => {
        try {
          if (!getNote(this.app, m)) await createNote(this.app, m);
        } catch (e) { new Notice("Day Peek: couldn't create the note: " + e.message); }
        if (this.date.isSame(m, "day")) await this.showNote();
      };
      return;
    }

    this.file = file;
    const host = body.createDiv("day-peek-editor");
    const open = body.createDiv("day-peek-open");
    const a = open.createEl("a", { text: "Open in a tab ↗", href: "#" });
    a.onclick = (e) => { e.preventDefault(); this.app.workspace.getLeaf("tab").openFile(file); };

    const md = this.app.embedRegistry?.embedByExtension?.md;
    if (!md) return this.readOnly(host, file);
    try {
      const embed = md({ app: this.app, containerEl: host, state: {} }, file, "");
      this.embed = embed;
      this.addChild(embed);               // load()
      embed.editable = true;
      if (embed.loadFile) await embed.loadFile();
      embed.showEditor?.();
      // the editor grabs focus inside showEditor() (and sometimes a moment later)
      if (!wasTyping) { this.guardFocus(); for (const ms of [60, 250]) window.setTimeout(() => this.guardFocus(), ms); }
      else {
        // you were typing: keep typing in the new day's note (keeps the phone keyboard up)
        if (!this.isTyping()) { try { embed.editMode?.editor?.focus(); } catch (_) {} }
        if (this.isTyping()) this.setTyping(true);
      }
    } catch (e) {
      console.error("Day Peek: embedded editor failed", e);
      await this.dropEmbed();
      host.empty();
      await this.readOnly(host, file);
    }
  }

  async readOnly(host, file) {
    host.createDiv({ cls: "day-peek-warn", text: "Editing isn't available on this Obsidian version, showing a preview." });
    const view = host.createDiv("markdown-rendered");
    await MarkdownRenderer.render(this.app, await this.app.vault.cachedRead(file), view, file.path, this);
  }

  async reloadIfChanged() {
    if (!this.embed || !this.file) return;
    const disk = await this.app.vault.cachedRead(this.file);
    const shown = this.embed.editMode?.get?.() ?? this.embed.editMode?.editor?.getValue?.();
    if (shown !== undefined && shown !== disk) await this.showNote();
  }
}

// ---------- plugin ----------
// ---- Shared with Fold Magic: one keeper of Android's status bar for all Tailnet 4 plugins ----
// Each plugin says what it wants ("hidden" or not); the bar is hidden if anyone wants it hidden,
// unless the user toggled it by hand. A hand toggle lasts until something changes (a plugin's
// wish changes, or the phone is folded/unfolded). Same code in both plugins; newest version wins.
function statusBarHub() {
  const VERSION = 1;
  let hub = window.__tailnet4StatusBar;
  if (hub && hub.version >= VERSION) return hub;
  const old = hub || {};
  hub = {
    version: VERSION,
    owners: old.owners || new Set(),
    wants: old.wants || new Map(),
    manual: old.manual === undefined ? null : old.manual,   // null = automatic, true/false = toggled by hand
    touched: !!old.touched,                                 // did one of us ever hide it?
    api() {
      const cap = window.Capacitor;
      if (cap && cap.isPluginAvailable && cap.getPlatform && cap.getPlatform() === "android" && cap.isPluginAvailable("StatusBar")) return cap.Plugins.StatusBar;
      return window.__tailnet4FakeStatusBar || null;      // only set by tests
    },
    join(owner) { this.owners.add(owner); },
    leave(owner) {
      this.owners.delete(owner); this.wants.delete(owner);
      if (!this.owners.size) this.manual = null;            // last plugin gone: back to stock
      this.apply();
    },
    want(owner, hidden) {
      const before = this.wants.has(owner);
      if (hidden) this.wants.set(owner, true); else this.wants.delete(owner);
      if (before !== !!hidden) this.manual = null;          // something changed: back to automatic
      this.apply();
    },
    hidden() { return this.manual !== null ? this.manual : this.wants.size > 0; },
    toggle() { this.manual = !this.hidden(); this.apply(); return this.manual; },
    automatic() { this.manual = null; this.apply(); },
    apply() {
      const sb = this.api();
      if (!sb) return;
      const h = this.hidden();
      if (!h && !this.touched) return;                      // never hid it: leave it alone
      if (h) this.touched = true;
      // Not cached on purpose: Android shows the bar again on a swipe, so re-applying is the point.
      Promise.resolve(h ? sb.hide({ animation: "FADE" }) : sb.show({ animation: "FADE" })).catch(() => {});
    },
  };
  window.__tailnet4StatusBar = hub;
  return hub;
}

module.exports = class DayPeekPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    // 0.3.x had a separate "collapsed" flag; it's now just the "none" mode
    if (this.settings.gridCollapsed) {
      if (this.settings.gridMode !== "none") this.settings.lastShown = this.settings.gridMode;
      this.settings.gridMode = "none";
    }
    delete this.settings.gridCollapsed;
    if (!MODES.includes(this.settings.gridMode)) this.settings.gridMode = "month";
    if (!["month", "week"].includes(this.settings.lastShown)) this.settings.lastShown = "month";
    this.registerView(VIEW_TYPE, (leaf) => new DayPeekView(leaf, this));
    this.addRibbonIcon("calendar-days", "Open Day Peek", () => this.open());
    this.addCommand({ id: "open", name: "Open", callback: () => this.open() });
    this.addCommand({ id: "open-tab", name: "Open in a tab", callback: () => this.open("tab") });
    this.addCommand({ id: "open-sidebar", name: "Open in the right sidebar", callback: () => this.open("sidebar") });
    this.addCommand({ id: "check-status-bar", name: "Check status bar support (Android)", callback: () => this.checkStatusBar() });
    this.addSettingTab(new DayPeekSettings(this.app, this));
    // 0.6.0: hide Android's status bar while Day Peek is the active tab (opt-in).
    this.hub = statusBarHub();
    this.hub.join("day-peek");
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateStatusBar()));
    // 0.7.1: react to the drawer itself opening/closing, not only to focus (that caused the blink).
    this.registerEvent(this.app.workspace.on("layout-change", () => this.updateStatusBar()));
    this.registerDomEvent(window, "resize", () => this.updateStatusBar());
    this.registerDomEvent(document, "visibilitychange", () => { if (!document.hidden) this.hub.apply(); });
    // 0.7.0: sidebar width on phones/tablets (Fold Magic's width settings win when it's on)
    this.registerDomEvent(window, "resize", () => this.applyWidth());
    // Make sure the pane exists after Obsidian starts (phones lose sidebar tabs easily).
    this.app.workspace.onLayoutReady(async () => { await this.autoOpen(); this.watchDrawers(); this.updateStatusBar(); this.applyWidth(); });
  }

  onunload() {
    window.clearTimeout(this.sbTimer);
    if (this.drawerObserver) this.drawerObserver.disconnect();
    this.hub.leave("day-peek");   // shows the bar again unless Fold Magic still wants it hidden
    this.clearWidth();
  }

  // ---- Android status bar (0.6.0; shared keeper since 0.7.0) ----
  // 0.7.1: "Day Peek is open" = its view is actually on screen (open drawer or visible tab),
  // focused or not. Decided 300 ms after things stop changing, so a quick tap-and-close never flashes the bar.
  updateStatusBar() {
    window.clearTimeout(this.sbTimer);
    this.sbTimer = window.setTimeout(() => this.hub.want("day-peek", !!this.settings.hideStatusBar && this.onScreen()), 300);
  }

  onScreen() {
    const ws = this.app.workspace;
    return ws.getLeavesOfType(VIEW_TYPE).some((leaf) => {
      // In a sidebar: closed the moment you close it, even while it's still sliding away.
      const root = leaf.getRoot && leaf.getRoot();
      if ((root === ws.leftSplit || root === ws.rightSplit) && root.collapsed) return false;
      const el = leaf.view && leaf.view.containerEl;
      if (!el || !el.isShown()) return false;              // closed drawer / background tab = display: none
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > 1 && r.left < window.innerWidth - 1;   // not slid off screen
    });
  }

  // The phone's sidebars open and close by changing their own style/class, often without any
  // workspace event, so watch the two drawers directly.
  watchDrawers() {
    if (this.drawerObserver) this.drawerObserver.disconnect();
    this.drawerObserver = new MutationObserver(() => this.updateStatusBar());
    for (const split of [this.app.workspace.leftSplit, this.app.workspace.rightSplit]) {
      const el = split && split.containerEl;
      if (el) this.drawerObserver.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
    }
  }

  // ---- Sidebar width (0.7.0) ----
  foldMagicOn() { return !!(this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins["fold-magic"]); }   // loaded = on

  applyWidth() {
    if (!(Platform.isMobileApp || window.__foldMagicTest)) return;
    if (this.foldMagicOn()) { this.widthSet = false; return; }   // Fold Magic owns the widths
    const pairs = [["--mobile-sidebar-width", this.settings.sidebarWidth, "width"], ["--mobile-sidebar-max-width", this.settings.sidebarMaxWidth, "max-width"]];
    let any = false;
    for (const [v, x, prop] of pairs) {
      const val = (x || "").trim();
      let ok = false;
      try { ok = !!val && CSS.supports(prop, val); } catch (e) { ok = false; }
      if (ok) { document.body.style.setProperty(v, val); any = true; }
      else if (this.widthSet) document.body.style.removeProperty(v);
    }
    this.widthSet = any;
  }

  clearWidth() {
    if (!this.widthSet || this.foldMagicOn()) return;
    document.body.style.removeProperty("--mobile-sidebar-width");
    document.body.style.removeProperty("--mobile-sidebar-max-width");
    this.widthSet = false;
  }

  // ---- Status bar check (0.5.1): can a plugin hide Android's system status bar? ----
  // Probes every known route, tries a 4-second hide, asks the user if it worked,
  // and writes the result to a note in the vault (handy for bug reports).
  async checkStatusBar() {
    const lines = [];
    const log = (s) => lines.push(s);
    const cap = window.Capacitor;
    log(`platform: isMobile=${Platform.isMobile} isAndroidApp=${Platform.isAndroidApp} isPhone=${Platform.isPhone}`);
    log(`window.Capacitor: ${cap ? "yes" : "no"}`);
    let routes = [];
    if (cap) {
      try { log(`Capacitor.getPlatform(): ${cap.getPlatform && cap.getPlatform()}`); } catch (e) { log("getPlatform error: " + e.message); }
      const names = ["StatusBar", "SystemBars", "NavigationBar", "App", "Device", "Keyboard", "Haptics", "ScreenOrientation", "SplashScreen"];
      for (const n of names) {
        let avail = "?";
        try { avail = cap.isPluginAvailable ? String(cap.isPluginAvailable(n)) : "no isPluginAvailable"; } catch (e) { avail = "error " + e.message; }
        log(`  plugin ${n}: ${avail}`);
      }
      try { log(`  Plugins keys: ${Object.keys(cap.Plugins || {}).join(", ") || "(none listed)"}`); } catch (e) { log("  Plugins keys error: " + e.message); }
      const P = cap.Plugins || {};
      if (P.StatusBar && cap.isPluginAvailable && cap.isPluginAvailable("StatusBar")) {
        routes.push({ name: "Capacitor StatusBar", hide: () => P.StatusBar.hide({ animation: "FADE" }), show: () => P.StatusBar.show({ animation: "FADE" }),
          info: async () => JSON.stringify(await P.StatusBar.getInfo()) });
      }
      if (P.SystemBars && cap.isPluginAvailable && cap.isPluginAvailable("SystemBars")) {
        routes.push({ name: "Capacitor SystemBars", hide: () => P.SystemBars.hide({ bar: "StatusBar" }), show: () => P.SystemBars.show({ bar: "StatusBar" }) });
      }
    }
    if (window.StatusBar && typeof window.StatusBar.hide === "function") {
      routes.push({ name: "Cordova window.StatusBar", hide: () => window.StatusBar.hide(), show: () => window.StatusBar.show() });
    }
    if (window.AndroidFullScreen && window.AndroidFullScreen.immersiveMode) {
      routes.push({ name: "Cordova AndroidFullScreen", hide: () => new Promise((ok, no) => window.AndroidFullScreen.immersiveMode(ok, no)),
        show: () => new Promise((ok, no) => window.AndroidFullScreen.showSystemUI(ok, no)) });
    }
    log(`routes found: ${routes.map((r) => r.name).join(", ") || "none"}`);

    const results = [];
    for (const r of routes) {
      let res = "";
      try { if (r.info) log(`  ${r.name} getInfo: ${await r.info()}`); } catch (e) { log(`  ${r.name} getInfo error: ${e.message}`); }
      try {
        new Notice(`Day Peek: hiding the status bar for 4 s (${r.name})…`, 4000);
        await r.hide();
        await new Promise((ok) => setTimeout(ok, 4000));
        await r.show();
        res = "called hide/show without errors";
      } catch (e) { res = "error: " + (e && e.message || e); }
      log(`  ${r.name}: ${res}`);
      const answer = routes.length && !res.startsWith("error") ? await this.askYesNo(`Did Android's status bar (clock, battery) disappear for a few seconds? (${r.name})`) : "n/a";
      results.push(`${r.name}: ${res}; seen hiding: ${answer}`);
    }
    this.hub.apply();   // 0.7.0: put the bar back to what Day Peek / Fold Magic want (0.6.0 left it shown)
    const verdict = results.some((s) => s.endsWith("yes")) ? "✅ WORKS" : routes.length ? "❌ routes exist but the bar didn't hide" : "❌ no route available";
    const stamp = moment().format("YYYY-MM-DD HH:mm");
    const body = `---\ntype: test-result\nplugin: Day Peek ${this.manifest.version}\n---\n# Status bar check: ${verdict}\n\nRun ${stamp} on ${Platform.isMobile ? "mobile" : "desktop"}.\n\n## Results\n${results.map((s) => "- " + s).join("\n") || "- (no routes to test)"}\n\n## Raw\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`;
    const path = normalizePath(`Day Peek status bar check ${moment().format("YYYY-MM-DD HHmm")}${Platform.isMobile ? " (phone)" : ""}.md`);
    try {
      await this.app.vault.create(path, body);
      new Notice(`Day Peek: ${verdict}. Saved to ${path}`, 8000);
    } catch (e) { new Notice("Day Peek: couldn't save the result: " + e.message, 8000); }
  }

  askYesNo(question) {
    return new Promise((resolve) => {
      const m = new Modal(this.app);
      let done = false;
      m.titleEl.setText("Day Peek: status bar check");
      m.contentEl.createEl("p", { text: question });
      const row = m.contentEl.createDiv({ cls: "modal-button-container" });
      const pick = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
      row.createEl("button", { text: "Yes, it hid", cls: "mod-cta" }).onclick = () => pick("yes");
      row.createEl("button", { text: "No" }).onclick = () => pick("no");
      m.onClose = () => pick("no answer");
      m.open();
    });
  }

  async autoOpen() {
    const s = this.settings.openOnStartup;
    const want = s === "always" || (s === "mobile" && Platform.isMobile);
    if (!want || this.app.workspace.getLeavesOfType(VIEW_TYPE).length) return;
    await this.open(undefined, true);
  }

  async saveSettings() { await this.saveData(this.settings); }

  /** Change what's under the header, remember the last visible one, and redraw every Day Peek pane. */
  async setGridMode(mode) {
    const s = this.settings;
    if (!MODES.includes(mode)) return;
    if (mode !== "none") s.lastShown = mode;
    s.gridMode = mode;
    await this.saveSettings();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view?.renderGrid?.();
  }

  redraw() { for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view?.renderGrid?.(); }

  async open(where, quiet = false) {
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (existing && !where) { ws.revealLeaf(existing); return; }

    where = where || this.settings.openLocation;
    if (where === "auto") where = Platform.isMobile ? "tab" : "below-calendar";

    let leaf;
    if (where === "tab") leaf = ws.getLeaf("tab");
    else if (where === "below-calendar" && !Platform.isMobile) {
      const cal = ws.getLeavesOfType("calendar")[0];
      leaf = cal ? ws.createLeafBySplit(cal, "horizontal") : ws.getRightLeaf(true);
    } else leaf = ws.getRightLeaf(false);

    // quiet = at startup: put it in place but don't steal focus or pop the sidebar open
    await leaf.setViewState({ type: VIEW_TYPE, active: !quiet });
    if (!quiet) ws.revealLeaf(leaf);
  }
};

class DayPeekSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl;
    el.empty();
    new Setting(el)
      .setName("Where it opens")
      .setDesc("Auto: under the Calendar plugin on desktop, as its own tab on phones/tablets.")
      .addDropdown((d) => d
        .addOptions({ auto: "Auto", "below-calendar": "Below Calendar (desktop)", sidebar: "Right sidebar", tab: "Tab" })
        .setValue(this.plugin.settings.openLocation)
        .onChange(async (v) => { this.plugin.settings.openLocation = v; await this.plugin.saveSettings(); }));
    new Setting(el)
      .setName("Calendar at rest")
      .setDesc("How much calendar shows when the note is scrolled to the top. The header always stays; tap the day number to see the whole month any time.")
      .addDropdown((d) => d
        .addOptions({ month: "Month", week: "One-week strip", none: "Hidden" })
        .setValue(this.plugin.settings.gridMode)
        .onChange((v) => this.plugin.setGridMode(v)));
    new Setting(el)
      .setName("Fold on scroll")
      .setDesc("Scrolling the note folds the calendar away and scrolling back brings it out. Slide: the other weeks slide away and your week stays, then its numbers slide under the weekday names, then the names slide under the header. Cascade: the bottom week tucks under the one above it, then the next, and so on. Off: the calendar stays put.")
      .addDropdown((d) => d
        .addOptions({ slide: "Slide", cascade: "Cascade", off: "Off" })
        .setValue(this.plugin.settings.foldStyle)
        .onChange(async (v) => { this.plugin.settings.foldStyle = v; await this.plugin.saveSettings(); this.plugin.redraw(); }));
    new Setting(el)
      .setName("Hide the calendar while typing")
      .setDesc("When you tap into the note the calendar folds away, and comes back when you leave it. Tap the date to peek at it meanwhile.")
      .addDropdown((d) => d
        .addOptions({ mobile: "On phones/tablets only", always: "Always", never: "Never" })
        .setValue(this.plugin.settings.hideWhileTyping)
        .onChange(async (v) => { this.plugin.settings.hideWhileTyping = v; await this.plugin.saveSettings(); }));
    new Setting(el)
      .setName("Hide Android's status bar")
      .setDesc("Android only: the clock/battery bar disappears while Day Peek is on screen (its sidebar is open, or it's the visible tab) and comes back when it isn't. Swipe down from the top to see it meanwhile. Does nothing on laptops.")
      .addToggle((t) => t
        .setValue(this.plugin.settings.hideStatusBar)
        .onChange(async (v) => { this.plugin.settings.hideStatusBar = v; await this.plugin.saveSettings(); this.plugin.updateStatusBar(); }));
    const widthSetting = (key, name, stock, prop) => new Setting(el)
      .setName(name)
      .setDesc(`Phones/tablets only. Any CSS length (70vw, 500px${prop === "max-width" ? ", none" : ""}); empty = Obsidian's default (${stock}). If Fold Magic is on, its folded/unfolded widths are used instead.`)
      .addText((t) => {
        t.setPlaceholder(stock).setValue(this.plugin.settings[key]);
        t.inputEl.addEventListener("change", async () => {
          const v = t.getValue().trim();
          let ok = !v;
          try { ok = ok || CSS.supports(prop, v); } catch (e) { ok = false; }
          if (!ok) { new Notice(`Day Peek: “${v}” isn't a CSS length (try 70vw or 500px)`, 4000); return; }
          this.plugin.settings[key] = v; await this.plugin.saveSettings(); this.plugin.applyWidth();
        });
      });
    widthSetting("sidebarWidth", "Sidebar width", "84vw", "width");
    widthSetting("sidebarMaxWidth", "Sidebar maximum width", "450px", "max-width");
    new Setting(el)
      .setName("Open at startup")
      .setDesc("Put Day Peek back in place every time Obsidian starts, so it can't go missing.")
      .addDropdown((d) => d
        .addOptions({ mobile: "On phones/tablets only", always: "Always", never: "Never" })
        .setValue(this.plugin.settings.openOnStartup)
        .onChange(async (v) => { this.plugin.settings.openOnStartup = v; await this.plugin.saveSettings(); }));
    el.createEl("p", {
      cls: "setting-item-description",
      text: "Uses your core Daily notes settings (folder, date format, template). Header: ▲▼ show the previous/next month, tap the month or year to pick one, ‹ › move a day, tap the day number to show or hide the month, Today jumps back. None of them closes the phone keyboard.",
    });
  }
}
