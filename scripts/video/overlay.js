// 録画用の重ね表示（字幕・カーソル・右下の CLI パネル）。どのページにも入る
(() => {
  const css = `
  #__cap{position:fixed;left:0;right:0;margin:0 auto;width:max-content;bottom:26px;max-width:1100px;background:rgba(15,23,42,.88);color:#fff;
    font:600 24px/1.5 "Noto Sans CJK JP",sans-serif;padding:12px 26px;border-radius:12px;z-index:2147483646;pointer-events:none;
    text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.35);transition:opacity .25s;opacity:0;white-space:pre-line}
  #__cur{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transition:transform .7s cubic-bezier(.4,0,.2,1);transform:translate(640px,380px);opacity:0}
  #__ring{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #6366f1;z-index:2147483647;pointer-events:none;opacity:0}
  #__term{position:fixed;right:24px;top:170px;width:640px;background:#0f1320;color:#d8dee9;border-radius:10px;z-index:2147483645;pointer-events:none;
    font:15px/1.5 "Noto Sans Mono CJK JP",monospace;padding:12px 16px;white-space:pre-wrap;word-break:break-all;box-shadow:0 10px 30px rgba(0,0,0,.45);display:none}
  #__term .h{color:#9aa3b8;font:12px sans-serif;margin-bottom:6px}
  `;
  const init = () => {
    if (document.getElementById("__cap")) return;
    const st = document.createElement("style"); st.textContent = css; document.documentElement.append(st);
    const cap = document.createElement("div"); cap.id = "__cap"; document.documentElement.append(cap);
    const cur = document.createElement("div"); cur.id = "__cur";
    cur.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.append(cur);
    const ring = document.createElement("div"); ring.id = "__ring"; document.documentElement.append(ring);
    const term = document.createElement("div"); term.id = "__term"; document.documentElement.append(term);
  };
  window.__cap = (t) => { init(); const c = document.getElementById("__cap"); if (t) { c.textContent = t; c.style.opacity = 1; } else c.style.opacity = 0; };
  window.__cursor = (x, y) => { init(); const c = document.getElementById("__cur"); c.style.opacity = 1; c.style.transform = `translate(${x - 4}px,${y - 2}px)`; };
  window.__clickFx = (x, y) => {
    const r = document.getElementById("__ring"); r.style.left = x + "px"; r.style.top = y + "px";
    r.animate([{ opacity: .9, transform: "scale(.5)" }, { opacity: 0, transform: "scale(1.4)" }], { duration: 500 });
  };
  window.__term = (lines) => { init(); const t = document.getElementById("__term");
    if (lines == null) { t.style.display = "none"; return; }
    t.style.display = "block"; t.innerHTML = '<div class="h">ターミナル（AI エージェント）</div>'; const b = document.createElement("div"); b.textContent = lines; t.append(b); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
