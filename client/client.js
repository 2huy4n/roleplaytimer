// roleplaytimer web settings section: config form + live status +
// debug panel (simulate elapsed time, fire now, mute, reset, log tail).
// Talks to the host routes registered in dsh/index.js under /roleplaytimer.
window.__ModuleLoader__.load({ id: "roleplaytimer", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  const react = require("react");

  const NS = "roleplaytimer";
  const name = "roleplaytimer";
  const inject = ["slots"];
  const API = "/roleplaytimer";

  const h = react.createElement;

  async function call(path, body) {
    const res = await fetch(API + path, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { cache: "no-store" });
    const data = await res.json();
    if (!data || data.ok === false) throw new Error((data && data.error) || ("HTTP " + res.status));
    return data;
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function clockOf(ms) {
    const d = new Date(ms);
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function untilOf(ms) {
    const delta = ms - Date.now();
    if (delta <= 0) return "现在 / now";
    const min = Math.round(delta / 60000);
    if (min < 60) return min + " 分钟后";
    return Math.floor(min / 60) + " 小时 " + (min % 60) + " 分后";
  }

  function stampOf(ms) {
    const d = new Date(ms);
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function Panel() {
    const [cfg, setCfg] = react.useState(null);
    const [status, setStatus] = react.useState(null);
    const [error, setError] = react.useState("");
    const [note, setNote] = react.useState("");
    const [busy, setBusy] = react.useState(false);
    const [dirty, setDirty] = react.useState(false);
    const [customMinutes, setCustomMinutes] = react.useState("150");

    const refresh = react.useCallback(async (adopt) => {
      try {
        const s = await call("/status");
        setStatus(s);
        if (adopt) setCfg(s.config);
        setError("");
      } catch (e) {
        setError(String((e && e.message) || e));
      }
    }, []);

    react.useEffect(() => {
      refresh(true);
      const timer = setInterval(() => { refresh(false); }, 5000);
      return () => clearInterval(timer);
    }, [refresh]);

    const set = (key, value) => {
      setDirty(true);
      setNote("");
      setCfg((prev) => ({ ...prev, [key]: value }));
    };

    const guard = async (fn) => {
      setBusy(true);
      try { await fn(); } catch (e) { setError(String((e && e.message) || e)); } finally { setBusy(false); }
    };

    const save = () => guard(async () => {
      const r = await call("/config", { config: cfg });
      setCfg(r.value);
      setDirty(false);
      setNote("已保存 / saved");
      await refresh(false);
    });

    const debug = (action, extra) => guard(async () => {
      const r = await call("/debug", { action, ...(extra || {}) });
      setStatus(r);
      setNote(action + " → " + (r.affected === undefined ? "ok" : r.affected + " 个会话"));
    });

    if (!cfg) {
      return h("div", { style: st.card },
        h("p", { style: st.hint }, error ? "加载失败 / load failed: " + error : "加载中… / loading…"));
    }

    const agents = (status && status.agents) || [];
    const log = (status && status.log) || [];
    const offsetMs = (status && status.offsetMs) || 0;
    const offsetMinutes = Math.round(offsetMs / 60000);

    return h("div", { style: st.card },
      h("h3", { style: st.title }, "roleplaytimer"),
      h("p", { style: st.hint },
        "用户沉默达到设定时长后，向智能体投递一条 user 角色的唤醒消息，让它按角色卡主动开口。仅在 DSH 应用运行时、且该会话处于空闲时投递。"),

      error ? h("div", { style: st.warn }, "错误 / error: " + error) : null,
      !error && cfg.enabled ? h("div", { style: st.statusOk }, "● 已启用 / enabled") : null,
      !error && !cfg.enabled ? h("div", { style: st.statusWarn }, "○ 未启用 / disabled") : null,

      h("label", { style: st.inline },
        h("input", { type: "checkbox", checked: !!cfg.enabled, onChange: (e) => set("enabled", e.target.checked) }),
        h("span", { style: st.inlineText }, "启用主动唤醒 / Enable proactive wake")),

      h("label", { style: st.inline },
        h("input", { type: "checkbox", checked: !!cfg.defaultMuted, onChange: (e) => set("defaultMuted", e.target.checked) }),
        h("span", { style: st.inlineText }, "新会话默认静音 / Mute new sessions by default")),
      h("span", { style: st.hint }, "首次出现的会话默认不唤醒；在下方「活动会话」里对想唤醒的会话点「取消静音」。仅影响首次出现的会话。"),

      h("div", { style: st.grid2 },
        h("label", { style: st.field },
          h("span", { style: st.label }, "唤醒间隔（分钟）/ Interval"),
          h("input", {
            type: "number", min: 1, max: 1440, style: st.input, value: cfg.intervalMinutes,
            onChange: (e) => set("intervalMinutes", Number(e.target.value)),
          }),
          h("span", { style: st.hint }, "用户沉默超过该时长后唤醒一次。")),
        h("label", { style: st.field },
          h("span", { style: st.label }, "模糊区间（±分钟）/ Fuzzy range"),
          h("input", {
            type: "number", min: 0, max: 1440, style: st.input, value: cfg.jitterMinutes,
            onChange: (e) => set("jitterMinutes", Number(e.target.value)),
          }),
          h("span", { style: st.hint }, "例：间隔 180、模糊 30 → 实际在 150~210 分钟之间随机唤醒。0 = 精确。")),
        h("label", { style: st.field },
          h("span", { style: st.label }, "每日上限（次，0 = 不限）/ Daily max"),
          h("input", {
            type: "number", min: 0, max: 96, style: st.input, value: cfg.dailyMaxWakes,
            onChange: (e) => set("dailyMaxWakes", Number(e.target.value)),
          }),
          h("span", { style: st.hint }, "当天达到上限后，次日 00:00 才恢复。")),
        h("label", { style: st.field },
          h("span", { style: st.label }, "静默时段开始 / Quiet from"),
          h("input", {
            type: "text", placeholder: "23:30", style: st.input, value: cfg.quietStart,
            onChange: (e) => set("quietStart", e.target.value),
          })),
        h("label", { style: st.field },
          h("span", { style: st.label }, "静默时段结束 / Quiet to"),
          h("input", {
            type: "text", placeholder: "08:00", style: st.input, value: cfg.quietEnd,
            onChange: (e) => set("quietEnd", e.target.value),
          }))),

      h("label", { style: st.field },
        h("span", { style: st.label }, "唤醒提示词 / Wake prompt"),
        h("textarea", {
          rows: 8, style: st.textarea, value: cfg.wakePrompt,
          onChange: (e) => set("wakePrompt", e.target.value),
        }),
        h("span", { style: st.hint }, "可用占位符：{minutes} 沉默分钟数、{count} 今日第几次、{time} 当前时间、{session_id} 会话 id。")),

      h("label", { style: st.inline },
        h("input", { type: "checkbox", checked: !!cfg.debugEnabled, onChange: (e) => set("debugEnabled", e.target.checked) }),
        h("span", { style: st.inlineText }, "显示调试面板 / Show debug panel")),

      h("div", { style: st.row },
        h("button", { style: st.button, disabled: busy || !dirty, onClick: save }, dirty ? "保存 / Save" : "已保存 / Saved"),
        note ? h("span", { style: st.ok }, note) : null,
        h("span", { style: st.mono }, "配置： " + ((status && status.path) || "-"))),

      cfg.debugEnabled ? h("div", { style: st.debug },
        h("h4", { style: st.subtitle }, "调试 / Debug"),

        offsetMs !== 0
          ? h("div", { style: st.warn },
              "时钟已快进 " + offsetMinutes + " 分钟（仅影响本插件的判断，不改变系统时间）。",
              h("button", { style: st.linkBtn, disabled: busy, onClick: () => debug("clock-reset") }, "重置时钟"))
          : null,

        h("div", { style: st.row },
          h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("advance", { minutes: 30 }) }, "模拟 +30 分钟"),
          h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("advance", { minutes: 150 }) }, "模拟 +150 分钟"),
          h("input", {
            type: "number", min: 1, max: 10080, style: { ...st.input, width: 90 }, value: customMinutes,
            onChange: (e) => setCustomMinutes(e.target.value),
          }),
          h("button", {
            style: st.buttonAlt, disabled: busy,
            onClick: () => debug("advance", { minutes: Number(customMinutes) || 0 }),
          }, "模拟经过"),
          h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("fire") }, "立即唤醒全部"),
          h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("clear-log") }, "清空日志")),

        h("h4", { style: st.subtitle }, "活动会话 / Live sessions"),
        agents.length === 0
          ? h("p", { style: st.hint }, "当前没有插件的活动会话。打开一个对话后这里会出现。")
          : h("table", { style: st.table },
              h("thead", null, h("tr", null,
                h("th", { style: st.th }, "会话"),
                h("th", { style: st.th }, "沉默"),
                h("th", { style: st.th }, "今日"),
                h("th", { style: st.th }, "下次唤醒"),
                h("th", { style: st.th }, "操作"))),
              h("tbody", null, agents.map((a) => h("tr", { key: a.sessionId },
                h("td", { style: st.td },
                  h("span", { style: st.sessionName, title: a.sessionId }, a.title || a.sessionId.slice(-12))),
                h("td", { style: st.td }, a.silentMinutes + " 分"),
                h("td", { style: st.td }, a.dayCount + " 次"),
                h("td", { style: st.td }, a.muted ? "已静音" : (clockOf(a.nextWakeAt) + "（" + untilOf(a.nextWakeAt) + "）")),
                h("td", { style: st.td },
                  h("button", { style: st.miniBtn, disabled: busy, onClick: () => debug("fire", { sessionId: a.sessionId }) }, "现在"),
                  h("button", { style: st.miniBtn, disabled: busy, onClick: () => debug("reset", { sessionId: a.sessionId }) }, "重置计时"),
                  h("button", {
                    style: st.miniBtn, disabled: busy,
                    onClick: () => debug(a.muted ? "unmute" : "mute", { sessionId: a.sessionId }),
                  }, a.muted ? "取消静音" : "静音")))))),

        h("h4", { style: st.subtitle }, "投递日志 / Delivery log"),
        log.length === 0
          ? h("p", { style: st.hint }, "还没有投递记录。")
          : h("div", null, log.slice(0, 20).map((entry, i) => h("div", { key: i, style: st.logRow },
              h("span", { style: st.mono }, stampOf(entry.ts) + " · " + String(entry.sessionId || "").slice(-8)),
              h("span", { style: st.logText }, " 沉默 " + entry.minutes + " 分钟 → " + String(entry.text || "").split("\n")[0]))))
      ) : null
    );
  }

  const st = {
    card: { padding: "16px", maxWidth: 860, color: "#e6edf3" },
    title: { margin: "0 0 6px", fontSize: 16, fontWeight: 600, color: "#f0f6fc" },
    subtitle: { margin: "18px 0 8px", fontSize: 14, fontWeight: 600, color: "#f0f6fc" },
    hint: { fontSize: 12, color: "#9da7b3", margin: "0 0 10px" },
    statusOk: { margin: "0 0 12px", padding: "6px 12px", borderRadius: 8, fontSize: 13, background: "#12291d", color: "#3fb950", border: "1px solid #238636" },
    statusWarn: { margin: "0 0 12px", padding: "6px 12px", borderRadius: 8, fontSize: 13, background: "#2d2410", color: "#d29922", border: "1px solid #9e6a03" },
    warn: { margin: "0 0 12px", padding: "8px 12px", borderRadius: 8, fontSize: 13, background: "#2d2410", color: "#d29922", border: "1px solid #9e6a03" },
    debug: { marginTop: 16, padding: "12px 14px", borderRadius: 8, border: "1px solid #30363d", background: "#0d1117" },
    grid2: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 },
    field: { display: "block", margin: "8px 0" },
    label: { display: "block", fontSize: 12, fontWeight: 500, marginBottom: 3, color: "#c9d1d9" },
    input: { width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid #30363d", background: "#0d1117", color: "#e6edf3" },
    textarea: { width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 12, fontFamily: "monospace", borderRadius: 6, border: "1px solid #30363d", background: "#0d1117", color: "#e6edf3" },
    inline: { display: "flex", alignItems: "center", gap: 8, margin: "10px 0" },
    inlineText: { fontSize: 13, color: "#c9d1d9" },
    row: { display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" },
    button: { padding: "6px 16px", fontSize: 13, borderRadius: 6, cursor: "pointer", border: "1px solid #1f6feb", background: "#1f6feb", color: "#fff" },
    buttonAlt: { padding: "4px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer", border: "1px solid #30363d", background: "#21262d", color: "#e6edf3" },
    miniBtn: { marginRight: 4, padding: "2px 8px", fontSize: 11, borderRadius: 5, cursor: "pointer", border: "1px solid #30363d", background: "#21262d", color: "#e6edf3" },
    linkBtn: { marginLeft: 8, fontSize: 12, color: "#58a6ff", background: "transparent", border: "none", cursor: "pointer", textDecoration: "underline" },
    table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
    th: { textAlign: "left", padding: "4px 6px", borderBottom: "1px solid #30363d", color: "#9da7b3", fontWeight: 500 },
    td: { padding: "4px 6px", borderBottom: "1px solid #21262d", color: "#c9d1d9" },
    logRow: { padding: "3px 0", fontSize: 11, display: "flex", gap: 6 },
    logText: { color: "#9da7b3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    ok: { fontSize: 12, color: "#3fb950" },
    mono: { fontSize: 11, fontFamily: "monospace", color: "#768390" },
    sessionName: { fontSize: 12, color: "#e6edf3", display: "inline-block", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" },
  };

  function apply(ctx) {
    if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "roleplaytimer",
      order: 55,
      label: () => "roleplaytimer",
      locale: NS,
      inject: () => ({}),
    }, () => react.createElement(Panel)));
  }

  exports.name = name;
  exports.inject = inject;
  exports.apply = apply;
  return module.exports;
}});
