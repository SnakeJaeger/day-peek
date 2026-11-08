/* Day Peek — mini calendar + the selected day's daily note, editable in place.
 * Written by Big Len (Claude) in 2026. Plain JS, no build step.
 * Uses the core Daily notes settings (folder, format, template).
 * The editor is Obsidian's own embedded markdown editor (same trick Kanban uses).
 */
const { Plugin, ItemView, TFile, Notice, normalizePath, moment, Platform,
  PluginSettingTab, Setting, MarkdownRenderer, setIcon } = require("obsidian");

const VIEW_TYPE = "day-peek";
const DEFAULTS = { openLocation: "auto", gridMode: "month", lastShown: "month", openOnStartup: "mobile", hideWhileTyping: "mobile" };
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
class DayPeekView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.date = moment().startOf("day");
    this.month = this.date.clone().startOf("month");
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

    // header: ‹ date ›  today
    const head = root.createDiv("day-peek-head");
    this.prevBtn = head.createEl("button", { cls: "day-peek-btn clickable-icon", attr: { "aria-label": "Previous" } });
    setIcon(this.prevBtn, "chevron-left");
    this.label = head.createEl("button", { cls: "day-peek-label", attr: { "aria-label": "Show/hide calendar" } });
    this.nextBtn = head.createEl("button", { cls: "day-peek-btn clickable-icon", attr: { "aria-label": "Next" } });
    setIcon(this.nextBtn, "chevron-right");
    this.modeBtn = head.createEl("button", { cls: "day-peek-btn clickable-icon" });
    this.todayBtn = head.createEl("button", { cls: "day-peek-today", text: "Today" });
    // calendar button: month -> week strip -> hidden -> month
    this.modeBtn.onclick = () => {
      this.setTyping(false);
      this.plugin.setGridMode(MODES[(MODES.indexOf(this.plugin.settings.gridMode) + 1) % MODES.length]);
    };
    // ‹ › page whatever the calendar shows: a month, a week, or (calendar hidden) a day.
    // Single days are a tap on the calendar itself.
    this.prevBtn.onclick = () => this.page(-1);
    this.nextBtn.onclick = () => this.page(1);
    this.todayBtn.onclick = () => this.select(moment().startOf("day"));
    // tap the date: hide the calendar, or bring back the one you had
    this.label.onclick = () => {
      if (this.typing) { this.setTyping(false); return; }    // hidden only for typing: just show it again
      const s = this.plugin.settings;
      this.plugin.setGridMode(s.gridMode === "none" ? s.lastShown : "none");
    };

    this.gridEl = root.createDiv("day-peek-grid");
    this.bodyEl = root.createDiv("day-peek-body");

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

  async onClose() { await this.dropEmbed(); }

  /** ‹ › : one month in month view, one week in the strip, one day when the calendar is hidden. */
  page(dir) {
    const mode = this.plugin.settings.gridMode;
    const unit = this.typing || mode === "none" ? "day" : mode === "week" ? "week" : "month";
    this.select(this.date.clone().add(dir, unit));
  }

  /** Right after a note loads: if the editor took focus you didn't give it, hand it back. */
  guardFocus() {
    if (Date.now() >= (this.noFocusUntil || 0) || !this.bodyEl.contains(document.activeElement)) return false;
    document.activeElement.blur();
    this.prevFocus?.focus?.({ preventScroll: true });
    return true;
  }

  /** While the note has focus (typing), hide the calendar if the setting says so. Not saved. */
  setTyping(on) {
    const s = this.plugin.settings.hideWhileTyping;
    const allowed = s === "always" || (s === "mobile" && Platform.isMobile);
    const want = !!(on && allowed);
    if (want === !!this.typing) return;
    this.typing = want;
    this.contentEl.toggleClass("is-typing", want);
    this.renderGrid();
  }

  isTyping() {
    const host = this.bodyEl;
    return !!(host && document.activeElement && host.contains(document.activeElement));
  }

  async select(m) {
    this.date = m.clone().startOf("day");
    this.month = this.date.clone().startOf("month");
    this.week = this.weekStart(this.date);
    this.renderGrid();
    await this.showNote();
  }

  weekStart(m) {
    const first = moment.localeData().firstDayOfWeek();
    const d = m.clone().startOf("day");
    return d.subtract((d.day() - first + 7) % 7, "day");
  }

  dayCell(parent, d, today, otherMonth, withDow) {
    const cell = parent.createEl("button", { cls: "day-peek-day" });
    if (withDow) cell.createDiv({ cls: "day-peek-cell-dow", text: d.format("dd") });
    cell.createSpan({ text: String(d.date()) });
    if (otherMonth) cell.addClass("is-other-month");
    if (d.isSame(today, "day")) cell.addClass("is-today");
    if (d.isSame(this.date, "day")) cell.addClass("is-selected");
    if (getNote(this.app, d)) cell.createDiv("day-peek-dot");
    const pick = d.clone();
    cell.onclick = () => this.select(pick);
  }

  renderGrid() {
    if (!this.gridEl) return;
    const today = moment().startOf("day");
    const fmt = Platform.isPhone ? "ddd D MMM" : "dddd, D MMM YYYY";
    const mode = this.plugin.settings.gridMode;
    const folded = mode === "none" || this.typing;
    this.label.setText(this.date.format(fmt) + (folded ? "  ▾" : "  ▴"));
    const unit = folded ? "day" : mode === "week" ? "week" : "month";
    this.prevBtn.setAttr("aria-label", `Previous ${unit}`);
    this.nextBtn.setAttr("aria-label", `Next ${unit}`);
    this.todayBtn.toggleClass("is-active", this.date.isSame(today, "day"));

    const g = this.gridEl;
    g.empty();
    g.toggleClass("is-collapsed", mode === "none");
    const week = mode === "week";
    // the icon shows what a tap will do next
    const next = { month: ["calendar-range", "Show only this week (strip)"],
                   week: ["calendar-x", "Hide the calendar (more room for the note)"],
                   none: ["calendar-days", "Show the month"] }[mode];
    setIcon(this.modeBtn, next[0]);
    this.modeBtn.setAttr("aria-label", next[1]);
    g.toggleClass("is-week", week);
    if (mode === "none") return;

    if (week) {
      // one compact row of 7 days (the header's ‹ › move a week)
      const strip = g.createDiv("day-peek-strip");
      const days = strip.createDiv("day-peek-days");
      for (let i = 0; i < 7; i++) this.dayCell(days, this.week.clone().add(i, "day"), today, false, true);
      return;
    }

    // (no "‹ November 2026 ›" row: the header shows the date and its ‹ › move a month)
    const table = g.createDiv("day-peek-days");
    const first = moment.localeData().firstDayOfWeek();
    for (let i = 0; i < 7; i++) {
      table.createDiv({ cls: "day-peek-dow", text: moment().day((first + i) % 7).format("dd") });
    }
    const start = this.weekStart(this.month);
    const end = this.month.clone().endOf("month");
    for (const d = start.clone(); d.isSameOrBefore(end, "day") || d.day() !== first; d.add(1, "day")) {
      this.dayCell(table, d, today, !d.isSame(this.month, "month"), false);
    }
  }

  // Write any pending edit now (the embed otherwise saves on a ~2 s debounce).
  async flush() {
    const e = this.embed;
    if (!e || !e.file) return;
    try {
      const text = e.editMode?.get?.() ?? e.editMode?.editor?.getValue?.();
      if (typeof text === "string") await e.save(text, true);
    } catch (err) { console.error("Day Peek: save failed", err); }
  }

  async dropEmbed() {
    if (!this.embed) return;
    await this.flush();
    try { this.removeChild(this.embed); } catch (_) {}
    this.embed = null;
    this.file = null;
  }

  async showNote() {
    const wasTyping = this.isTyping();
    this.prevFocus = wasTyping ? null : document.activeElement;
    this.noFocusUntil = wasTyping ? 0 : Date.now() + 700;     // see the focusin handler
    await this.dropEmbed();
    const body = this.bodyEl;
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
      else if (this.isTyping()) this.setTyping(true);
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
    this.addSettingTab(new DayPeekSettings(this.app, this));
    // Make sure the pane exists after Obsidian starts (phones lose sidebar tabs easily).
    this.app.workspace.onLayoutReady(() => this.autoOpen());
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
      .setName("Calendar under the header")
      .setDesc("The header (‹ date › Today) always stays. Hidden = the most room for typing; ‹ › still move a day.")
      .addDropdown((d) => d
        .addOptions({ month: "Month", week: "One-week strip", none: "Hidden" })
        .setValue(this.plugin.settings.gridMode)
        .onChange((v) => this.plugin.setGridMode(v)));
    new Setting(el)
      .setName("Hide the calendar while typing")
      .setDesc("When you tap into the note the calendar folds away, and comes back when you leave it. Tap the date to peek at it meanwhile.")
      .addDropdown((d) => d
        .addOptions({ mobile: "On phones/tablets only", always: "Always", never: "Never" })
        .setValue(this.plugin.settings.hideWhileTyping)
        .onChange(async (v) => { this.plugin.settings.hideWhileTyping = v; await this.plugin.saveSettings(); }));
    new Setting(el)
      .setName("Open at startup")
      .setDesc("Put Day Peek back in place every time Obsidian starts, so it can't go missing.")
      .addDropdown((d) => d
        .addOptions({ mobile: "On phones/tablets only", always: "Always", never: "Never" })
        .setValue(this.plugin.settings.openOnStartup)
        .onChange(async (v) => { this.plugin.settings.openOnStartup = v; await this.plugin.saveSettings(); }));
    el.createEl("p", {
      cls: "setting-item-description",
      text: "Uses your core Daily notes settings (folder, date format, template). The calendar icon in the header cycles month → week strip → hidden; tapping the date hides it or brings it back. The ‹ › arrows move a month (month view), a week (strip) or a day (calendar hidden); tap a day to pick it.",
    });
  }
}
