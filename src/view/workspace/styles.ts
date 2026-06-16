/**
 * 工作区视图样式 —— 1:1 移植自原型 workspace_redesign.html,作用域到 .zkw。
 * 两栏布局:左 rail(Spaces 导航)+ 中 center(cockpit),详情 deck 覆盖在 center 上。
 */
export const ZKW_STYLE_ID = 'zkw-styles';

export const ZKW_CSS = `
.zkw {
  --bg:#08090d; --bg2:#0b0d13; --panel:#0e1018; --panel-2:#13161f; --panel-3:#1a1e2a;
  --ink:#eceef3; --ink-dim:#969bab; --ink-faint:#565c6b; --ink-ghost:#363b48;
  --rule:rgba(255,255,255,0.07); --rule-2:rgba(255,255,255,0.12); --rule-3:rgba(255,255,255,0.2);
  --violet:#b79dff; --violet-d:#8b6df0;
  --green:#6fce93; --amber:#f0a857; --blue:#6ba3ff; --cyan:#5fd0dd; --rose:#ff8a8a; --sand:#e3c38a;
  --font:'Inter','Noto Sans SC',system-ui,sans-serif;
  --mono:'JetBrains Mono',ui-monospace,monospace;
  position:absolute; inset:0; z-index:100; display:flex; flex-direction:column;
  color:var(--ink); font-family:var(--font); -webkit-font-smoothing:antialiased; overflow:hidden;
  background:
    radial-gradient(1200px 700px at 78% -10%, rgba(139,109,240,0.10), transparent 60%),
    radial-gradient(900px 600px at 0% 110%, rgba(95,208,221,0.05), transparent 55%),
    var(--bg);
}
.zkw * { box-sizing:border-box; }
.zkw ::-webkit-scrollbar { width:10px; height:10px; }
.zkw ::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.08); border-radius:6px; border:2px solid transparent; background-clip:padding-box; }
.zkw ::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,0.16); background-clip:padding-box; }

/* ───────── Toolbar ───────── */
.zkw .tbar { height:52px; flex-shrink:0; display:flex; align-items:center; gap:14px; padding:0 16px; border-bottom:1px solid var(--rule); background:rgba(8,9,13,0.7); backdrop-filter:blur(12px); z-index:30; }
.zkw .brand { display:flex; align-items:center; gap:9px; font-weight:700; font-size:14px; letter-spacing:-0.01em; }
.zkw .brand .mk { width:22px; height:22px; border-radius:6px; background:linear-gradient(135deg,var(--violet),var(--violet-d)); display:flex; align-items:center; justify-content:center; color:#1a1330; font-weight:800; font-size:13px; box-shadow:0 2px 10px rgba(139,109,240,0.4); }
.zkw .brand .sub { font-family:var(--mono); font-size:10px; color:var(--ink-faint); font-weight:500; margin-left:2px; }
.zkw .tbar .spacer { flex:1; }
.zkw .tbar .hint { font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); white-space:nowrap; }
.zkw .tbar .hint b { color:var(--ink-dim); font-weight:600; }
.zkw .tbar .home { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--ink-dim); cursor:pointer; padding:6px 12px; border-radius:8px; border:1px solid var(--rule-2); }
.zkw .tbar .home:hover { color:var(--ink); border-color:var(--rule-3); }
.zkw .tbar .ticon { width:30px; height:30px; border:1px solid var(--rule-2); border-radius:8px; display:flex; align-items:center; justify-content:center; color:var(--ink-dim); cursor:pointer; }
.zkw .tbar .ticon:hover { color:var(--ink); border-color:var(--rule-3); background:var(--panel-2); }
.zkw .tbar .ticon svg { width:16px; height:16px; }

/* ───────── Body grid ───────── */
.zkw .body { flex:1; min-height:0; display:grid; grid-template-columns:296px 1fr; position:relative; }

/* ───────── Type glyphs ───────── */
.zkw .g { width:15px; height:15px; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; position:relative; }
.zkw .g.space::before { content:''; width:11px; height:11px; border-radius:3px; background:currentColor; transform:rotate(45deg); }
.zkw .g.moc::before { content:''; width:12px; height:12px; border-radius:50%; border:1.6px solid currentColor; }
.zkw .g.moc::after { content:''; position:absolute; width:4px; height:4px; border-radius:50%; background:currentColor; }
.zkw .g.note::before { content:''; width:7px; height:7px; border-radius:50%; background:currentColor; }
.zkw .g.map::before { content:''; width:11px; height:11px; border-radius:2.5px; border:1.6px solid currentColor; }
.zkw .g.map::after { content:''; position:absolute; width:5px; height:1.6px; background:currentColor; border-radius:1px; box-shadow:0 3px 0 currentColor, 0 -3px 0 currentColor; transform:scaleX(0.7); }
.zkw .g.proj::before { content:''; width:11px; height:11px; border-radius:50%; border:2px solid currentColor; border-right-color:transparent; transform:rotate(-45deg); }
.zkw .g.folder::before { content:''; width:12px; height:9px; border-radius:1.5px 2.5px 2.5px 2.5px; background:currentColor; clip-path:polygon(0 22%, 42% 22%, 52% 0, 100% 0, 100% 100%, 0 100%); }

/* ───────── Nav rail ───────── */
.zkw .rail { border-right:1px solid var(--rule); background:var(--panel); min-height:0; display:flex; flex-direction:column; }
.zkw .rail-head { padding:13px 14px 9px; display:flex; align-items:center; gap:8px; }
.zkw .rail-head .t { font-size:13px; font-weight:700; letter-spacing:-0.01em; }
.zkw .rail-head .meta { font-family:var(--mono); font-size:9.5px; color:var(--ink-faint); margin-left:auto; }
.zkw .rail-head .add { width:22px; height:22px; border:1px solid var(--rule-2); border-radius:6px; display:flex; align-items:center; justify-content:center; color:var(--ink-faint); cursor:pointer; font-size:14px; }
.zkw .rail-head .add:hover { color:var(--ink); border-color:var(--rule-3); }
.zkw .rail-scroll { flex:1; min-height:0; overflow-y:auto; padding:2px 0 18px; }

.zkw .srow { display:flex; align-items:center; gap:8px; padding:7px 14px 6px; cursor:pointer; user-select:none; }
.zkw .caret { width:12px; flex:none; font-size:11px; line-height:1; text-align:center; color:var(--ink-faint); transition:transform .15s; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; }
.zkw .caret:hover { color:var(--ink); }
.zkw .caret.open { transform:rotate(90deg); }
.zkw .caret.leaf { visibility:hidden; }
.zkw .srow .caret { width:12px; font-size:11px; color:var(--ink-faint); transition:transform .15s; }
.zkw .srow.open .caret { transform:rotate(90deg); }
.zkw .srow .nm { font-size:14px; font-weight:700; letter-spacing:-0.01em; color:#f3f4f8; white-space:nowrap; }
.zkw .srow .fw { margin-left:auto; }
.zkw .srow:hover { background:rgba(255,255,255,0.02); }

.zkw .nrow { display:flex; align-items:center; gap:8px; padding:5px 12px 5px 30px; font-size:13px; font-weight:400; color:var(--ink-dim); cursor:pointer; user-select:none; position:relative; }
.zkw .nguide { position:absolute; top:0; bottom:0; width:1px; background:var(--rule); pointer-events:none; }
.zkw .nrow:hover { background:rgba(255,255,255,0.035); }
.zkw .nrow.sel { background:linear-gradient(90deg, rgba(139,109,240,0.16), rgba(139,109,240,0.04)); box-shadow:inset 2px 0 0 var(--violet); }
.zkw .nrow.sel .nm { color:#d8c9ff; }
.zkw .nrow .nm { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.zkw .nrow .nm.dim { color:var(--ink-dim); font-weight:400; }
.zkw .nrow.l2 { padding-left:44px; }
.zkw .nrow.l3 { padding-left:58px; }

.zkw .fwchip { display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:9px; font-weight:600; padding:2px 7px; border-radius:99px; cursor:pointer; letter-spacing:0.02em; white-space:nowrap; }
.zkw .fwchip.para { color:var(--violet); background:rgba(183,157,255,0.12); border:1px solid rgba(183,157,255,0.3); }
.zkw .fwchip.overview { color:var(--cyan); background:rgba(95,208,221,0.12); border:1px solid rgba(95,208,221,0.3); }
.zkw .fwchip.custom { color:var(--ink-dim); background:rgba(255,255,255,0.05); border:1px solid var(--rule-2); }
.zkw .fwchip:hover { filter:brightness(1.18); }

.zkw .bucket { display:flex; align-items:center; gap:7px; padding:9px 14px 3px 16px; cursor:pointer; }
.zkw .bucket:hover .bl { color:var(--ink-dim); }
.zkw .bucket.sel .bl { color:var(--violet); }
.zkw .bucket .bl { font-family:var(--mono); font-size:11px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; color:var(--ink-faint); }
.zkw .bucket .bc { font-family:var(--mono); font-size:9px; color:var(--ink-ghost); }
.zkw .bucket .bline { flex:1; height:1px; background:var(--rule); }

.zkw .sd { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
.zkw .sd.todo { background:transparent; box-shadow:inset 0 0 0 1.5px var(--ink-dim); }
.zkw .sd.active { background:var(--green); box-shadow:0 0 6px rgba(111,206,147,0.6); }
.zkw .sd.blocked { background:var(--amber); }
.zkw .sd.done { background:var(--blue); }
.zkw .sd.archived { background:var(--ink-faint); }

.zkw .npg { width:26px; height:3px; border-radius:2px; background:var(--panel-3); overflow:hidden; flex-shrink:0; margin-left:auto; }
.zkw .npg i { display:block; height:100%; border-radius:2px; }

.zkw .mcount { font-family:var(--mono); font-size:9px; color:var(--violet); background:rgba(183,157,255,0.1); border:1px solid rgba(183,157,255,0.22); border-radius:99px; padding:0 6px; margin-left:auto; flex-shrink:0; }

.zkw .rail-foot { border-top:1px solid var(--rule); padding:10px 14px; font-family:var(--mono); font-size:9.5px; line-height:1.6; background:var(--panel-2); }
.zkw .rail-foot.re { color:var(--green); }
.zkw .rail-foot.re b { color:#a8e8c0; }

/* ───────── Center ───────── */
.zkw .center { min-height:0; overflow-y:auto; position:relative; }

.zkw .ck { padding:0 0 60px; }
.zkw .ck-hero { padding:30px 40px 22px; border-bottom:1px solid var(--rule); position:sticky; top:0; background:linear-gradient(180deg, var(--bg) 60%, transparent); z-index:5; }
.zkw .ck-crumb { font-family:var(--mono); font-size:11px; color:var(--ink-faint); margin-bottom:14px; }
.zkw .ck-crumb .seg { cursor:pointer; }
.zkw .ck-crumb .seg:hover { color:var(--ink-dim); }
.zkw .ck-crumb .s { opacity:0.5; margin:0 5px; }
.zkw .ck-titlerow { display:flex; align-items:flex-start; gap:16px; }
.zkw .ck-bigic { width:46px; height:46px; border-radius:12px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.zkw .ck-bigic.space { background:rgba(255,255,255,0.06); border:1px solid var(--rule-2); }
.zkw .ck-bigic .g { width:22px; height:22px; }
.zkw .ck-bigic .g.space::before { width:17px; height:17px; }
.zkw .ck-bigic .g.moc::before { width:18px; height:18px; }
.zkw .ck-h1 { font-size:27px; font-weight:800; letter-spacing:-0.025em; margin:0; line-height:1.15; }
.zkw .ck-tagrow { display:flex; align-items:center; gap:9px; margin-top:9px; flex-wrap:wrap; }
.zkw .ck-tagrow .stat { font-family:var(--mono); font-size:10.5px; color:var(--ink-dim); }
.zkw .ck-tagrow .stat b { color:var(--ink); }
.zkw .ck-tagrow .dotsep { color:var(--ink-ghost); }
.zkw .ck-desc { font-size:13.5px; color:var(--ink-dim); line-height:1.6; margin-top:13px; max-width:600px; }

.zkw .fwbar { display:flex; align-items:center; gap:10px; margin-top:18px; padding:11px 14px; background:var(--panel); border:1px solid var(--rule-2); border-radius:11px; }
.zkw .fwbar .lbl { font-family:var(--mono); font-size:10px; color:var(--ink-faint); letter-spacing:0.05em; }
.zkw .fwbar .opts { display:flex; gap:6px; }
.zkw .fwopt { font-family:var(--mono); font-size:11px; font-weight:600; padding:5px 12px; border-radius:7px; cursor:pointer; border:1px solid transparent; color:var(--ink-dim); background:var(--panel-2); transition:all .14s; white-space:nowrap; }
.zkw .fwopt:hover { color:var(--ink); }
.zkw .fwopt.on { color:#fff; }
.zkw .fwopt.on.para { background:rgba(139,109,240,0.22); border-color:var(--violet); color:#d8c9ff; }
.zkw .fwopt.on.overview { background:rgba(95,208,221,0.18); border-color:var(--cyan); color:#bff0f5; }
.zkw .fwopt.on.custom { background:var(--panel-3); border-color:var(--rule-3); color:var(--ink); }
.zkw .fwbar .fwnote { font-size:11px; color:var(--ink-faint); margin-left:auto; }
.zkw .fwbar .fwnote b { color:var(--violet); }

.zkw .lenstabs { display:flex; gap:4px; padding:16px 40px 0; flex-wrap:wrap; }
.zkw .lenstab { font-size:12px; font-weight:600; padding:7px 14px; border-radius:8px 8px 0 0; cursor:pointer; color:var(--ink-dim); border-bottom:2px solid transparent; display:flex; align-items:center; gap:7px; white-space:nowrap; }
.zkw .lenstab:hover { color:var(--ink); }
.zkw .lenstab.on { color:var(--ink); border-bottom-color:var(--violet); background:linear-gradient(180deg, transparent, rgba(139,109,240,0.06)); }
.zkw .lenstab .c { font-family:var(--mono); font-size:9.5px; color:var(--ink-faint); }

.zkw .createbar { display:flex; gap:8px; padding:16px 40px 0; flex-wrap:wrap; }
.zkw .createbtn { font-size:12px; font-weight:600; padding:6px 12px; border-radius:8px; cursor:pointer; color:var(--ink-dim); background:var(--panel); border:1px solid var(--rule-2); white-space:nowrap; }
.zkw .createbtn:hover { color:#d8c9ff; border-color:var(--violet); background:rgba(139,109,240,0.12); }

.zkw .ck-body { padding:24px 40px 0; }
.zkw .sectitle { display:flex; align-items:center; gap:8px; margin:24px 0 12px; }
.zkw .sectitle:first-child { margin-top:8px; }
.zkw .sectitle .st { font-size:13px; font-weight:700; }
.zkw .sectitle .sc { font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); }
.zkw .sectitle .sq { width:14px; height:14px; border-radius:50%; border:1px solid var(--rule-2); color:var(--ink-faint); font-size:9px; font-weight:600; display:inline-flex; align-items:center; justify-content:center; cursor:help; }
.zkw .sectitle .sq:hover { color:var(--ink-dim); border-color:var(--rule-3); }

.zkw .pgrid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.zkw .pcard { border:1px solid var(--rule-2); border-radius:12px; background:var(--panel); padding:16px; cursor:pointer; transition:border-color .14s, transform .14s, background .14s; position:relative; overflow:hidden; }
.zkw .pcard:hover { border-color:var(--rule-3); background:var(--panel-2); transform:translateY(-1px); }
.zkw .pcard.arch { opacity:0.5; }
.zkw .pcard .ptop { display:flex; align-items:center; gap:9px; margin-bottom:10px; }
.zkw .pcard .pstat { display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:10px; padding:3px 9px 3px 7px; border-radius:99px; }
.zkw .pcard .pstat.todo { color:var(--ink-dim); background:rgba(255,255,255,0.04); border:1px solid var(--rule-2); }
.zkw .pcard .pstat.active { color:var(--green); background:rgba(111,206,147,0.1); border:1px solid rgba(111,206,147,0.25); }
.zkw .pcard .pstat.blocked { color:var(--amber); background:rgba(240,168,87,0.1); border:1px solid rgba(240,168,87,0.25); }
.zkw .pcard .pstat.done { color:var(--blue); background:rgba(107,163,255,0.1); border:1px solid rgba(107,163,255,0.25); }
.zkw .pcard .pstat.archived { color:var(--ink-faint); background:rgba(255,255,255,0.03); border:1px solid var(--rule); }
.zkw .pcard .pstat.click { cursor:pointer; }
.zkw .pcard .plast { font-family:var(--mono); font-size:9.5px; color:var(--ink-ghost); margin-left:auto; }
.zkw .pcard .pname { font-size:15px; font-weight:700; letter-spacing:-0.01em; margin-bottom:9px; }
.zkw .pcard .pnext { font-size:11.5px; color:var(--ink-dim); line-height:1.5; margin-bottom:13px; display:flex; gap:6px; }
.zkw .pcard .pnext .na { color:var(--ink-faint); font-family:var(--mono); font-size:9.5px; flex-shrink:0; padding-top:1px; }
.zkw .pcard .pbar { height:5px; border-radius:3px; background:var(--panel-3); overflow:hidden; margin-bottom:11px; }
.zkw .pcard .pbar i { display:block; height:100%; border-radius:3px; }
.zkw .pcard .prefs { display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
.zkw .prefs .rl { font-family:var(--mono); font-size:9px; color:var(--ink-ghost); }
.zkw .refchip { font-family:var(--mono); font-size:9.5px; color:var(--violet); background:rgba(183,157,255,0.09); border:1px solid rgba(183,157,255,0.2); border-radius:99px; padding:1px 8px 1px 6px; cursor:pointer; display:inline-flex; align-items:center; gap:3px; }
.zkw .refchip:hover { background:rgba(183,157,255,0.18); }
.zkw .refchip.cross { color:var(--amber); background:rgba(240,168,87,0.09); border-color:rgba(240,168,87,0.24); }

.zkw .moccard { border:1px solid var(--rule-2); border-radius:12px; background:var(--panel); padding:16px; cursor:pointer; transition:border-color .14s, background .14s; }
.zkw .moccard:hover { border-color:rgba(183,157,255,0.4); background:var(--panel-2); }
/* 空 MOC(聚合 0):压成单行紧凑卡,不留空白 */
.zkw .moccard.empty-moc { padding:12px 16px; }
.zkw .moccard.empty-moc .mname { font-weight:600; color:var(--ink-dim); }
.zkw .moccard .mtop { display:flex; align-items:center; gap:12px; }
.zkw .moccard .mname { font-size:15px; font-weight:700; }
.zkw .moccard .magg { font-family:var(--mono); font-size:9.5px; color:var(--violet); background:rgba(183,157,255,0.1); border:1px solid rgba(183,157,255,0.22); border-radius:99px; padding:2px 9px; margin-left:auto; }
.zkw .moccard .mlist { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.zkw .moccard .mitem { font-size:11px; color:var(--ink-dim); display:inline-flex; align-items:center; gap:5px; background:var(--panel-2); border:1px solid var(--rule); border-radius:7px; padding:3px 9px; cursor:pointer; }
.zkw .moccard .mitem:hover { border-color:var(--rule-3); }

.zkw .notegrid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
.zkw .notecard { border:1px solid var(--rule); border-radius:10px; background:var(--panel); padding:12px 13px; cursor:pointer; display:flex; align-items:center; gap:10px; font-size:12.5px; transition:border-color .14s; }
.zkw .notecard:hover { border-color:var(--rule-3); }
.zkw .notecard .nn { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.zkw .notecard .nmeta { font-family:var(--mono); font-size:9px; color:var(--ink-ghost); margin-left:auto; }

/* 卡片名字 = 跳转热区(点空白处则开详情/关联面板) */
.zkw .mname.link, .zkw .pname.link, .zkw .nn.link { cursor:pointer; }
.zkw .mname.link:hover, .zkw .pname.link:hover, .zkw .nn.link:hover { color:var(--violet); text-decoration:underline; text-underline-offset:2px; }

.zkw .empty { color:var(--ink-faint); font-size:12px; padding:8px 0; }

/* ───────── 进度控制(项目页手动可拖) ───────── */
.zkw .progctl { background:var(--panel); border:1px solid var(--rule-2); border-radius:12px; padding:16px; margin-bottom:8px; }
.zkw .progctl .pbar { height:8px; border-radius:4px; background:var(--panel-3); overflow:hidden; }
.zkw .progctl .pbar i { display:block; height:100%; border-radius:4px; transition:width .1s linear; }
.zkw .progrow { display:flex; align-items:center; gap:12px; margin-top:12px; flex-wrap:wrap; }
.zkw .progslider { flex:1; min-width:160px; -webkit-appearance:none; appearance:none; height:4px; border-radius:2px; background:var(--panel-3); outline:none; cursor:pointer; }
.zkw .progslider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:16px; height:16px; border-radius:50%; background:var(--violet); border:2px solid var(--panel); cursor:pointer; box-shadow:0 1px 4px rgba(0,0,0,0.45); }
.zkw .progslider::-webkit-slider-thumb:hover { filter:brightness(1.12); }
.zkw .progval { font-family:var(--mono); font-size:13px; font-weight:600; color:var(--ink); min-width:44px; text-align:right; }
.zkw .proghint { flex-basis:100%; font-family:var(--mono); font-size:10px; color:var(--ink-faint); }
.zkw .proghint .reset { color:var(--violet); cursor:pointer; }
.zkw .proghint .reset:hover { text-decoration:underline; }

/* ───────── NEXT ACTION 动作列表 ───────── */
.zkw .actions { display:flex; flex-direction:column; gap:8px; }
.zkw .action { display:flex; align-items:flex-start; gap:10px; padding:12px; background:var(--panel); border:1px solid var(--rule-2); border-radius:10px; }
.zkw .action.done { opacity:0.62; }
.zkw .action.locked { opacity:0.55; }
.zkw .action .aord { font-family:var(--mono); font-size:10px; color:var(--ink-faint); min-width:14px; text-align:center; padding-top:3px; flex-shrink:0; }
.zkw .astat { width:16px; height:16px; border-radius:50%; flex-shrink:0; cursor:pointer; margin-top:1px; position:relative; }
.zkw .astat.todo { box-shadow:inset 0 0 0 2px var(--ink-faint); }
.zkw .astat.doing { background:var(--amber); box-shadow:0 0 6px rgba(240,168,87,0.5); }
.zkw .astat.done { background:var(--green); }
.zkw .astat.done::after { content:'✓'; position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:10px; color:#0b1410; font-weight:800; }
.zkw .action.locked .astat { cursor:not-allowed; }
.zkw .amain { flex:1; min-width:0; display:flex; flex-direction:column; gap:8px; }
.zkw .ahead { display:flex; align-items:center; gap:8px; min-width:0; }
.zkw .action .atext { flex:1; min-width:0; background:transparent; border:none; border-bottom:1px solid transparent; color:var(--ink); font-size:14px; outline:none; font-family:var(--font); padding:2px 0; }
.zkw .action .atext:focus { border-bottom-color:var(--rule-2); }
.zkw .action.done .atext { text-decoration:line-through; color:var(--ink-dim); }
.zkw .alink { flex:1; min-width:0; display:inline-flex; align-items:center; gap:7px; font-size:14px; color:var(--violet); cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.zkw .alink:hover { text-decoration:underline; }
.zkw .alinkbtn, .zkw .aunlink { flex-shrink:0; width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center; border-radius:6px; font-size:12px; color:var(--ink-faint); cursor:pointer; border:1px solid transparent; }
.zkw .alinkbtn:hover, .zkw .aunlink:hover { color:var(--ink); background:var(--panel-2); border-color:var(--rule-2); }
.zkw .alocked { font-family:var(--mono); font-size:10px; color:var(--amber); }
.zkw .aprog { display:flex; align-items:center; gap:10px; }
.zkw .aprog .pbar { flex:1; height:5px; border-radius:3px; background:var(--panel-3); overflow:hidden; }
.zkw .aprog .pbar i { display:block; height:100%; border-radius:3px; transition:width .1s linear; }
.zkw .progslider.sm { flex:0 0 120px; min-width:0; }
.zkw .progval.sm { font-size:11px; min-width:34px; }
.zkw .actl { display:flex; align-items:center; gap:4px; flex-shrink:0; }
.zkw .adep { font-family:var(--mono); font-size:9.5px; padding:2px 7px; border-radius:99px; cursor:pointer; color:var(--ink-faint); border:1px solid var(--rule-2); white-space:nowrap; }
.zkw .adep:hover { color:var(--ink-dim); border-color:var(--rule-3); }
.zkw .adep.on { color:var(--violet); background:rgba(183,157,255,0.12); border-color:rgba(183,157,255,0.35); }
.zkw .aicon { width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center; border-radius:6px; font-size:12px; color:var(--ink-faint); cursor:pointer; }
.zkw .aicon:hover { color:var(--ink); background:var(--panel-2); }
.zkw .aicon.off { opacity:0.25; pointer-events:none; }
.zkw .aicon.del:hover { color:var(--rose); }
.zkw .action-add { display:flex; align-items:center; gap:8px; margin-top:10px; }
.zkw .action-add .atext { flex:1; background:var(--panel-2); border:1px solid var(--rule-2); border-radius:8px; color:var(--ink); font-size:13px; outline:none; font-family:var(--font); padding:8px 12px; }
.zkw .action-add .atext:focus { border-color:var(--rule-3); }
.zkw .achip { font-size:12px; font-weight:600; padding:8px 12px; border-radius:8px; cursor:pointer; white-space:nowrap; color:var(--ink-dim); border:1px solid var(--rule-2); }
.zkw .achip:hover { color:var(--ink); border-color:var(--rule-3); }
.zkw .achip.cta { color:#d8c9ff; background:rgba(139,109,240,0.18); border-color:var(--violet); }

/* ───────── Detail deck ───────── */
.zkw .scrim { position:absolute; inset:0; background:rgba(4,5,7,0.45); opacity:0; pointer-events:none; transition:opacity .22s; z-index:18; }
.zkw .scrim.show { opacity:1; pointer-events:auto; }
.zkw .deck { position:absolute; top:0; right:0; bottom:0; width:480px; max-width:46vw; background:var(--panel); border-left:1px solid var(--rule-2); z-index:20; display:flex; flex-direction:column; transform:translateX(100%); transition:transform .26s cubic-bezier(.4,0,.2,1); box-shadow:-30px 0 70px rgba(0,0,0,0.5); }
.zkw .deck.open { transform:translateX(0); }
.zkw .deck-head { padding:20px 24px 16px; border-bottom:1px solid var(--rule); }
.zkw .deck-top { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
.zkw .deck-badge { display:inline-flex; align-items:center; gap:7px; font-family:var(--mono); font-size:10.5px; font-weight:600; letter-spacing:0.03em; padding:4px 11px; border-radius:99px; white-space:nowrap; }
.zkw .deck-badge .bd { width:8px; height:8px; border-radius:50%; }
.zkw .deck-top .sp { flex:1; }
.zkw .deck-icon { width:30px; height:30px; border:1px solid var(--rule-2); border-radius:8px; display:flex; align-items:center; justify-content:center; color:var(--ink-faint); cursor:pointer; }
.zkw .deck-icon:hover { color:var(--ink); border-color:var(--rule-3); }
.zkw .deck-icon.pinned { color:var(--violet); border-color:rgba(183,157,255,0.4); background:rgba(183,157,255,0.08); }
.zkw .deck-h2 { font-size:21px; font-weight:800; letter-spacing:-0.02em; line-height:1.25; margin:0; }
.zkw .deck-crumb { font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); margin-top:11px; line-height:1.5; }
.zkw .deck-crumb .s { opacity:0.5; margin:0 5px; }
.zkw .deck-body { flex:1; overflow-y:auto; padding:20px 24px; }

.zkw .dmeta { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:20px; }
.zkw .dmeta .mi { background:var(--panel-2); border:1px solid var(--rule); border-radius:9px; padding:10px 12px; }
.zkw .dmeta .mi .k { font-family:var(--mono); font-size:9px; color:var(--ink-faint); letter-spacing:0.05em; text-transform:uppercase; margin-bottom:5px; }
.zkw .dmeta .mi .v { font-size:13px; font-weight:600; }
.zkw .dbar { height:6px; border-radius:3px; background:var(--panel-3); overflow:hidden; margin-top:7px; }
.zkw .dbar i { display:block; height:100%; border-radius:3px; }
.zkw .dsec { font-family:var(--mono); font-size:10px; color:var(--ink-faint); letter-spacing:0.07em; text-transform:uppercase; margin:22px 0 11px; }
.zkw .dsec.row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.zkw .dsec-add { font-family:var(--font); font-size:11px; font-weight:600; color:#d8c9ff; background:rgba(139,109,240,0.16); border:1px solid var(--violet); border-radius:7px; padding:4px 10px; cursor:pointer; text-transform:none; letter-spacing:0; }
.zkw .dsec-add:hover { background:rgba(139,109,240,0.28); }
.zkw .dchip-x { color:var(--ink-faint); cursor:pointer; font-size:9px; margin-left:1px; }
.zkw .dchip-x:hover { color:var(--rose); }
.zkw .prose { font-size:14px; line-height:1.75; color:var(--ink); }
.zkw .prose p { margin:0 0 12px; }
.zkw .prose code { font-family:var(--mono); font-size:12.5px; color:var(--cyan); }
.zkw .prose pre { font-family:var(--mono); font-size:12px; line-height:1.65; color:#cdd6e6; background:var(--bg2); border:1px solid var(--rule); border-radius:9px; padding:13px 15px; overflow-x:auto; margin:0 0 14px; }
.zkw .dchips { display:flex; flex-wrap:wrap; gap:6px; }
.zkw .dchip { font-family:var(--mono); font-size:10.5px; padding:5px 11px; border-radius:99px; border:1px solid var(--rule-2); color:var(--ink-dim); cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
.zkw .dchip:hover { border-color:var(--violet); color:var(--ink); }
.zkw .dchip .a { color:var(--violet); }
.zkw .deck-foot { border-top:1px solid var(--rule); padding:13px 24px 40px; display:flex; gap:10px; background:var(--panel); }
.zkw .deck-foot .close { flex:1; padding:10px; background:var(--panel-2); border:1px solid var(--rule-2); border-radius:9px; color:var(--ink-dim); font-size:12px; cursor:pointer; font-family:var(--font); font-weight:500; }
.zkw .deck-foot .close:hover { color:var(--ink); border-color:var(--rule-3); }

.zkw .reveal { animation:zkw-rv .3s ease both; }
@keyframes zkw-rv { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
`;
