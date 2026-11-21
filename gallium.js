// galliumOS - a monochrome fake desktop OS in one file.
// deploy: npx wrangler deploy   (serves the whole OS from this worker, no assets or build step)

const CSS = `:root{--ease:cubic-bezier(.22,1,.36,1);--spring:cubic-bezier(.34,1.45,.64,1);
--font:"Bricolage Grotesque",system-ui,sans-serif;--mono:"Spline Sans Mono",ui-monospace,Menlo,monospace;
--bg:#050505;--fg:#ececec;--dim:rgba(236,236,236,.52);--faint:rgba(236,236,236,.07);--hover:rgba(236,236,236,.1);--line:rgba(236,236,236,.11);
--glass:rgba(18,18,18,.72);--edge:rgba(255,255,255,.09);--r:14px;--blur:28px;--dur:.45s;
--shadow:0 0 0 .5px rgba(0,0,0,.7),0 1px 1px rgba(0,0,0,.2),0 10px 20px -6px rgba(0,0,0,.4),0 30px 70px -14px rgba(0,0,0,.65);--hl:inset 0 1px 0 rgba(255,255,255,.06)}
[data-theme=light]{--bg:#e9e9e9;--fg:#0b0b0b;--dim:rgba(11,11,11,.55);--faint:rgba(11,11,11,.06);--hover:rgba(11,11,11,.08);--line:rgba(11,11,11,.1);
--glass:rgba(250,250,250,.74);--edge:rgba(0,0,0,.08);--hl:inset 0 1px 0 rgba(255,255,255,.9);
--shadow:0 0 0 .5px rgba(0,0,0,.12),0 1px 1px rgba(0,0,0,.04),0 10px 20px -6px rgba(0,0,0,.1),0 30px 70px -14px rgba(0,0,0,.28)}
[data-theme=minimal]{--font:"Spline Sans Mono",ui-monospace,Menlo,monospace;--bg:#fafafa;--fg:#111;--dim:rgba(17,17,17,.5);--faint:rgba(17,17,17,.05);--hover:rgba(17,17,17,.08);--line:#111;
--glass:#fafafa;--edge:#111;--r:0px;--blur:0px;--shadow:none;--hl:none;--dur:.25s}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--fg);font:400 13px/1.4 var(--font);-webkit-font-smoothing:antialiased;letter-spacing:-.01em;user-select:none;-webkit-user-select:none;transition:background var(--dur),color var(--dur)}
[data-theme=minimal] body{font-size:12px;letter-spacing:-.03em}
@media (pointer:fine){*{cursor:none!important}}
button{font:inherit;color:inherit;background:none;border:0}
input,textarea{font:inherit;color:inherit;user-select:text;-webkit-user-select:text}
svg.ic{width:1em;height:1em;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.glass{background:var(--glass);backdrop-filter:blur(var(--blur)) saturate(1.6);-webkit-backdrop-filter:blur(var(--blur)) saturate(1.6);border:1px solid var(--edge);box-shadow:var(--shadow),var(--hl);border-radius:var(--r)}
.mono{font-family:var(--mono)}
.btn{padding:6px 13px;border-radius:calc(var(--r) - 6px);background:var(--faint);border:1px solid var(--line);font-weight:500;font-size:12.5px;transition:background .2s,transform .25s var(--spring),opacity .2s;display:inline-flex;align-items:center;gap:7px}
.btn:hover{background:var(--hover)}.btn:active{transform:scale(.95)}
.btn.pri{background:var(--fg);color:var(--bg);border-color:var(--fg)}.btn.pri:hover{opacity:.85}
.btn.dng{background:#fff;color:#000}
.btn.sm{padding:4px 9px;font-size:12px}.btn[disabled]{opacity:.35;pointer-events:none}
.empty{color:var(--dim);text-align:center;padding:26px 0}

/* background layers */
#wall,#wv,#wi,#vig{position:fixed;inset:0;width:100%;height:100%;transition:opacity .7s var(--ease)}
#wv,#wi{object-fit:cover;opacity:0}#wv.on,#wi.on{opacity:1}
#wall.hide{opacity:0}
#vig{pointer-events:none;background:radial-gradient(ellipse at 50% 45%,transparent 40%,rgba(0,0,0,.55) 100%);opacity:1}
[data-theme=light] #vig{background:radial-gradient(ellipse at 50% 45%,transparent 45%,rgba(255,255,255,.5) 100%)}
#dimv{position:fixed;inset:0;background:var(--bg);pointer-events:none;opacity:0;transition:opacity .4s}
[data-theme=minimal] #wall,[data-theme=minimal] #wv,[data-theme=minimal] #wi,[data-theme=minimal] #vig,[data-theme=minimal] #dimv{opacity:0!important}

/* boot */
#boot{position:fixed;inset:0;z-index:9999;background:#000;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px;transition:opacity .9s var(--ease),transform .9s var(--ease),visibility 0s .9s}
#boot.done{opacity:0;transform:scale(1.06);visibility:hidden;pointer-events:none}
#boot svg{width:60px;height:60px;stroke-width:1.1;animation:pulse 2.4s var(--ease) infinite}
#boot .name{font:400 13px var(--mono);letter-spacing:.3em;padding-left:.3em;opacity:0;animation:rise 1s .2s var(--ease) forwards}
#boot .bar{width:130px;height:2px;background:rgba(255,255,255,.14);border-radius:2px;overflow:hidden}
#boot .bar i{display:block;height:100%;width:0;background:#fff;animation:load 2s .3s var(--ease) forwards}
@keyframes load{to{width:100%}}@keyframes rise{from{opacity:0;transform:translateY(10px);filter:blur(6px)}to{opacity:1;filter:none}}@keyframes pulse{50%{transform:scale(1.07);opacity:.7}}
@keyframes blink{50%{opacity:.25}}@keyframes shake{20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}
@keyframes fi{from{opacity:0}}@keyframes up{from{opacity:0;transform:translateY(10px)}}

#desk{position:fixed;inset:0;opacity:0;transform:scale(.985);transition:opacity 1s var(--ease),transform 1s var(--ease);pointer-events:none}
#desk.on{opacity:1;transform:none;pointer-events:auto}

/* menu bar */
#bar{position:fixed;top:0;left:0;right:0;height:32px;z-index:500;display:flex;align-items:center;justify-content:space-between;padding:0 8px;border-radius:0;border-width:0 0 1px;box-shadow:none;transform:translateY(-40px);transition:transform .9s .2s var(--ease)}
#desk.on #bar{transform:none}
.grp{display:flex;align-items:center;gap:1px}
.chip{position:relative;display:flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:calc(var(--r) - 7px);font-weight:450;font-size:12.5px;transition:background .2s,transform .25s var(--spring)}
.chip:hover,.chip.open{background:var(--hover)}.chip:active{transform:scale(.95)}
.chip svg{font-size:14px}.brand{font-weight:650;padding-left:6px}
#appname{color:var(--dim);font-weight:500;transition:opacity .25s}
#barclock,#bpct{font-variant-numeric:tabular-nums}
.batt{position:relative;width:22px;height:11px;border:1.3px solid currentColor;border-radius:3.5px}
.batt::after{content:"";position:absolute;right:-4px;top:2.5px;width:2px;height:4px;background:currentColor;border-radius:0 2px 2px 0}
.batt i{position:absolute;inset:1.3px;width:calc(var(--lvl,1)*(100% - 2.6px));background:currentColor;border-radius:1.5px;transition:width .8s var(--ease)}
.batt.low i{animation:blink 1.2s infinite}
.batt.chg::before{content:"";position:absolute;left:50%;top:50%;width:7px;height:9px;margin:-4.5px 0 0 -3.5px;background:#fff;mix-blend-mode:difference;z-index:2;clip-path:polygon(60% 0,0 58%,45% 58%,35% 100%,100% 40%,55% 40%)}
.badge{position:absolute;top:4px;right:6px;width:6px;height:6px;border-radius:50%;background:var(--fg);transform:scale(0);transition:transform .35s var(--spring)}.badge.on{transform:scale(1)}

/* panels */
.panel{position:fixed;z-index:600;top:42px;right:8px;opacity:0;transform:translateY(-8px) scale(.96);transform-origin:top right;pointer-events:none;transition:opacity .25s var(--ease),transform .45s var(--spring);border-radius:calc(var(--r) + 4px)}
.panel.show{opacity:1;transform:none;pointer-events:auto}
[data-theme=minimal] .panel{top:32px;right:0}
#qs{width:330px;padding:12px;display:flex;flex-direction:column;gap:8px}
#nc{width:340px;max-height:70vh;padding:14px;display:flex;flex-direction:column;gap:10px}
#cal{width:300px;padding:14px}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.tile{display:flex;align-items:center;gap:10px;padding:10px;border-radius:calc(var(--r) - 0px);background:var(--faint);min-width:0;transition:background .25s}
.tile:hover{background:var(--hover)}
.tile svg{width:32px;height:32px;padding:8px;border-radius:50%;background:var(--hover);transition:background .3s,color .3s,transform .4s var(--spring)}
.tile:hover svg{transform:scale(1.08) rotate(-5deg)}
.tile.act svg{background:var(--fg);color:var(--bg)}
.tile .tx{min-width:0;text-align:left}.tile b{display:block;font-weight:550;font-size:12.5px;white-space:nowrap}.tile small{display:block;opacity:.55;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sec{display:flex;flex-direction:column;gap:9px;padding:12px 14px;border-radius:var(--r);background:var(--faint)}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px}
.row span:last-child{font:400 11.5px var(--mono);color:var(--dim)}.row b{font-weight:550}
.meter{height:5px;border-radius:5px;background:var(--line);overflow:hidden}.meter i{display:block;height:100%;background:var(--fg);width:calc(var(--lvl,0)*100%);border-radius:5px;transition:width .8s var(--ease)}
input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:28px;border-radius:calc(var(--r) - 5px);outline:none;overflow:hidden;background:linear-gradient(to right,var(--fg) calc(var(--v,100)*1%),var(--hover) 0)}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:0;height:0}input[type=range]::-moz-range-thumb{width:0;height:0;border:0}
.mini{padding:3px 9px;border-radius:calc(var(--r) - 7px);background:var(--faint);font:500 11px var(--mono);transition:background .2s,transform .25s var(--spring)}.mini:hover{background:var(--hover)}.mini:active{transform:scale(.93)}
.nlist{display:flex;flex-direction:column;gap:6px;overflow:auto;max-height:50vh}
.nit{display:flex;gap:10px;padding:10px 12px;border-radius:calc(var(--r) - 2px);background:var(--faint);animation:up .4s var(--ease) both}
.nit svg{font-size:16px;margin-top:1px}.nit small{display:block;color:var(--dim);font:400 11px var(--mono);margin-top:2px}
.cgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;margin-top:8px}
.cgrid span{height:30px;display:grid;place-items:center;border-radius:50%;font-size:12px;font-variant-numeric:tabular-nums;transition:background .2s}
.cgrid span.h{color:var(--dim);font:400 10px var(--mono);height:20px}.cgrid span.o{opacity:.28}.cgrid span:not(.h):hover{background:var(--hover)}.cgrid span.td{background:var(--fg);color:var(--bg);font-weight:600}
[data-theme=minimal] .cgrid span{border-radius:0}

/* dock */
#dock{position:fixed;left:50%;bottom:12px;z-index:450;display:flex;gap:2px;padding:6px 8px;align-items:flex-end;border-radius:20px;transform:translate(-50%,120px);transition:transform .9s .4s var(--ease)}
#desk.on #dock{transform:translate(-50%,0)}
[data-theme=minimal] #dock{border-radius:0}
.dk{position:relative;width:46px;height:46px;border-radius:calc(var(--r) - 2px);display:grid;place-items:center;font-size:22px;transform-origin:50% 100%;transition:transform .2s cubic-bezier(.2,.8,.2,1),background .25s}
.dk:hover{background:var(--hover)}.dk:active{filter:brightness(.8)}.dk svg{stroke-width:1.5}
.dk::after{content:attr(data-l);position:absolute;bottom:calc(100% + 12px);left:50%;transform:translate(-50%,6px);padding:4px 9px;border-radius:calc(var(--r) - 6px);white-space:nowrap;font:500 11px var(--mono);background:var(--fg);color:var(--bg);opacity:0;pointer-events:none;transition:opacity .2s,transform .3s var(--spring)}
.dk:hover::after{opacity:1;transform:translate(-50%,0)}
.dk i.pip{position:absolute;bottom:2px;left:50%;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:var(--fg);transform:scale(0);transition:transform .3s var(--spring)}.dk.run i.pip{transform:scale(1)}
.dsep{width:1px;height:26px;align-self:center;background:var(--line);margin:0 5px}

/* desktop: ascii clock, icons, widgets */
#clock{position:absolute;left:50%;top:15vh;transform:translateX(-50%);text-align:center;pointer-events:none;opacity:0;transition:opacity 1.2s .5s var(--ease)}
#desk.on #clock{opacity:1}
#clock .line{display:flex;align-items:flex-end;justify-content:center;gap:1.4em}
#clock pre{font:600 clamp(9px,1.7vw,21px)/.9 var(--mono);letter-spacing:0;text-align:left;text-shadow:0 0 24px color-mix(in srgb,var(--fg) 30%,transparent)}
#ckS{opacity:.45}
#ckD{margin-top:2.2vh;font:400 12px var(--mono);color:var(--dim);letter-spacing:.02em}
#icons{position:absolute;left:14px;top:46px;bottom:96px;display:grid;grid-auto-flow:column;grid-template-rows:repeat(auto-fill,94px);grid-auto-columns:92px;align-content:start;gap:2px;transition:opacity .4s}
#icons.off{opacity:0;pointer-events:none}
.fi{display:flex;flex-direction:column;align-items:center;gap:5px;padding:7px 4px;border-radius:calc(var(--r) - 4px);text-align:center;transition:background .15s}
.fi:hover{background:var(--faint)}.fi.sel{background:var(--hover);box-shadow:inset 0 0 0 1px var(--line)}
.fi .th{width:46px;height:46px;display:grid;place-items:center;font-size:32px;border-radius:8px;overflow:hidden}
.fi .th img{width:100%;height:100%;object-fit:cover}.fi .th svg{stroke-width:1.2}
.fi .nm{font-size:12px;line-height:1.2;max-width:84px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
#icons .fi{text-shadow:0 1px 6px rgba(0,0,0,.5)}[data-theme=light] #icons .fi,[data-theme=minimal] #icons .fi{text-shadow:none}
.fi .sz,.fi .md{display:none}
#sel{position:fixed;z-index:20;border:1px solid var(--fg);background:var(--faint);pointer-events:none;border-radius:4px;animation:fi .15s both}
#widgets{position:absolute;inset:0;pointer-events:none;z-index:10}
.widget{position:absolute;pointer-events:auto;padding:14px;animation:wi .6s var(--spring) both;transition:opacity .3s,transform .3s}
.widget.bye{opacity:0;transform:scale(.9)}
@keyframes wi{from{opacity:0;transform:scale(.9) translateY(10px)}}
.widget.drag{transition:none;box-shadow:var(--shadow),0 0 0 1px var(--line)}
.wh{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font:500 11px var(--mono);color:var(--dim)}
.wh button{opacity:0;transition:opacity .2s}.widget:hover .wh button{opacity:.7}.wh button:hover{opacity:1!important}
.big{font:300 40px/1 var(--font);letter-spacing:-.05em;font-variant-numeric:tabular-nums}
.widget textarea{width:100%;height:120px;resize:none;background:none;border:0;outline:0;line-height:1.5;font-size:13px}
.todo input[type=text]{width:100%;background:var(--faint);border:1px solid var(--line);border-radius:calc(var(--r) - 6px);padding:6px 9px;outline:0;margin-bottom:6px}
.todo .it{display:flex;align-items:center;gap:9px;padding:5px 2px;animation:up .3s var(--ease) both}
.todo .ck{width:15px;height:15px;border-radius:50%;border:1.3px solid var(--dim);display:grid;place-items:center;flex:none;transition:background .2s}
[data-theme=minimal] .todo .ck{border-radius:0}
.todo .it.done .ck{background:var(--fg);color:var(--bg)}.todo .it.done span{opacity:.4;text-decoration:line-through}.todo .ck svg{font-size:10px;stroke-width:3;opacity:0}.todo .done .ck svg{opacity:1}
.todo .it span{flex:1}.todo .it button{opacity:0;transition:opacity .2s}.todo .it:hover button{opacity:.6}

/* windows */
.win{position:fixed;z-index:100;display:flex;flex-direction:column;overflow:hidden;min-width:300px;opacity:0;transform:scale(.94) translateY(16px);transition:opacity .3s var(--ease),transform .5s var(--spring),box-shadow .3s}
.win.in{opacity:1;transform:none}
.win.out{opacity:0;transform:scale(.92) translateY(24px);pointer-events:none;transition-duration:.22s}
.win.min{opacity:0;transform:translateY(46vh) scale(.5);pointer-events:none;transition:opacity .35s,transform .5s var(--ease)}
.win.drag{transition:none}.win.mv{transition:left .45s var(--ease),top .45s var(--ease),width .45s var(--ease),height .45s var(--ease),opacity .3s,transform .5s var(--spring)}
.win:not(.focus){box-shadow:0 0 0 .5px rgba(0,0,0,.4),0 10px 30px -10px rgba(0,0,0,.3)}.win:not(.focus) .tb .t{opacity:.5}
.tb{height:38px;flex:none;display:flex;align-items:center;gap:7px;padding:0 13px;border-bottom:1px solid var(--line);touch-action:none}
.tb .t{flex:1;text-align:center;font:500 11.5px var(--mono);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .3s}
.tl{display:flex;gap:7px;width:52px}.tl b{width:12px;height:12px;border-radius:50%;border:1.3px solid var(--dim);display:grid;place-items:center;font-size:8px;color:transparent;transition:background .2s,color .2s,transform .3s var(--spring)}
[data-theme=minimal] .tl b{border-radius:0}.tl:hover b{color:var(--bg);background:var(--fg);border-color:var(--fg)}.tl b:hover{transform:scale(1.2)}.tl svg{stroke-width:3}
.wb{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.rz{position:absolute;z-index:5}.rz.r{right:-3px;top:38px;bottom:8px;width:8px;cursor:ew-resize}.rz.b{bottom:-3px;left:8px;right:8px;height:8px}.rz.c{right:-3px;bottom:-3px;width:16px;height:16px}

/* dialogs / login / spotlight / ctx / toasts */
#ctx{position:fixed;z-index:9000;min-width:220px;padding:5px;border-radius:calc(var(--r) - 2px);opacity:0;transform:scale(.93);pointer-events:none;transform-origin:var(--ox,0) var(--oy,0);transition:opacity .16s var(--ease),transform .3s var(--spring)}
#ctx.show{opacity:1;transform:none;pointer-events:auto}
.mi{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:calc(var(--r) - 8px);font-size:12.5px;opacity:0;transform:translateX(-5px)}
#ctx.show .mi{animation:mi .3s var(--ease) forwards;animation-delay:calc(var(--i)*18ms)}@keyframes mi{to{opacity:1;transform:none}}
.mi:hover{background:var(--fg);color:var(--bg)}.mi svg{font-size:14px;opacity:.75}.mi .k{margin-left:auto;padding-left:16px;opacity:.45;font:400 10.5px var(--mono)}
.mi.dis{opacity:.3!important;pointer-events:none}.sep{height:1px;background:var(--line);margin:5px 8px}.hd{padding:6px 10px 3px;font:400 11px var(--mono);color:var(--dim)}
#toasts{position:fixed;top:44px;right:8px;z-index:700;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none}
.toast{padding:10px 14px 10px 10px;display:flex;gap:10px;align-items:center;max-width:310px;font-weight:450;animation:ti .6s var(--spring) both}
.toast.bye{animation:to .4s var(--ease) forwards}
.toast svg{width:28px;height:28px;padding:7px;border-radius:50%;background:var(--hover)}
@keyframes ti{from{opacity:0;transform:translateX(40px) scale(.9)}}@keyframes to{to{opacity:0;transform:translateX(40px)}}
.dlg{position:fixed;inset:0;z-index:9400;display:grid;place-items:center;background:rgba(0,0,0,0);transition:background .3s}.dlg.in{background:rgba(0,0,0,.35)}
.dbox{width:min(380px,90vw);padding:22px;display:flex;flex-direction:column;gap:12px;opacity:0;transform:scale(.92) translateY(10px);transition:opacity .25s,transform .45s var(--spring)}
.dlg.in .dbox{opacity:1;transform:none}.dbox h3{font-size:16px;font-weight:600;letter-spacing:-.02em}.dbox p{color:var(--dim);line-height:1.5}
.dbox label{display:flex;flex-direction:column;gap:5px;font:400 11.5px var(--mono);color:var(--dim)}
.dbox input,.fld{background:var(--faint);border:1px solid var(--line);border-radius:calc(var(--r) - 6px);padding:8px 11px;outline:0;font:400 13px var(--font);color:var(--fg);transition:border-color .2s,background .2s}
.dbox input:focus,.fld:focus{border-color:var(--fg);background:var(--hover)}
.drow{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
#login{position:fixed;inset:0;z-index:9800;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#fff;background:rgba(0,0,0,.4);backdrop-filter:blur(40px) brightness(.7);-webkit-backdrop-filter:blur(40px) brightness(.7);transition:opacity .7s var(--ease),transform .9s var(--ease),filter .8s}
#login.off{opacity:0;transform:scale(1.06);filter:blur(14px);pointer-events:none}
[data-theme=minimal] #login{background:var(--bg);color:var(--fg);backdrop-filter:none}
#lt{position:absolute;top:9vh;font:300 54px/1 var(--font);letter-spacing:-.05em}#ld{position:absolute;top:calc(9vh + 64px);font:400 12px var(--mono);opacity:.6}
.lbox{display:flex;flex-direction:column;align-items:center;gap:12px;width:min(320px,88vw);animation:up .6s var(--ease) both}
.av{width:76px;height:76px;border-radius:50%;border:1px solid currentColor;display:grid;place-items:center;font:300 32px var(--font);transition:transform .4s var(--spring),background .3s,color .3s}
[data-theme=minimal] .av{border-radius:0}.av.btn2{cursor:pointer}.av.btn2:hover{transform:scale(1.08);background:#fff;color:#000}
.lbox h2{font-weight:500;font-size:20px;letter-spacing:-.03em}.lbox small{opacity:.6;font:400 11.5px var(--mono)}
.lbox input{width:100%;text-align:center;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.25);border-radius:calc(var(--r) - 4px);padding:10px;outline:0;color:inherit;transition:border-color .2s,background .2s}
[data-theme=minimal] .lbox input{background:none;border-color:var(--fg)}
.lbox input:focus{border-color:currentColor;background:rgba(255,255,255,.16)}.lbox input.err{animation:shake .4s}
.lbox .btn{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.25);color:inherit}.lbox .btn.pri{background:#fff;color:#000}
[data-theme=minimal] .lbox .btn.pri{background:var(--fg);color:var(--bg)}
.ulist{display:flex;gap:22px;flex-wrap:wrap;justify-content:center}.ulist>div{display:flex;flex-direction:column;align-items:center;gap:8px;font-size:13px}
.lnk{opacity:.6;font:400 12px var(--mono);transition:opacity .2s}.lnk:hover{opacity:1}
#off{position:fixed;inset:0;z-index:9900;background:#000;color:#fff;display:grid;place-items:center;opacity:0;pointer-events:none;transition:opacity .8s var(--ease)}#off.on{opacity:1;pointer-events:auto}
#off svg{font-size:40px;opacity:.5;transition:opacity .3s,transform .4s var(--spring)}#off svg:hover{opacity:1;transform:scale(1.15)}
#sp{position:fixed;inset:0;z-index:8000;display:flex;justify-content:center;padding-top:16vh;opacity:0;pointer-events:none;background:rgba(0,0,0,0);transition:opacity .25s,background .4s}
#sp.show{opacity:1;pointer-events:auto;background:rgba(0,0,0,.28)}
#sp .box{width:min(580px,92vw);height:fit-content;max-height:60vh;display:flex;flex-direction:column;overflow:hidden;border-radius:calc(var(--r) + 6px);transform:translateY(-14px) scale(.96);transition:transform .5s var(--spring)}#sp.show .box{transform:none}
#sp .in{display:flex;align-items:center;gap:12px;padding:15px 18px;border-bottom:1px solid var(--line)}#sp .in svg{font-size:18px;opacity:.6}
#sp input{flex:1;background:none;border:0;outline:0;font-size:16px;letter-spacing:-.02em}
#sp .res{overflow:auto;padding:6px}.sp-item{display:flex;align-items:center;gap:12px;padding:9px 12px;border-radius:calc(var(--r) - 4px)}.sp-item.sel{background:var(--fg);color:var(--bg)}
.sp-item .k{margin-left:auto;opacity:.5;font:400 11px var(--mono)}.sp-item svg{font-size:16px}

/* files */
.files{flex-direction:row}
.side{width:150px;flex:none;padding:10px 8px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:1px;overflow:auto}
.side .pl{display:flex;align-items:center;gap:9px;padding:6px 9px;border-radius:calc(var(--r) - 7px);font-size:12.5px;transition:background .2s}
.side .pl:hover{background:var(--hover)}.side .pl.on{background:var(--fg);color:var(--bg)}.side .pl svg{font-size:15px}.side .gap{flex:1}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.tool{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.tool .ib{width:28px;height:28px;display:grid;place-items:center;border-radius:calc(var(--r) - 7px);font-size:15px;transition:background .2s,transform .25s var(--spring)}
.tool .ib:hover{background:var(--hover)}.tool .ib:active{transform:scale(.9)}.tool .ib[disabled]{opacity:.25;pointer-events:none}.tool .ib.on{background:var(--hover)}
.crumbs{flex:1;min-width:80px;display:flex;align-items:center;gap:2px;font:400 12px var(--mono);color:var(--dim);overflow:hidden;white-space:nowrap}
.crumbs span{padding:2px 5px;border-radius:5px}.crumbs span:hover{background:var(--hover);color:var(--fg)}.crumbs span:last-child{color:var(--fg)}
.tool input{width:130px;background:var(--faint);border:1px solid var(--line);border-radius:calc(var(--r) - 7px);padding:4px 9px;outline:0;font-size:12px;transition:width .3s var(--ease),border-color .2s}.tool input:focus{width:180px;border-color:var(--fg)}
.flist{flex:1;overflow:auto;padding:10px;outline:0;display:grid;grid-template-columns:repeat(auto-fill,96px);grid-auto-rows:96px;gap:4px;align-content:start;position:relative}
.flist.rows{grid-template-columns:1fr;grid-auto-rows:34px;gap:0}
.flist.rows .fi{flex-direction:row;gap:12px;padding:0 10px;text-align:left;border-radius:calc(var(--r) - 7px)}
.flist.rows .th{width:22px;height:22px;font-size:18px}.flist.rows .nm{flex:1;max-width:none;-webkit-line-clamp:1}
.flist.rows .sz,.flist.rows .md{display:block;width:90px;text-align:right;color:var(--dim);font:400 11px var(--mono)}.flist.rows .md{width:130px}
.flist.anim .fi{animation:up .3s var(--ease) both}
.stat{padding:6px 12px;border-top:1px solid var(--line);font:400 11px var(--mono);color:var(--dim);display:flex;justify-content:space-between}
.dropz{position:absolute;inset:6px;border:1.5px dashed var(--fg);border-radius:calc(var(--r) - 2px);display:grid;place-items:center;font:500 12px var(--mono);background:var(--faint);opacity:0;pointer-events:none;transition:opacity .2s;z-index:6}.dropz.on{opacity:1}

/* editor / viewer */
.etb{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--line)}.etb .en{font-weight:550}.etb .es{flex:1;color:var(--dim);font:400 11px var(--mono)}
.wb textarea.ed{flex:1;resize:none;background:none;border:0;outline:0;padding:14px 16px;font:400 13px/1.65 var(--mono);tab-size:2;white-space:pre-wrap}
.estat{padding:6px 12px;border-top:1px solid var(--line);font:400 11px var(--mono);color:var(--dim)}
.vw{flex:1;min-height:0;display:grid;place-items:center;padding:14px;position:relative}.vw img,.vw video,.vw iframe{max-width:100%;max-height:100%;border-radius:calc(var(--r) - 6px);animation:fi .4s both}.vw iframe{width:100%;height:100%;border:0;background:#fff}
.vw audio{width:min(420px,90%)}.vnav{position:absolute;top:50%;width:34px;height:34px;margin-top:-17px;display:grid;place-items:center;border-radius:50%;background:var(--glass);border:1px solid var(--edge);opacity:.0;transition:opacity .2s,transform .3s var(--spring)}.vw:hover .vnav{opacity:1}.vnav:hover{transform:scale(1.1)}.vnav.l{left:10px}.vnav.r{right:10px}

/* settings */
.set{flex-direction:row}
.set .side{width:164px}.sc{flex:1;overflow:auto;padding:22px 26px;display:flex;flex-direction:column;gap:18px;animation:up .4s var(--ease)}
.sc h2{font-size:20px;font-weight:550;letter-spacing:-.035em}.sc h4{font:400 11.5px var(--mono);color:var(--dim);margin-bottom:-8px}
.card{display:flex;flex-direction:column;border-radius:var(--r);background:var(--faint);border:1px solid var(--line)}
.srow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 14px}.srow+.srow{border-top:1px solid var(--line)}
.srow b{font-weight:500;display:block}.srow small{color:var(--dim);font-size:12px}
.sw{width:38px;height:22px;border-radius:22px;background:var(--line);position:relative;flex:none;transition:background .3s}.sw i{position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:var(--fg);transition:transform .4s var(--spring),background .3s}
.sw.on{background:var(--fg)}.sw.on i{transform:translateX(16px);background:var(--bg)}[data-theme=minimal] .sw,[data-theme=minimal] .sw i{border-radius:0}
.seg{display:flex;padding:3px;gap:2px;border-radius:calc(var(--r) - 4px);background:var(--faint);border:1px solid var(--line);flex-wrap:wrap}
.seg button{padding:5px 12px;border-radius:calc(var(--r) - 8px);font-size:12.5px;transition:background .25s,color .25s}.seg button:hover{background:var(--hover)}.seg button.on{background:var(--fg);color:var(--bg)}
.wpg{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:12px}
.wpg button{aspect-ratio:16/10;border-radius:calc(var(--r) - 6px);border:1px solid var(--line);background:var(--faint);display:flex;align-items:flex-end;padding:7px 9px;font:400 11px var(--mono);text-align:left;transition:transform .3s var(--spring),border-color .2s,background .2s}
.wpg button:hover{transform:translateY(-2px);background:var(--hover)}.wpg button.on{border-color:var(--fg);box-shadow:inset 0 0 0 1px var(--fg)}
.kv{display:flex;justify-content:space-between;padding:8px 14px;gap:20px}.kv+.kv{border-top:1px solid var(--line)}.kv span:first-child{color:var(--dim)}.kv span:last-child{font:400 12px var(--mono);text-align:right;user-select:text}
kbd{font:400 10.5px var(--mono);padding:2px 6px;border-radius:5px;border:1px solid var(--line);background:var(--faint)}

/* cursor */
#cur{position:fixed;left:0;top:0;z-index:10000;pointer-events:none;will-change:transform;width:0;height:0}
#cur .a{position:absolute;left:-3px;top:-2px;width:26px;height:26px;transform-origin:5px 4px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));transition:transform .3s var(--spring),opacity .2s}
#cur svg{width:100%;height:100%}
#cur .arrow path{fill:#fff;stroke:#000;stroke-width:1.6;stroke-linejoin:round}
#cur .beam{opacity:0;left:-10px;top:-12px;transform-origin:center}
#cur .beam path{fill:none;stroke:#000;stroke-width:4;stroke-linecap:round}#cur .beam path.w{stroke:#fff;stroke-width:2}
#cur.hover .arrow{transform:scale(1.1)}#cur.down .arrow{transform:scale(.88)}#cur.text .arrow{opacity:0;transform:scale(.5)}#cur.text .beam{opacity:1}
body.nocur #cur{opacity:0}@media (pointer:coarse){#cur{display:none}}
#veil{position:fixed;inset:0;background:#000;pointer-events:none;z-index:9500;opacity:0;transition:opacity .3s}
@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;transition-duration:.01ms!important}}
@media (max-width:760px){.side{width:56px}.side .pl span{display:none}#icons{grid-auto-columns:80px}}
#appname{pointer-events:none}.win{outline:0}.mono{font-family:var(--mono)}
`;

const BODY = `<div id="boot"><svg class="ic" viewBox="0 0 32 32"><circle cx="16" cy="16" r="11"/><circle cx="16" cy="16" r="4"/></svg><div class="name">galliumOS</div><div class="bar"><i></i></div></div>
<canvas id="wall"></canvas><video id="wv" muted loop playsinline></video><img id="wi" alt=""><div id="vig"></div><div id="dimv"></div>
<div id="desk">
  <div id="icons"></div><div id="widgets"></div>
  <div id="clock"><div class="line"><pre id="ckA"></pre><pre id="ckS"></pre></div><div id="ckD"></div></div>
  <div id="bar" class="glass">
    <div class="grp"><div class="chip brand" id="logo"></div><div class="chip" id="appname">desktop</div></div>
    <div class="grp">
      <div class="chip" id="qsbtn" data-p="qs"><span id="netic"></span><span id="bpct"></span><div class="batt" id="batt"><i></i></div></div>
      <div class="chip" id="ncbtn" data-p="nc"><span id="bellic"></span><i class="badge" id="badge"></i></div>
      <div class="chip" id="barclock" data-p="cal"></div>
    </div>
  </div>
  <div id="qs" class="panel glass"></div>
  <div id="nc" class="panel glass"><div class="row"><b style="font-size:15px;letter-spacing:-.02em">notifications</b><div class="mini" id="ncClr">clear</div></div><div class="nlist" id="nlist"></div></div>
  <div id="cal" class="panel glass"></div>
  <div id="dock" class="glass"></div>
  <div id="toasts"></div>
</div>
<div id="ctx" class="glass"></div>
<div id="veil"></div>
<div id="cur"><div class="a arrow"><svg viewBox="0 0 26 26"><path d="M5.2 3.6c0-.9 1-1.4 1.7-.8l13.4 10.7c.8.6.4 1.9-.6 2l-5.4.6 3 6.1c.3.6 0 1.3-.5 1.5l-1.7.8c-.6.3-1.2 0-1.5-.5l-3-6.1-3.8 3.9c-.7.7-1.8.2-1.8-.7z"/></svg></div>
<div class="a beam"><svg viewBox="0 0 20 24"><path d="M6 4h8M6 20h8M10 4v16"/><path class="w" d="M6 4h8M6 20h8M10 4v16"/></svg></div></div>
<div id="login" class="off"><div id="lt"></div><div id="ld"></div><div id="lbody"></div></div>
<div id="off"><svg class="ic" viewBox="0 0 24 24" id="pwr"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/></svg></div>
<div id="sp"><div class="box glass"><div class="in"><svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input id="spi" type="text" placeholder="search apps, files and commands" autocomplete="off" spellcheck="false"></div><div class="res" id="spr"></div></div></div>
`;

function client(){
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const root=document.documentElement;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const p2=n=>String(n).padStart(2,'0');
const P={
  folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file:'<path d="M6 3h8l5 5v13H6zM14 3v5h5"/>',
  text:'<path d="M6 3h8l5 5v13H6zM14 3v5h5M9 13h7M9 17h7"/>',
  image:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M21 16l-5-5-9 9"/>',
  video:'<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
  audio:'<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  pdf:'<path d="M6 3h8l5 5v13H6zM14 3v5h5M9 15h2a1.5 1.5 0 0 0 0-3H9v6"/>',
  trash:'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  upload:'<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>', download:'<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', search:'<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', users:'<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a7 7 0 0 1 4 6"/>',
  grid:'<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
  list:'<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  left:'<path d="M15 5l-7 7 7 7"/>', right:'<path d="M9 5l7 7-7 7"/>', up:'<path d="M5 15l7-7 7 7"/>',
  home:'<path d="M4 11l8-7 8 7v9H4zM10 20v-6h4v6"/>', pencil:'<path d="M4 20l1-5L16 4l4 4L9 19zM14 6l4 4"/>',
  copy:'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  cut:'<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
  paste:'<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V3h6v2"/>',
  restore:'<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>', check:'<path d="M5 12l5 5 9-10"/>',
  power:'<path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/>', lock:'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  bell:'<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4"/>',
  wifi:'<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10.5 10.5 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0"/><circle cx="12" cy="19.5" r=".6"/>',
  wifioff:'<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10.5 10.5 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0M3 3l18 18"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', full:'<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  x:'<path d="M6 6l12 12M18 6L6 18"/>', min:'<path d="M5 12h14"/>', sq:'<rect x="5" y="5" width="14" height="14" rx="1"/>',
  cursor:'<path d="M5 3l14 7-6 2-2 6z"/>', battery:'<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/>', bolt:'<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
  widgets:'<rect x="4" y="4" width="7" height="9" rx="1"/><rect x="13" y="4" width="7" height="5" rx="1"/><rect x="13" y="11" width="7" height="9" rx="1"/><rect x="4" y="15" width="7" height="5" rx="1"/>',
  palette:'<path d="M12 3a9 9 0 1 0 0 18c1 0 2-.7 1.5-2s.3-2.5 1.7-2.5H17a4 4 0 0 0 4-4 9 9 0 0 0-9-9z"/>',
  hdd:'<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M5 14l2-9h10l2 9M17 17h.01"/>', logout:'<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
  desktop:'<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', refresh:'<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  logo:'<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/>', key:'<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>'
};
const ic=(n,c='')=>`<svg class="ic ${c}" viewBox="0 0 24 24">${P[n]||''}</svg>`;
const bus=new EventTarget(), emit=n=>bus.dispatchEvent(new Event(n));
function watch(el,n,f){ const g=()=>{ if(!el.isConnected){ bus.removeEventListener(n,g); return; } f(); }; bus.addEventListener(n,g); }
const mk=(cls,html='',tag='div')=>{ const e=document.createElement(tag); e.className=cls; e.innerHTML=html; return e; };
const fmtSize=b=>b<1024?b+' b':b<1048576?(b/1024).toFixed(1)+' kb':b<1073741824?(b/1048576).toFixed(1)+' mb':(b/1073741824).toFixed(2)+' gb';
const fmtDate=t=>{ const d=new Date(t), n=new Date(); return d.toDateString()===n.toDateString()?d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):d.toLocaleDateString([], {month:'short',day:'numeric',year:d.getFullYear()===n.getFullYear()?undefined:'numeric'}); };
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);

/* ================= state ================= */
let U=null, S=null, BAT=null, locked=false;
const FS=new Map(), URLS=new Map(), NOTES=[];
let dbh=null;
const DEF={theme:'dark',last:'dark',wp:'matrix',cursor:true,h24:false,secs:true,icons:true,dim:0,bright:100,cwp:null,widgets:{calendar:{on:true},battery:{on:true}},notes:'',todos:[]};
const saveS=()=>{ if(U) localStorage.setItem('g.s.'+U.name,JSON.stringify(S)); };
const loadS=n=>Object.assign(JSON.parse(JSON.stringify(DEF)),JSON.parse(localStorage.getItem('g.s.'+n)||'{}'));

/* ================= indexeddb file store ================= */
const idb=()=>new Promise(res=>{ try{ const q=indexedDB.open('galliumos',1);
  q.onupgradeneeded=()=>{ q.result.createObjectStore('fs',{keyPath:'id'}).createIndex('user','user'); };
  q.onsuccess=()=>{ dbh=q.result; res(); }; q.onerror=q.onblocked=()=>res(); }catch(e){ res(); } });
const dbw=fn=>new Promise(res=>{ if(!dbh) return res(true); try{ const t=dbh.transaction('fs','readwrite'); fn(t.objectStore('fs')); t.oncomplete=()=>res(true); t.onerror=t.onabort=()=>res(false); }catch(e){ res(false); } });
const dbPut=r=>dbw(s=>s.put(r)), dbDel=id=>dbw(s=>s.delete(id));
const dbUser=u=>new Promise(res=>{ if(!dbh) return res([]); const q=dbh.transaction('fs').objectStore('fs').index('user').getAll(u); q.onsuccess=()=>res(q.result); q.onerror=()=>res([]); });

/* ================= filesystem ================= */
const EXT={image:'png jpg jpeg gif webp svg avif bmp ico',video:'mp4 webm mov mkv ogv m4v',audio:'mp3 wav ogg flac m4a aac opus',
  text:'txt md json js ts jsx tsx css html htm csv log xml yml yaml ini sh py c cpp h rs go java toml conf rtf'};
const extOf=n=>(n.split('.').pop()||'').toLowerCase();
function kindOf(r){ if(r.dir) return 'dir'; const m=r.mime||'', e=extOf(r.name);
  if(m.startsWith('image/')||EXT.image.split(' ').includes(e)) return 'image'; if(m.startsWith('video/')||EXT.video.split(' ').includes(e)) return 'video';
  if(m.startsWith('audio/')||EXT.audio.split(' ').includes(e)) return 'audio'; if(m==='application/pdf'||e==='pdf') return 'pdf';
  if(m.startsWith('text/')||m==='application/json'||EXT.text.split(' ').includes(e)) return 'text'; return 'other'; }
const kindIcon=r=>({dir:'folder',image:'image',video:'video',audio:'audio',pdf:'pdf',text:'text'}[kindOf(r)]||'file');
const urlOf=r=>{ const k=r.id+':'+r.mtime; let u=URLS.get(k); if(!u){ u=URL.createObjectURL(r.blob); URLS.set(k,u); } return u; };
const kids=(p,tr=false)=>[...FS.values()].filter(r=>r.parent===p&&!!r.trash===tr).sort((a,b)=>(b.dir-a.dir)||a.name.localeCompare(b.name,undefined,{numeric:true}));
const trashed=()=>[...FS.values()].filter(r=>r.trash).sort((a,b)=>b.mtime-a.mtime);
const rootDir=n=>[...FS.values()].find(r=>r.dir&&!r.parent&&r.name===n&&!r.trash);
const rootId=n=>rootDir(n)?.id??null;
function uniq(parent,name,skip){ const used=new Set(kids(parent).filter(r=>r.id!==skip).map(r=>r.name.toLowerCase())); if(!used.has(name.toLowerCase())) return name;
  const i=name.lastIndexOf('.'), b=i>0?name.slice(0,i):name, e=i>0?name.slice(i):''; let n=2; while(used.has((b+' '+n+e).toLowerCase())) n++; return b+' '+n+e; }
async function fsAdd({name,parent,dir=false,blob=null}){
  const r={id:uid(),user:U.name,parent,name:uniq(parent,name.trim()||'untitled'),dir,mime:blob?blob.type:'',size:blob?blob.size:0,blob,ctime:Date.now(),mtime:Date.now(),trash:false};
  if(!(await dbPut(r))){ toast('x','not enough storage space'); return null; } FS.set(r.id,r); emit('fs'); return r; }
async function fsWrite(id,blob){ const r=FS.get(id); const old={...r}; Object.assign(r,{blob,size:blob.size,mtime:Date.now(),mime:blob.type||r.mime});
  if(!(await dbPut(r))){ Object.assign(r,old); toast('x','not enough storage space'); return false; }
  for(const k of [...URLS.keys()]) if(k.startsWith(id+':')){ URL.revokeObjectURL(URLS.get(k)); URLS.delete(k); } emit('fs'); return true; }
async function fsPatch(ids,patch){ for(const id of ids){ const r=FS.get(id); if(r){ Object.assign(r,patch(r)); await dbPut(r); } } emit('fs'); }
const fsRename=(id,name)=>{ const r=FS.get(id); return fsPatch([id],()=>({name:uniq(r.parent,name.trim()||r.name,id),mtime:Date.now()})); };
const fsTrash=ids=>fsPatch(ids,r=>({trash:true,mtime:Date.now()}));
const fsRestore=ids=>fsPatch(ids,r=>{ const p=r.parent?FS.get(r.parent):null; const ok=!r.parent||(p&&!p.trash); return {trash:false,parent:ok?r.parent:null,name:uniq(ok?r.parent:null,r.name,r.id)}; });
const desc=id=>{ const out=[]; kids(id).concat(kids(id,true)).forEach(k=>{ out.push(k.id); if(k.dir) out.push(...desc(k.id)); }); return out; };
async function fsRemove(ids){ const all=new Set(); ids.forEach(id=>{ all.add(id); if(FS.get(id)?.dir) desc(id).forEach(d=>all.add(d)); });
  for(const id of all){ await dbDel(id); FS.delete(id); for(const k of [...URLS.keys()]) if(k.startsWith(id+':')){ URL.revokeObjectURL(URLS.get(k)); URLS.delete(k); } } emit('fs'); }
async function fsCopy(ids,dest){ const cp=async(id,parent)=>{ const r=FS.get(id); const n=await fsAdd({name:r.name,parent,dir:r.dir,blob:r.blob}); if(n&&r.dir) for(const k of kids(id)) await cp(k.id,n.id); }; for(const id of ids) await cp(id,dest); }
const isInside=(id,anc)=>{ let r=FS.get(id); while(r){ if(r.id===anc) return true; r=r.parent?FS.get(r.parent):null; } return false; };
const fsMove=(ids,dest)=>fsPatch(ids.filter(id=>!isInside(dest,id)),r=>({parent:dest,name:uniq(dest,r.name,r.id)}));
const fsPath=id=>{ const out=[]; let r=id?FS.get(id):null; while(r){ out.unshift(r); r=r.parent?FS.get(r.parent):null; } return out; };
const fsUsed=()=>[...FS.values()].reduce((a,r)=>a+(r.size||0),0);
const readText=r=>r.blob?r.blob.text():Promise.resolve('');
function pickFiles(accept='',multiple=true){ return new Promise(res=>{ const i=document.createElement('input'); i.type='file'; i.accept=accept; i.multiple=multiple; i.onchange=()=>res([...i.files]); i.click(); }); }
async function upload(parent,files){ let n=0; for(const f of files){ if(await fsAdd({name:f.name,parent,blob:f})) n++; } if(n) toast('upload',n===1?'added 1 file':`added ${n} files`); }
const CLIP={ids:[],cut:false};
async function paste(dest){ if(!CLIP.ids.length) return; const ids=CLIP.ids.filter(id=>FS.has(id)); if(CLIP.cut){ await fsMove(ids,dest); CLIP.ids=[]; } else await fsCopy(ids,dest); }

/* ================= accounts ================= */
const getUsers=()=>JSON.parse(localStorage.getItem('g.users')||'[]');
const setUsers=u=>localStorage.setItem('g.users',JSON.stringify(u));
async function hashPw(salt,p){ try{ const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+p)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
  catch(e){ let h=5381; for(const c of salt+p) h=((h*33)^c.charCodeAt(0))>>>0; return 'x'+h; } }
async function createUser(name,pass){ const us=getUsers(); name=name.trim();
  if(!name) return 'enter a name'; if(us.some(u=>u.name.toLowerCase()===name.toLowerCase())) return 'that name is taken';
  const salt=uid(), u={name,salt,hash:pass?await hashPw(salt,pass):null,created:Date.now()}; us.push(u); setUsers(us); return u; }
async function checkPw(u,p){ return !u.hash||(await hashPw(u.salt,p))===u.hash; }
async function deleteUser(name){ const recs=await dbUser(name); for(const r of recs) await dbDel(r.id); localStorage.removeItem('g.s.'+name); setUsers(getUsers().filter(u=>u.name!==name)); }

/* ================= wallpapers ================= */
const cv=$('#wall'), cx=cv.getContext('2d'); let W=0,H=0,dpr=1, mx=.5,my=.5,smx=.5,smy=.5, cwpOn=false;
const light=()=>root.dataset.theme==='light';
const ink=()=>light()?'20,20,20':'236,236,236', bgc=()=>light()?'#e9e9e9':'#050505', bga=a=>light()?`rgba(233,233,233,${a})`:`rgba(5,5,5,${a})`;
const clear=()=>{ cx.fillStyle=bgc(); cx.fillRect(0,0,W,H); };
const WP={
  matrix:{n:'matrix rain',init(){ this.fs=16*dpr; this.c=Math.ceil(W/this.fs); this.y=Array.from({length:this.c},()=>-Math.random()*60); this.v=Array.from({length:this.c},()=>.5+Math.random()); this.a=0; clear(); },
    draw(t,dt){ this.a+=dt; if(this.a<42) return; this.a=0; cx.fillStyle=bga(.1); cx.fillRect(0,0,W,H); cx.font=`${this.fs}px "Spline Sans Mono",monospace`;
      for(let i=0;i<this.c;i++){ const y=Math.floor(this.y[i])*this.fs; cx.fillStyle=`rgba(${ink()},.95)`; cx.fillText(String.fromCharCode(0x30A0+Math.random()*96),i*this.fs,y);
        if(y>H&&Math.random()>.975) this.y[i]=0; this.y[i]+=this.v[i]; } }},
  snow:{n:'snowfall',init(){ this.f=Array.from({length:Math.round(W*H/(7000*dpr*dpr))},()=>({x:Math.random()*W,y:Math.random()*H,r:(.6+Math.random()*2.2)*dpr,v:.4+Math.random()*1.1,p:Math.random()*6})); },
    draw(t,dt){ clear(); const wind=(smx-.5)*2.4; cx.fillStyle=`rgba(${ink()},.8)`; for(const f of this.f){ f.y+=f.v*dt*.05*dpr*(f.r/dpr*.6+.5); f.x+=(Math.sin(t*.0008+f.p)*.35+wind)*dt*.05*dpr;
      if(f.y>H+5){ f.y=-5; f.x=Math.random()*W; } if(f.x>W+5) f.x=-5; if(f.x<-5) f.x=W+5; cx.globalAlpha=Math.min(1,.25+f.r/(3*dpr)); cx.beginPath(); cx.arc(f.x,f.y,f.r,0,6.283); cx.fill(); } cx.globalAlpha=1; }},
  rain:{n:'rainfall',init(){ this.d=Array.from({length:Math.round(W/(9*dpr))},()=>({x:Math.random()*W,y:Math.random()*H,l:(10+Math.random()*22)*dpr,v:.8+Math.random()*.9})); clear(); },
    draw(t,dt){ cx.fillStyle=bga(.28); cx.fillRect(0,0,W,H); const sl=(smx-.5)*.5; cx.lineWidth=dpr; cx.strokeStyle=`rgba(${ink()},.45)`; cx.beginPath();
      for(const d of this.d){ cx.moveTo(d.x,d.y); cx.lineTo(d.x+sl*d.l,d.y+d.l); d.y+=d.v*dt*.9*dpr; d.x+=sl*d.v*dt*.9*dpr; if(d.y>H){ d.y=-d.l; d.x=Math.random()*W; } } cx.stroke(); }},
  stars:{n:'starfield',init(){ this.s=Array.from({length:Math.round(W*H/(5000*dpr*dpr))},()=>({x:(Math.random()-.5)*2,y:(Math.random()-.5)*2,z:Math.random()})); clear(); },
    draw(t,dt){ cx.fillStyle=bga(.35); cx.fillRect(0,0,W,H); const cx0=W*(.5+(smx-.5)*.3), cy0=H*(.5+(smy-.5)*.3), sc=Math.max(W,H)*.6;
      for(const s of this.s){ const pz=s.z; s.z-=dt*.00022; if(s.z<=.01){ s.x=(Math.random()-.5)*2; s.y=(Math.random()-.5)*2; s.z=1; continue; }
        const x=cx0+s.x/s.z*sc*.2, y=cy0+s.y/s.z*sc*.2, px=cx0+s.x/pz*sc*.2, py=cy0+s.y/pz*sc*.2; cx.strokeStyle=`rgba(${ink()},${(1-s.z).toFixed(2)})`; cx.lineWidth=(1.4-s.z)*dpr; cx.beginPath(); cx.moveTo(px,py); cx.lineTo(x,y); cx.stroke(); } }},
  dots:{n:'dot grid',init(){}, draw(t){ clear(); const st=32*dpr, R=170*dpr, X=smx*W, Y=smy*H;
      for(let y=st/2;y<H;y+=st) for(let x=st/2;x<W;x+=st){ const dx=x-X, dy=y-Y, n=Math.exp(-(dx*dx+dy*dy)/(2*R*R)), w=Math.sin(x*.0035/dpr+t*.0005)+Math.cos(y*.004/dpr-t*.0004);
        cx.fillStyle=`rgba(${ink()},${(.11+.035*w+n*.75).toFixed(3)})`; cx.beginPath(); cx.arc(x,y,(.8+n*2.4)*dpr,0,6.283); cx.fill(); } }},
  contour:{n:'contour',init(){}, draw(t){ clear(); const lines=46, gap=H/lines, X=smx*W, Y=smy*H; cx.lineWidth=dpr;
      for(let i=0;i<=lines;i++){ const y0=i*gap; cx.beginPath(); for(let x=0;x<=W;x+=16*dpr){ const dx=x-X, dy=y0-Y, n=Math.exp(-(dx*dx+dy*dy)/(2*(260*dpr)**2)); const y=y0+Math.sin(x*.0022/dpr+i*.22+t*.0004)*14*dpr-n*46*dpr; x?cx.lineTo(x,y):cx.moveTo(x,y); }
        cx.strokeStyle=`rgba(${ink()},${(.08+.05*Math.sin(i*.4+t*.0003)).toFixed(3)})`; cx.stroke(); } }},
  aura:{n:'aura',init(){ this.b=Array.from({length:5},(_,i)=>({s:.0002+Math.random()*.0003,r:.3+Math.random()*.25,o:i})); },
    draw(t){ clear(); cx.globalCompositeOperation=light()?'multiply':'lighter'; this.b.forEach((b,i)=>{ const x=W*(.5+.38*Math.cos(t*b.s+b.o*1.7))+(smx-.5)*W*.12*(i%3-1), y=H*(.5+.34*Math.sin(t*b.s*1.3+b.o))+(smy-.5)*H*.12*(i%3-1), r=Math.max(W,H)*b.r;
      const g=cx.createRadialGradient(x,y,0,x,y,r), v=light()?50:255, a=light()?.2:.09; g.addColorStop(0,`rgba(${v},${v},${v},${a})`); g.addColorStop(1,`rgba(${v},${v},${v},0)`); cx.fillStyle=g; cx.fillRect(0,0,W,H); }); cx.globalCompositeOperation='source-over'; }},
  static:{n:'static',init(){ this.o=document.createElement('canvas'); this.o.width=Math.ceil(W/4); this.o.height=Math.ceil(H/4); this.x=this.o.getContext('2d'); this.i=this.x.createImageData(this.o.width,this.o.height); this.k=0; },
    draw(){ if(this.k++%3) return; const d=this.i.data, L=light(); for(let i=0;i<d.length;i+=4){ const v=Math.random()*(L?50:42); d[i]=d[i+1]=d[i+2]=L?255-v:v; d[i+3]=255; } this.x.putImageData(this.i,0,0); cx.imageSmoothingEnabled=false; cx.drawImage(this.o,0,0,W,H); }},
  none:{n:'plain',init(){}, draw(){ clear(); }}
};
const wpName=()=>(S&&WP[S.wp])?S.wp:'matrix';
function size(){ dpr=Math.min(devicePixelRatio||1,2); W=cv.width=innerWidth*dpr; H=cv.height=innerHeight*dpr; WP[wpName()].init(); }
addEventListener('resize',size);
function setWp(n){ S.wp=n; saveS(); cv.style.opacity=0; setTimeout(()=>{ WP[n].init(); cv.style.opacity=''; },320); emit('settings'); }
let lastT=0;
function frame(t){ const dt=Math.min(60,t-lastT); lastT=t; smx+=(mx-smx)*.07; smy+=(my-smy)*.07;
  if(!document.hidden&&!cwpOn&&root.dataset.theme!=='minimal') WP[wpName()].draw(t,dt); requestAnimationFrame(frame); }
function applyCustomWp(){ const wv=$('#wv'), wi=$('#wi'); wv.classList.remove('on'); wi.classList.remove('on');
  const r=S&&S.cwp&&FS.get(S.cwp); const k=r&&!r.trash&&r.blob?kindOf(r):null;
  if(k==='video'){ wv.src=urlOf(r); wv.play().catch(()=>{}); wv.classList.add('on'); } else if(k==='image'){ wi.src=urlOf(r); wi.classList.add('on'); } else { wv.pause(); if(S&&S.cwp){ S.cwp=null; saveS(); } }
  cwpOn=!!(k==='video'||k==='image'); cv.classList.toggle('hide',cwpOn); }
function setCustomWp(id){ S.cwp=id; saveS(); applyCustomWp(); emit('settings'); }

/* ================= ascii clock ================= */
const GL={'0':['01110','10001','10011','10101','11001','10001','01110'],'1':['00100','01100','00100','00100','00100','00100','01110'],'2':['01110','10001','00001','00010','00100','01000','11111'],
 '3':['11110','00001','00001','01110','00001','00001','11110'],'4':['00010','00110','01010','10010','11111','00010','00010'],'5':['11111','10000','11110','00001','00001','10001','01110'],
 '6':['00110','01000','10000','11110','10001','10001','01110'],'7':['11111','00001','00010','00100','01000','01000','01000'],'8':['01110','10001','10001','01110','10001','10001','01110'],
 '9':['01110','10001','10001','01111','00001','00010','01100'],':':['000','000','010','000','010','000','000']};
const RAMP='01#%&@$+=*<>/\\|';
const asciiRows=str=>{ const rows=['','','','','','','']; [...str].forEach((c,i)=>{ const g=GL[c]; for(let r=0;r<7;r++) rows[r]+=(i?'0':'')+g[r]; }); return rows.map(r=>r.replace(/0/g,' ').replace(/1/g,'#')); };
class Ascii{ constructor(el){ this.el=el; this.tg=null; this.res=null; this.run=false; }
  set(str,anim=true){ const rows=asciiRows(str).map(r=>r.split(''));
    if(!this.tg||this.tg[0].length!==rows[0].length){ const blank=rows.map(r=>r.map(()=>' ')); this.tg=blank; this.res=rows.map(r=>r.map(()=>0)); }
    const now=performance.now(); rows.forEach((r,y)=>r.forEach((c,x)=>{ if(c!==this.tg[y][x]) this.res[y][x]=anim?now+160+x*11+Math.random()*300:0; })); this.tg=rows;
    if(!this.run){ this.run=true; requestAnimationFrame(()=>this.loop()); } }
  loop(){ const now=performance.now(); this.draw(now); if(this.res.some(r=>r.some(v=>v>now))) requestAnimationFrame(()=>this.loop()); else this.run=false; }
  draw(now){ this.el.textContent=this.tg.map((r,y)=>r.map((c,x)=>this.res[y][x]>now?(c===' '?(Math.random()<.55?' ':RAMP[Math.random()*RAMP.length|0]):RAMP[Math.random()*RAMP.length|0]):c).join('')).join('\n'); } }
let ckA, ckS, lastHM='', lastSS='';
function h12(d){ return {h:d.getHours()%12||12, ap:d.getHours()<12?'am':'pm'}; }
function tick(){
  const d=new Date(), H24=S?S.h24:false, c=h12(d), hh=H24?p2(d.getHours()):String(c.h), hm=hh+':'+p2(d.getMinutes()), ss=':'+p2(d.getSeconds());
  const ds=d.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}).toLowerCase();
  if(hm!==lastHM){ ckA.set(hm); lastHM=hm; } if(ss!==lastSS){ ckS.set(ss); lastSS=ss; }
  $('#ckS').style.display=(S&&!S.secs)?'none':''; $('#ckD').textContent=(H24?'':c.ap+' · ')+ds;
  const t=H24?hm:`${c.h}:${p2(d.getMinutes())} ${c.ap}`; $('#lt').textContent=t; $('#ld').textContent=ds;
  $('#barclock').textContent=d.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'}).toLowerCase()+'  '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit',hour12:!H24}).toLowerCase();
}

/* ================= toasts / notifications ================= */
const ago=t=>{ const m=Math.floor((Date.now()-t)/60000); return m<1?'just now':m<60?m+'m ago':Math.floor(m/60)+'h ago'; };
function drawNotes(){ $('#nlist').innerHTML=NOTES.length?NOTES.map(n=>`<div class="nit">${ic(n.i)}<div>${esc(n.t)}<small>${ago(n.at)}</small></div></div>`).join(''):'<div class="empty">nothing new</div>'; }
function toast(icon,text){ NOTES.unshift({i:icon,t:text,at:Date.now()}); if(NOTES.length>30) NOTES.pop(); drawNotes();
  const t=mk('toast glass',ic(icon)+`<span>${esc(text)}</span>`); $('#toasts').append(t);
  setTimeout(()=>{ t.classList.add('bye'); setTimeout(()=>t.remove(),400); },3200); }

/* ================= context menu ================= */
const ctx=$('#ctx');
function showCtx(x,y,items){ let i=0; items=items.filter(Boolean);
  ctx.innerHTML=items.map((m,k)=>m==='-'?'<div class="sep"></div>':m.h?`<div class="hd">${m.h}</div>`:`<div class="mi ${m.d?'dis':''}" style="--i:${i++}" data-k="${k}">${ic(m.i||'info')}<span>${m.t}</span>${m.k?`<span class="k">${m.k}</span>`:''}</div>`).join('');
  ctx.classList.remove('show'); ctx.style.left=ctx.style.top='0px';
  const wd=ctx.offsetWidth, ht=ctx.offsetHeight, fx=x+wd>innerWidth-8, fy=y+ht>innerHeight-8;
  ctx.style.left=Math.max(8,fx?x-wd:x)+'px'; ctx.style.top=Math.max(8,fy?y-ht:y)+'px'; ctx.style.setProperty('--ox',fx?'100%':'0'); ctx.style.setProperty('--oy',fy?'100%':'0');
  void ctx.offsetWidth; ctx.classList.add('show');
  ctx.onclick=e=>{ const m=e.target.closest('.mi'); if(!m) return; const it=items[m.dataset.k]; closeCtx(); it.f&&setTimeout(it.f,100); }; }
const closeCtx=()=>ctx.classList.remove('show');
addEventListener('pointerdown',e=>{ if(!ctx.contains(e.target)) closeCtx(); });
addEventListener('blur',closeCtx);

/* ================= dialogs ================= */
function dialog({title,body='',fields=[],ok='ok',cancel='cancel',danger=false,noCancel=false}){ return new Promise(res=>{
  const d=mk('dlg',`<div class="dbox glass"><h3>${title}</h3>${body?`<p>${body}</p>`:''}${fields.map(f=>`<label>${f.label}<input data-f="${f.id}" type="${f.type||'text'}" value="${esc(f.value||'')}" placeholder="${esc(f.ph||'')}" autocomplete="off" spellcheck="false"></label>`).join('')}<div class="drow">${noCancel?'':`<button class="btn" data-x="0">${cancel}</button>`}<button class="btn pri ${danger?'dng':''}" data-x="1">${ok}</button></div></div>`);
  document.body.append(d); requestAnimationFrame(()=>d.classList.add('in'));
  const ins=$$('input',d); if(ins[0]){ ins[0].focus(); const v=ins[0].value, dot=v.lastIndexOf('.'); ins[0].setSelectionRange(0,dot>0&&fields[0].value?dot:v.length); }
  const get=()=>Object.fromEntries(ins.map(i=>[i.dataset.f,i.value]));
  const done=v=>{ document.removeEventListener('keydown',kd,true); d.classList.remove('in'); setTimeout(()=>d.remove(),260); res(v); };
  const kd=e=>{ if(e.key==='Escape'&&!noCancel){ e.stopPropagation(); done(null); } else if(e.key==='Enter'){ e.stopPropagation(); e.preventDefault(); done(get()); } };
  document.addEventListener('keydown',kd,true);
  d.addEventListener('click',e=>{ const b=e.target.closest('[data-x]'); if(b) done(b.dataset.x==='1'?get():null); }); }); }

/* ================= panels ================= */
const PN={qs:$('#qs'),nc:$('#nc'),cal:$('#cal')}, BTN={qs:'#qsbtn',nc:'#ncbtn',cal:'#barclock'};
function closePanels(except){ for(const k in PN){ if(k===except) continue; PN[k].classList.remove('show'); $(BTN[k]).classList.remove('open'); } }
function openPanel(k,force){ closeCtx(); const o=force??!PN[k].classList.contains('show'); closePanels(o?k:null);
  if(o&&k==='nc'){ drawNotes(); $('#badge').classList.remove('on'); } if(o&&k==='cal') mountCal(PN.cal);
  PN[k].classList.toggle('show',o); $(BTN[k]).classList.toggle('open',o); }
for(const k in PN){ $(BTN[k]).onclick=()=>openPanel(k); PN[k].addEventListener('pointerdown',e=>e.stopPropagation()); }
addEventListener('pointerdown',e=>{ if(!e.target.closest('[data-p]')) closePanels(); });
$('#ncClr').onclick=()=>{ NOTES.length=0; drawNotes(); };
function mountCal(el){ let cm=new Date(); cm.setDate(1);
  const draw=()=>{ const y=cm.getFullYear(), m=cm.getMonth(), first=cm.getDay(), dim=new Date(y,m+1,0).getDate(), pd=new Date(y,m,0).getDate(), now=new Date();
    let cells=['s','m','t','w','t','f','s'].map(d=>`<span class="h">${d}</span>`).join('');
    for(let i=0;i<42;i++){ const n=i-first+1; let cl='', t=n; if(n<1){ t=pd+n; cl='o'; } else if(n>dim){ t=n-dim; cl='o'; } else if(y===now.getFullYear()&&m===now.getMonth()&&n===now.getDate()) cl='td'; cells+=`<span class="${cl}">${t}</span>`; }
    el.querySelector('.cb').innerHTML=`<div class="row"><b style="font-size:14px;letter-spacing:-.02em">${cm.toLocaleDateString(undefined,{month:'long',year:'numeric'}).toLowerCase()}</b><div class="grp" style="gap:4px"><div class="mini" data-m="-1">${'&lsaquo;'}</div><div class="mini" data-m="0">today</div><div class="mini" data-m="1">${'&rsaquo;'}</div></div></div><div class="cgrid">${cells}</div>`;
    $$('[data-m]',el).forEach(b=>b.onclick=()=>{ const v=+b.dataset.m; cm=v?new Date(y,m+v,1):new Date(now.getFullYear(),now.getMonth(),1); draw(); }); };
  if(!el.querySelector('.cb')) el.insertAdjacentHTML('beforeend','<div class="cb"></div>'); draw(); }

/* ================= battery / network ================= */
const fmtT=s=>{ if(!isFinite(s)||s<=0) return '--'; const h=Math.floor(s/3600), m=Math.round(s%3600/60); return h?`${h}h ${m}m`:`${m}m`; };
let lastChg=null, warned=false;
function paintBattery(b){ BAT=b; emit('bat');
  if(!b){ $('#bpct').textContent=''; $('#batt').style.display='none'; return; }
  const l=b.level, pct=Math.round(l*100); $('#bpct').textContent=pct+'%'; $('#batt').style.setProperty('--lvl',l); $('#batt').classList.toggle('low',l<=.2&&!b.charging); $('#batt').classList.toggle('chg',b.charging);
  if(lastChg!==null&&lastChg!==b.charging) toast(b.charging?'bolt':'battery',b.charging?'charger connected':'running on battery'); lastChg=b.charging;
  if(l<=.2&&!b.charging&&!warned){ warned=true; toast('battery','battery low, '+pct+'%'); } if(l>.25||b.charging) warned=false; }
function paintNet(){ const on=navigator.onLine, c=navigator.connection; $('#netic').innerHTML=ic(on?'wifi':'wifioff'); const q=$('#qNet'); if(q){ q.textContent=on?(c?.effectiveType||'online'):'offline'; $('#qSpd').textContent=c?.downlink?c.downlink+' mbps':'n/a'; } }

/* ================= quick settings ================= */
function buildQS(){ PN.qs.innerHTML=`<div class="tiles">
  <button class="tile" id="tTheme">${ic('moon')}<div class="tx"><b>theme</b><small id="tThemeS"></small></div></button>
  <button class="tile" id="tMin">${ic('sq')}<div class="tx"><b>minimal</b><small id="tMinS"></small></div></button>
  <button class="tile" id="tFull">${ic('full')}<div class="tx"><b>fullscreen</b><small id="tFullS">off</small></div></button>
  <button class="tile" id="tSet">${ic('gear')}<div class="tx"><b>settings</b><small>open app</small></div></button></div>
  <div class="sec"><div class="row"><b>battery</b><span id="qPct">n/a</span></div><div class="meter" id="qMeter"><i></i></div><div class="row"><span>status</span><span id="qState">not supported</span></div><div class="row"><span>time</span><span id="qTime">--</span></div></div>
  <div class="sec"><div class="row"><b>network</b><span id="qNet">--</span></div><div class="row"><span>speed</span><span id="qSpd">--</span></div></div>
  <div class="sec"><div class="row"><b>brightness</b><span id="qBrV">100%</span></div><input type="range" id="qBr" min="30" max="100" value="100"></div>`;
  $('#tTheme').onclick=()=>setTheme(root.dataset.theme==='dark'?'light':'dark'); $('#tMin').onclick=()=>setTheme(S.theme==='minimal'?S.last:'minimal');
  $('#tFull').onclick=()=>document.fullscreenElement?document.exitFullscreen():root.requestFullscreen?.(); $('#tSet').onclick=()=>{ closePanels(); launch('settings'); };
  const br=$('#qBr'); br.oninput=()=>{ S.bright=+br.value; applyBright(); br.style.setProperty('--v',(br.value-30)/70*100); }; br.onchange=saveS; paintNet(); paintQS(); }
function paintQS(){ if(!$('#tTheme')||!S) return; const t=S.theme; $('#tTheme').classList.toggle('act',t==='light'); $('#tThemeS').textContent=t==='minimal'?'minimal on':t; $('#tMin').classList.toggle('act',t==='minimal'); $('#tMinS').textContent=t==='minimal'?'on':'off';
  $('#qBr').value=S.bright; $('#qBrV').textContent=S.bright+'%'; $('#qBr').style.setProperty('--v',(S.bright-30)/70*100);
  const b=BAT; if(b){ $('#qPct').textContent=Math.round(b.level*100)+'%'; $('#qMeter').style.setProperty('--lvl',b.level); $('#qState').textContent=b.charging?(b.level>=1?'fully charged':'charging'):'on battery'; $('#qTime').textContent=b.charging?(b.level>=1?'--':fmtT(b.chargingTime)+' to full'):fmtT(b.dischargingTime)+' left'; } }
document.addEventListener('fullscreenchange',()=>{ const f=!!document.fullscreenElement; $('#tFull')?.classList.toggle('act',f); if($('#tFullS')) $('#tFullS').textContent=f?'on':'off'; });
bus.addEventListener('bat',paintQS); bus.addEventListener('settings',paintQS);

/* ================= apply settings ================= */
const applyBright=()=>{ $('#veil').style.opacity=(100-(S?S.bright:100))/100*.85; };
function setTheme(t){ if(t!=='minimal') S.last=t; S.theme=t; saveS(); localStorage.setItem('g.theme',t); root.dataset.theme=t; $('#dimv').style.opacity=S.dim/100; WP[wpName()].init(); emit('settings'); }
function setCursor(on){ S.cursor=on; saveS(); document.body.classList.toggle('nocur',!on); let s=$('#cstyle'); if(s) s.remove(); if(!on){ s=document.createElement('style'); s.id='cstyle'; s.textContent='*{cursor:auto!important}'; document.head.append(s); } emit('settings'); }
function applyAll(){ root.dataset.theme=S.theme; localStorage.setItem('g.theme',S.theme); document.body.classList.remove('nocur'); setCursorQuiet(); applyBright(); $('#dimv').style.opacity=S.dim/100; $('#icons').classList.toggle('off',!S.icons); WP[wpName()].init(); applyCustomWp(); lastHM=lastSS=''; tick(); paintQS(); }
function setCursorQuiet(){ let s=$('#cstyle'); if(s) s.remove(); if(!S.cursor){ s=document.createElement('style'); s.id='cstyle'; s.textContent='*{cursor:auto!important}'; document.head.append(s); document.body.classList.add('nocur'); } }

/* ================= window manager ================= */
const WINS=new Set(); let zTop=100, focusWin=null;
function openWindow(o){ const {app,title,w=640,h=440,minW=320,minH=200}=o;
  const el=mk('win glass',`<div class="tb"><div class="tl"><b data-a="x">${ic('x')}</b><b data-a="n">${ic('min')}</b><b data-a="m">${ic('sq')}</b></div><div class="t">${esc(title)}</div><div style="width:52px"></div></div><div class="wb"></div><i class="rz r"></i><i class="rz b"></i><i class="rz c"></i>`);
  el.dataset.app=app; el.tabIndex=-1; const n=[...WINS].length; const ww=Math.min(w,innerWidth-24), hh=Math.min(h,innerHeight-110);
  el.style.width=ww+'px'; el.style.height=hh+'px'; el.style.left=Math.max(8,(innerWidth-ww)/2+(n%6)*28-60)+'px'; el.style.top=Math.max(44,(innerHeight-hh)/2-30+(n%6)*28)+'px';
  document.body.append(el); const W_={el,body:$('.wb',el),app,min:false,setTitle:t=>{ $('.t',el).textContent=t; }};
  WINS.add(W_); focusIt(W_); requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('in')));
  let prev=null; const box=(l,t,w2,h2)=>{ el.classList.add('mv'); Object.assign(el.style,{left:l+'px',top:t+'px',width:w2+'px',height:h2+'px'}); setTimeout(()=>el.classList.remove('mv'),480); };
  const cur=()=>[el.offsetLeft,el.offsetTop,el.offsetWidth,el.offsetHeight];
  const max=()=>{ if(prev){ box(...prev); prev=null; } else { prev=cur(); box(8,40,innerWidth-16,innerHeight-100); } };
  W_.close=async(force)=>{ if(!force&&o.beforeClose&&!(await o.beforeClose())) return; el.classList.remove('in'); el.classList.add('out'); WINS.delete(W_); if(focusWin===W_) focusWin=null; refreshDock(); setTimeout(()=>el.remove(),260); };
  W_.minimize=()=>{ W_.min=true; el.classList.add('min'); if(focusWin===W_) focusWin=null; refreshDock(); };
  W_.restore=()=>{ W_.min=false; el.classList.remove('min'); focusIt(W_); };
  $('[data-a=x]',el).onclick=()=>W_.close(); $('[data-a=n]',el).onclick=()=>W_.minimize(); $('[data-a=m]',el).onclick=max;
  el.addEventListener('pointerdown',()=>focusIt(W_),true);
  const tb=$('.tb',el); let ox,oy,dr=false;
  tb.addEventListener('pointerdown',e=>{ if(e.target.closest('.tl')||e.button) return; dr=true; ox=e.clientX-el.offsetLeft; oy=e.clientY-el.offsetTop; el.classList.add('drag'); tb.setPointerCapture(e.pointerId); });
  tb.addEventListener('pointermove',e=>{ if(!dr) return; el.style.left=Math.min(innerWidth-80,Math.max(-el.offsetWidth+80,e.clientX-ox))+'px'; el.style.top=Math.min(innerHeight-40,Math.max(34,e.clientY-oy))+'px'; });
  tb.addEventListener('pointerup',e=>{ if(!dr) return; dr=false; el.classList.remove('drag'); const hh2=innerHeight-100, hw=(innerWidth-24)/2;
    if(e.clientY<36){ if(!prev) max(); } else if(e.clientX<8){ prev=prev||cur(); box(8,40,hw,hh2); } else if(e.clientX>innerWidth-8){ prev=prev||cur(); box(16+hw,40,hw,hh2); } });
  tb.addEventListener('dblclick',e=>{ if(!e.target.closest('.tl')) max(); });
  $$('.rz',el).forEach(r=>r.addEventListener('pointerdown',e=>{ e.preventDefault(); e.stopPropagation(); focusIt(W_); const sx=e.clientX, sy=e.clientY, sw=el.offsetWidth, sh=el.offsetHeight, rx=r.classList.contains('r')||r.classList.contains('c'), ry=r.classList.contains('b')||r.classList.contains('c'); r.setPointerCapture(e.pointerId); el.classList.add('drag'); prev=null;
    const mv=ev=>{ if(rx) el.style.width=Math.max(minW,sw+ev.clientX-sx)+'px'; if(ry) el.style.height=Math.max(minH,sh+ev.clientY-sy)+'px'; }; const up=()=>{ el.classList.remove('drag'); r.removeEventListener('pointermove',mv); r.removeEventListener('pointerup',up); };
    r.addEventListener('pointermove',mv); r.addEventListener('pointerup',up); }));
  Object.assign(W_,{max}); refreshDock(); return W_; }
function focusIt(w){ focusWin=w; w.el.style.zIndex=++zTop; WINS.forEach(x=>x.el.classList.toggle('focus',x===w)); $('#appname').textContent=APPS[w.app]?APPS[w.app].name:w.app; refreshDock(); }
const winsOf=a=>[...WINS].filter(w=>w.app===a);
function closeAllWins(){ [...WINS].forEach(w=>w.close(true)); }

/* ================= apps registry + dock ================= */
const APPS={
  files:{name:'files',icon:'folder',open:a=>openFiles(a)},
  text:{name:'text',icon:'text',open:a=>openEditor(a)},
  settings:{name:'settings',icon:'gear',open:a=>openSettings(a)},
  viewer:{name:'viewer',icon:'image',hidden:true,open:a=>openViewer(a)}
};
function launch(a,args={}){ APPS[a].open(args); }
function buildDock(){ const d=$('#dock'); d.innerHTML=Object.entries(APPS).filter(([k,v])=>!v.hidden).map(([k,v])=>`<div class="dk" data-app="${k}" data-l="${v.name}">${ic(v.icon)}<i class="pip"></i></div>`).join('')+`<i class="dsep"></i><div class="dk" id="dkSp" data-l="search  ctrl k">${ic('search')}</div>`;
  const items=$$('.dk',d);
  d.addEventListener('pointermove',e=>{ if(S&&S.theme==='minimal') return; const L=d.getBoundingClientRect().left; items.forEach(x=>{ const c=L+x.offsetLeft+x.offsetWidth/2, k=Math.exp(-((e.clientX-c)**2)/(2*36*36)); x.style.transform=`translateY(${-k*3}px) scale(${1+k*.14})`; }); });
  d.addEventListener('pointerleave',()=>items.forEach(x=>x.style.transform=''));
  d.addEventListener('click',e=>{ const k=e.target.closest('.dk'); if(!k) return; if(k.id==='dkSp') return spotlight(); const a=k.dataset.app, ws=winsOf(a);
    if(!ws.length) return launch(a); const vis=ws.filter(w=>!w.min);
    if(vis.length&&vis.some(w=>w===focusWin)) ws.forEach(w=>w.minimize()); else { ws.forEach(w=>w.min&&w.restore()); focusIt(ws[ws.length-1]); } }); }
function refreshDock(){ $$('#dock .dk[data-app]').forEach(k=>k.classList.toggle('run',winsOf(k.dataset.app).length>0)); if(!focusWin) $('#appname').textContent='desktop'; }

/* ================= shared file menus ================= */
function openItem(r,from){ if(r.trash) return toast('info','restore it from the trash to open it'); const k=kindOf(r);
  if(k==='dir') return from&&from.go?from.go(r.id):launch('files',{dir:r.id}); if(k==='text') return launch('text',{id:r.id});
  if(['image','video','audio','pdf'].includes(k)) return launch('viewer',{id:r.id,scope:r.parent}); download(r); }
function download(r){ if(!r.blob) return; const a=document.createElement('a'); a.href=urlOf(r); a.download=r.name; a.click(); }
async function renameDlg(r){ const v=await dialog({title:'rename',fields:[{id:'n',label:'name',value:r.name}],ok:'rename'}); if(v&&v.n.trim()) fsRename(r.id,v.n); }
async function newFolder(parent){ const v=await dialog({title:'new folder',fields:[{id:'n',label:'name',value:'untitled folder'}],ok:'create'}); if(v&&v.n.trim()) fsAdd({name:v.n,parent,dir:true}); }
async function newTextFile(parent){ const v=await dialog({title:'new text file',fields:[{id:'n',label:'name',value:'untitled.txt'}],ok:'create'}); if(!v||!v.n.trim()) return; const r=await fsAdd({name:v.n,parent,blob:new Blob([''],{type:'text/plain'})}); if(r) launch('text',{id:r.id}); }
async function delForever(ids){ const ok=await dialog({title:'delete forever',body:`this ${ids.length>1?ids.length+' items':'item'} will be permanently deleted. this cannot be undone.`,ok:'delete',danger:true}); if(ok) fsRemove(ids); }
function itemMenu(ids,from){ const rs=ids.map(i=>FS.get(i)).filter(Boolean); if(!rs.length) return []; const one=rs.length===1?rs[0]:null, tr=rs[0].trash, k=one&&kindOf(one);
  if(tr) return [{t:'restore',i:'restore',f:()=>fsRestore(ids)},{t:'delete forever',i:'trash',f:()=>delForever(ids)}];
  return [{t:'open',i:'folder',f:()=>one&&openItem(one,from),d:!one}, one&&(k==='image'||k==='video')?{t:'set as wallpaper',i:'image',f:()=>{ setCustomWp(one.id); toast('image','wallpaper changed'); }}:null,
    one&&!one.dir?{t:'download',i:'download',f:()=>download(one)}:null,'-',
    {t:'rename',i:'pencil',k:'f2',f:()=>one&&renameDlg(one),d:!one},{t:'copy',i:'copy',k:'ctrl c',f:()=>{ CLIP.ids=ids; CLIP.cut=false; }},{t:'cut',i:'cut',k:'ctrl x',f:()=>{ CLIP.ids=ids; CLIP.cut=true; }},'-',
    {t:'move to trash',i:'trash',k:'del',f:()=>{ fsTrash(ids); toast('trash',ids.length>1?ids.length+' items moved to trash':'moved to trash'); }}]; }
function folderMenu(parent){ return [{h:'create'},{t:'new folder',i:'folder',f:()=>newFolder(parent)},{t:'new text file',i:'text',f:()=>newTextFile(parent)},{t:'upload files',i:'upload',f:async()=>upload(parent,await pickFiles())},'-',
  {t:'paste',i:'paste',k:'ctrl v',f:()=>paste(parent),d:!CLIP.ids.length}]; }

/* ================= files app ================= */
const PLACE={Desktop:'desktop',Documents:'text',Pictures:'image',Music:'audio',Videos:'video',Downloads:'download'};
function fiHTML(r){ const k=kindOf(r); const th=k==='image'&&r.blob?`<img src="${urlOf(r)}" alt="" loading="lazy" draggable="false">`:ic(kindIcon(r));
  return `<div class="fi ${r.dir?'dir':''}" data-id="${r.id}" draggable="true"><div class="th">${th}</div><span class="nm">${esc(r.name)}</span><span class="sz">${r.dir?(kids(r.id).length+' items'):fmtSize(r.size)}</span><span class="md">${fmtDate(r.mtime)}</span></div>`; }
function openFiles(a={}){
  const win=openWindow({app:'files',title:'files',w:780,h:490,minW:430}), body=win.body; body.classList.add('files');
  let cwd=a.dir??null, hist=[cwd], hi=0, view=localStorage.getItem('g.view')||'grid', sel=new Set(), q='', anchor=null;
  body.innerHTML=`<aside class="side"></aside><section class="main"><div class="tool"><button class="ib" data-a="back">${ic('left')}</button><button class="ib" data-a="fwd">${ic('right')}</button><button class="ib" data-a="up">${ic('up')}</button><div class="crumbs"></div>
    <input type="text" placeholder="filter" data-a="q"><button class="ib" data-a="view"></button><button class="ib" data-a="nf" title="new folder">${ic('folder')}</button><button class="ib" data-a="nt" title="new text file">${ic('plus')}</button><button class="ib" data-a="up2" title="upload">${ic('upload')}</button><button class="btn sm" data-a="et" style="display:none">${ic('trash')} empty trash</button></div>
    <div class="flist" tabindex="0"></div><div class="stat"><span class="s1"></span><span class="s2"></span></div></section><div class="dropz">drop to add files</div>`;
  const list=$('.flist',body), el=win.el; el._cwd=cwd;
  const cur=()=>cwd==='trash'?trashed():kids(cwd);
  const items=()=>cur().filter(r=>!q||r.name.toLowerCase().includes(q));
  function render(anim){ if(cwd!=='trash'&&cwd!==null&&!FS.get(cwd)) cwd=null; el._cwd=cwd;
    $('.side',body).innerHTML=`<div class="pl ${cwd===null?'on':''}" data-dir="">${ic('home')}<span>home</span></div>`+kids(null).filter(r=>r.dir).map(r=>`<div class="pl ${cwd===r.id?'on':''}" data-dir="${r.id}">${ic(PLACE[r.name]||'folder')}<span>${esc(r.name.toLowerCase())}</span></div>`).join('')+`<div class="gap"></div><div class="pl ${cwd==='trash'?'on':''}" data-dir="trash">${ic('trash')}<span>trash${trashed().length?' ('+trashed().length+')':''}</span></div>`;
    const path=cwd==='trash'?[{name:'trash',id:'trash'}]:fsPath(cwd); $('.crumbs',body).innerHTML=`<span data-go="">home</span>`+path.map(p=>` / <span data-go="${p.id}">${esc(p.name.toLowerCase())}</span>`).join('');
    $('[data-a=back]',body).disabled=hi<=0; $('[data-a=fwd]',body).disabled=hi>=hist.length-1; $('[data-a=up]',body).disabled=cwd===null; $('[data-a=view]',body).innerHTML=ic(view==='grid'?'list':'grid');
    $('[data-a=et]',body).style.display=cwd==='trash'&&trashed().length?'':'none'; ['nf','nt','up2'].forEach(k=>$(`[data-a=${k}]`,body).style.display=cwd==='trash'?'none':'');
    const it=items(); [...sel].forEach(id=>{ if(!it.some(r=>r.id===id)) sel.delete(id); });
    list.className='flist'+(view==='rows'?' rows':'')+(anim?' anim':''); list.innerHTML=it.length?it.map(fiHTML).join(''):`<div class="empty" style="grid-column:1/-1">${q?'no matches':cwd==='trash'?'trash is empty':'this folder is empty. right-click to add something, or drop files here.'}</div>`;
    $$('.fi',list).forEach(f=>f.classList.toggle('sel',sel.has(f.dataset.id)));
    const sz=[...sel].reduce((s,id)=>s+(FS.get(id)?.size||0),0); $('.s1',body).textContent=sel.size?`${sel.size} selected`:`${it.length} item${it.length===1?'':'s'}`; $('.s2',body).textContent=sel.size&&sz?fmtSize(sz):''; if(anim) setTimeout(()=>list.classList.remove('anim'),500); }
  function go(id,push=true){ if(push){ hist=hist.slice(0,hi+1); hist.push(id); hi++; } cwd=id; sel.clear(); q=''; $('[data-a=q]',body).value=''; render(true); }
  win.go=go; win.navDir=id=>go(id);
  const nav=d=>{ hi=Math.max(0,Math.min(hist.length-1,hi+d)); go(hist[hi],false); };
  const parentOf=()=>{ const r=cwd&&cwd!=='trash'?FS.get(cwd):null; return r?r.parent:null; };
  const target=()=>cwd==='trash'?null:cwd;
  body.addEventListener('click',async e=>{ const g=e.target.closest('[data-go]'), pl=e.target.closest('.pl'), b=e.target.closest('[data-a]');
    if(g) return go(g.dataset.go==='trash'?'trash':g.dataset.go||null); if(pl) return go(pl.dataset.dir==='trash'?'trash':pl.dataset.dir||null);
    if(b){ const a=b.dataset.a; if(a==='back') nav(-1); else if(a==='fwd') nav(1); else if(a==='up') go(parentOf()); else if(a==='view'){ view=view==='grid'?'rows':'grid'; localStorage.setItem('g.view',view); render(); }
      else if(a==='nf') newFolder(target()); else if(a==='nt') newTextFile(target()); else if(a==='up2') upload(target(),await pickFiles());
      else if(a==='et'){ const ok=await dialog({title:'empty trash',body:'everything in the trash will be permanently deleted.',ok:'empty trash',danger:true}); if(ok) fsRemove(trashed().map(r=>r.id)); } return; }
    const f=e.target.closest('.fi'); if(f&&list.contains(f)){ const id=f.dataset.id; if(e.ctrlKey||e.metaKey){ sel.has(id)?sel.delete(id):sel.add(id); anchor=id; }
      else if(e.shiftKey&&anchor){ const ids=items().map(r=>r.id), a=ids.indexOf(anchor), b2=ids.indexOf(id); sel=new Set(ids.slice(Math.min(a,b2),Math.max(a,b2)+1)); } else { sel=new Set([id]); anchor=id; } render(); }
    else if(list.contains(e.target)&&sel.size){ sel.clear(); render(); } });
  $('[data-a=q]',body).oninput=e=>{ q=e.target.value.toLowerCase(); render(); };
  list.addEventListener('pointerdown',()=>list.focus());
  list.addEventListener('dblclick',e=>{ const f=e.target.closest('.fi'); if(f) openItem(FS.get(f.dataset.id),{go}); });
  list.addEventListener('dragstart',e=>{ const f=e.target.closest('.fi'); if(!f) return; if(!sel.has(f.dataset.id)){ sel=new Set([f.dataset.id]); render(); } e.dataTransfer.setData('text/gallium',JSON.stringify([...sel])); e.dataTransfer.effectAllowed='move'; });
  body.addEventListener('contextmenu',e=>{ e.preventDefault(); e.stopPropagation(); const f=e.target.closest('.fi'); if(f&&list.contains(f)){ if(!sel.has(f.dataset.id)){ sel=new Set([f.dataset.id]); render(); } return showCtx(e.clientX,e.clientY,itemMenu([...sel],{go})); }
    if(e.target.closest('.pl,.tool,.stat')) return; if(cwd==='trash') return showCtx(e.clientX,e.clientY,[{t:'empty trash',i:'trash',f:()=>$('[data-a=et]',body).click(),d:!trashed().length}]);
    showCtx(e.clientX,e.clientY,[...folderMenu(cwd),'-',{t:view==='grid'?'list view':'grid view',i:view==='grid'?'list':'grid',f:()=>$('[data-a=view]',body).click()}]); });
  el.addEventListener('keydown',e=>{ if(e.target.tagName==='INPUT') return; const mod=e.ctrlKey||e.metaKey, ids=[...sel], k=e.key.toLowerCase();
    if(k==='delete'||k==='backspace'){ if(ids.length) cwd==='trash'?delForever(ids):(fsTrash(ids),toast('trash','moved to trash')); }
    else if(k==='f2'&&ids.length===1) renameDlg(FS.get(ids[0])); else if(k==='enter'&&ids.length===1) openItem(FS.get(ids[0]),{go});
    else if(mod&&k==='a'){ e.preventDefault(); sel=new Set(items().map(r=>r.id)); render(); } else if(mod&&(k==='c'||k==='x')&&ids.length){ CLIP.ids=ids; CLIP.cut=k==='x'; toast('copy',k==='x'?'cut':'copied'); }
    else if(mod&&k==='v'&&cwd!=='trash') paste(cwd); else if(k==='escape'){ sel.clear(); render(); } });
  watch(el,'fs',()=>render()); render(true); }

/* ================= text editor ================= */
function openEditor(a={}){ let rec=a.id?FS.get(a.id):null, dirty=false;
  if(rec){ const ex=winsOf('text').find(w=>w.rid===rec.id); if(ex){ ex.min&&ex.restore(); focusIt(ex); return; } }
  const win=openWindow({app:'text',title:rec?rec.name:'untitled',w:660,h:470,minW:360,beforeClose:async()=>!dirty||!!(await dialog({title:'discard changes?',body:`${esc(rec?rec.name:'untitled')} has unsaved changes.`,ok:'discard',cancel:'keep editing',danger:true}))});
  win.rid=rec?.id; win.body.innerHTML=`<div class="etb"><span class="en"></span><span class="es"></span><button class="btn sm" data-a="save">${ic('check')} save</button></div><textarea class="ed" spellcheck="false" placeholder="start typing"></textarea><div class="estat"></div>`;
  const ta=$('.ed',win.body), el=win.el;
  const upd=()=>{ const n=rec?rec.name:'untitled'; $('.en',win.body).textContent=n; $('.es',win.body).textContent=dirty?'unsaved changes':rec?'saved':'not saved yet'; win.setTitle(n+(dirty?' •':'')); const v=ta.value;
    $('.estat',win.body).textContent=`${v?v.split('\n').length:0} lines · ${(v.trim()?v.trim().split(/\s+/).length:0)} words · ${v.length} characters`; };
  const save=async()=>{ const blob=new Blob([ta.value],{type:'text/plain'});
    if(!rec){ const v=await dialog({title:'save file',fields:[{id:'n',label:'name',value:'untitled.txt'}],ok:'save'}); if(!v||!v.n.trim()) return; rec=await fsAdd({name:v.n,parent:rootId('Documents'),blob}); if(!rec) return; win.rid=rec.id; }
    else if(!(await fsWrite(rec.id,blob))) return; dirty=false; upd(); toast('check','saved '+rec.name); };
  if(rec) readText(rec).then(t=>{ ta.value=t; upd(); }); upd();
  ta.addEventListener('input',()=>{ dirty=true; upd(); });
  ta.addEventListener('keydown',e=>{ if(e.key==='Tab'){ e.preventDefault(); ta.setRangeText('  ',ta.selectionStart,ta.selectionEnd,'end'); dirty=true; upd(); } });
  el.addEventListener('keydown',e=>{ if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){ e.preventDefault(); save(); } });
  $('[data-a=save]',win.body).onclick=save; watch(el,'fs',()=>{ if(rec&&FS.has(rec.id)) upd(); }); setTimeout(()=>ta.focus(),350); }

/* ================= viewer ================= */
function openViewer({id,scope}){ if(!FS.get(id)) return; const win=openWindow({app:'viewer',title:FS.get(id).name,w:740,h:540,minW:360}); let cur=id;
  const list=()=>kids(scope).filter(x=>['image','video','audio','pdf'].includes(kindOf(x)));
  const show=()=>{ const r=FS.get(cur); if(!r) return win.close(true); win.setTitle(r.name); const k=kindOf(r), u=urlOf(r), ls=list(), i=ls.findIndex(x=>x.id===cur);
    const media=k==='image'?`<img src="${u}" alt="">`:k==='video'?`<video src="${u}" controls autoplay></video>`:k==='audio'?`<div style="display:flex;flex-direction:column;align-items:center;gap:18px;font-size:64px">${ic('audio')}<audio src="${u}" controls autoplay></audio></div>`:`<iframe src="${u}"></iframe>`;
    win.body.innerHTML=`<div class="etb"><span class="en">${esc(r.name)}</span><span class="es">${fmtSize(r.size)}${ls.length>1?` · ${i+1} of ${ls.length}`:''}</span>${k==='image'||k==='video'?`<button class="btn sm" data-a="wp">${ic('image')} set as wallpaper</button>`:''}<button class="btn sm" data-a="dl">${ic('download')} download</button></div><div class="vw">${media}${ls.length>1?`<button class="vnav l" data-a="pv">${ic('left')}</button><button class="vnav r" data-a="nx">${ic('right')}</button>`:''}</div>`; };
  const step=d=>{ const ls=list(), i=ls.findIndex(x=>x.id===cur); if(ls.length){ cur=ls[(i+d+ls.length)%ls.length].id; show(); } };
  win.body.addEventListener('click',e=>{ const b=e.target.closest('[data-a]'); if(!b) return; const a=b.dataset.a; if(a==='dl') download(FS.get(cur)); else if(a==='wp'){ setCustomWp(cur); toast('image','wallpaper changed'); } else step(a==='nx'?1:-1); });
  win.el.addEventListener('keydown',e=>{ if(e.key==='ArrowRight') step(1); else if(e.key==='ArrowLeft') step(-1); });
  watch(win.el,'fs',()=>{ if(!FS.get(cur)||FS.get(cur).trash) win.close(true); }); show(); }

/* ================= settings ================= */
function openSettings(a={}){ const ex=winsOf('settings')[0]; if(ex){ ex.min&&ex.restore(); focusIt(ex); ex.go(a.sec); return; }
  const win=openWindow({app:'settings',title:'settings',w:780,h:540,minW:540,minH:320}), body=win.body; body.classList.add('set');
  const SECS=[['appearance','palette'],['wallpaper','image'],['desktop','desktop'],['accounts','user'],['storage','hdd'],['about','info']]; let sec=a.sec||'appearance';
  body.innerHTML=`<aside class="side">${SECS.map(s=>`<div class="pl" data-sec="${s[0]}">${ic(s[1])}<span>${s[0]}</span></div>`).join('')}</aside><div class="sc"></div>`;
  const sw=(k,t,d)=>`<div class="srow"><div><b>${t}</b><small>${d}</small></div><button class="sw ${S[k]?'on':''}" data-act="tog" data-k="${k}"><i></i></button></div>`;
  const seg=(act,opts,v)=>`<div class="seg">${opts.map(o=>`<button class="${o[0]===v?'on':''}" data-act="${act}" data-v="${o[0]}">${o[1]}</button>`).join('')}</div>`;
  const kv=(k,v)=>`<div class="kv"><span>${k}</span><span>${v}</span></div>`;
  const V={
    appearance:()=>`<h2>appearance</h2><div class="card"><div class="srow"><div><b>theme</b><small>dark, light, or the flat minimal look</small></div>${seg('theme',[['dark','dark'],['light','light'],['minimal','minimal']],S.theme)}</div>
      <div class="srow"><div><b>custom cursor</b><small>use the galliumOS pointer instead of the system one</small></div><button class="sw ${S.cursor?'on':''}" data-act="cursor"><i></i></button></div></div>`,
    wallpaper:()=>{ const c=S.cwp&&FS.get(S.cwp); return `<h2>wallpaper</h2><h4>live backgrounds</h4><div class="card"><div class="wpg">${Object.entries(WP).map(([k,v])=>`<button class="${!cwpOn&&S.wp===k?'on':''}" data-act="wp" data-v="${k}">${v.n}</button>`).join('')}</div></div>
      <h4>your own</h4><div class="card"><div class="srow"><div><b>custom wallpaper</b><small>${c?esc(c.name):'an image or an mp4 video from your device'}</small></div><div class="grp" style="gap:6px"><button class="btn sm" data-act="cwp-pick">${ic('upload')} choose file</button>${c?'<button class="btn sm" data-act="cwp-clear">remove</button>':''}</div></div>
      <div class="srow"><div><b>dim wallpaper</b><small>fade it toward the background colour</small></div><input type="range" data-range="dim" min="0" max="80" value="${S.dim}" style="width:160px;--v:${S.dim/80*100}"></div></div>`; },
    desktop:()=>`<h2>desktop</h2><h4>clock</h4><div class="card">${sw('secs','show seconds','the ascii seconds counter next to the time')}${sw('h24','24-hour time','otherwise 12-hour with am and pm')}</div>
      <h4>desktop</h4><div class="card">${sw('icons','show desktop icons','files in your desktop folder')}</div>
      <h4>widgets</h4><div class="card">${Object.entries(WID).map(([k,v])=>`<div class="srow"><div><b>${v.n}</b></div><button class="sw ${S.widgets[k]?.on?'on':''}" data-act="wid" data-v="${k}"><i></i></button></div>`).join('')}</div>`,
    accounts:()=>{ const us=getUsers(); return `<h2>accounts</h2><div class="card"><div class="srow"><div style="display:flex;align-items:center;gap:14px"><div class="av" style="width:44px;height:44px;font-size:20px">${esc(U.name[0].toUpperCase())}</div><div><b>${esc(U.name)}</b><small>${U.hash?'password protected':'no password'} · you are signed in</small></div></div></div>
      <div class="srow"><div><b>password</b><small>${U.hash?'change or remove it':'protect this account'}</small></div><button class="btn sm" data-act="pw">${ic('key')} ${U.hash?'change':'set password'}</button></div></div>
      <h4>manage</h4><div class="card"><div class="srow"><div><b>add account</b><small>${us.length} account${us.length===1?'':'s'} on this device, each with its own files and settings</small></div><button class="btn sm" data-act="acc-new">${ic('plus')} new account</button></div>
      <div class="srow"><div><b>sign out</b><small>return to the login screen</small></div><button class="btn sm" data-act="acc-out">${ic('logout')} sign out</button></div>
      <div class="srow"><div><b>delete this account</b><small>removes its files and settings from this device</small></div><button class="btn sm" data-act="acc-del">delete</button></div></div>
      <small style="color:var(--dim)">accounts live in this browser only. passwords are hashed locally and are not a substitute for real security.</small>`; },
    storage:()=>{ const n=[...FS.values()].filter(r=>!r.dir).length; return `<h2>storage</h2><div class="card"><div class="srow"><div><b id="stUsed">${fmtSize(fsUsed())}</b><small>${n} file${n===1?'':'s'} in your account</small></div><span class="mono" id="stQ" style="color:var(--dim)"></span></div>
      <div class="srow"><div><b>trash</b><small>${trashed().length} item${trashed().length===1?'':'s'}</small></div><button class="btn sm" data-act="et" ${trashed().length?'':'disabled'}>empty trash</button></div>
      <div class="srow"><div><b>erase all files</b><small>deletes everything in this account and starts fresh</small></div><button class="btn sm" data-act="wipe">erase</button></div></div>`; },
    about:()=>{ const n=navigator; return `<h2>about galliumOS</h2><div class="card">${kv('version','0.2')}${kv('platform',esc(n.userAgentData?.platform||n.platform||'unknown'))}${kv('cpu cores',n.hardwareConcurrency||'unknown')}${kv('memory',n.deviceMemory?'at least '+n.deviceMemory+' gb':'unknown')}${kv('display',`${screen.width}×${screen.height} at ${devicePixelRatio}x`)}${kv('language',n.language)}${kv('timezone',Intl.DateTimeFormat().resolvedOptions().timeZone)}</div>
      <h4>shortcuts</h4><div class="card">${[['search','ctrl k'],['lock','ctrl l'],['rename file','f2'],['trash file','delete'],['copy / cut / paste','ctrl c / x / v'],['maximize window','double-click title'],['snap window','drag to an edge']].map(r=>kv(r[0],`<kbd>${r[1]}</kbd>`)).join('')}</div>`; }
  };
  function render(){ $$('.pl',body).forEach(p=>p.classList.toggle('on',p.dataset.sec===sec)); const sc=$('.sc',body), top=sc.scrollTop; sc.innerHTML=V[sec](); sc.scrollTop=top; sc.style.animation='none'; void sc.offsetWidth; sc.style.animation='';
    if(sec==='storage') navigator.storage?.estimate?.().then(e=>{ const q=$('#stQ',body); if(q&&e.quota) q.textContent=`${fmtSize(e.usage||0)} of ${fmtSize(e.quota)} browser quota`; }); }
  win.go=s=>{ if(s) sec=s; render(); };
  body.addEventListener('click',async e=>{ const pl=e.target.closest('.pl'); if(pl){ sec=pl.dataset.sec; return render(); } const b=e.target.closest('[data-act]'); if(!b) return; const a=b.dataset.act, v=b.dataset.v;
    if(a==='theme') setTheme(v); else if(a==='cursor') setCursor(!S.cursor);
    else if(a==='tog'){ const k=b.dataset.k; S[k]=!S[k]; saveS(); if(k==='icons') $('#icons').classList.toggle('off',!S.icons); if(k==='h24'){ lastHM=''; } tick(); render(); }
    else if(a==='wid') toggleWidget(v); else if(a==='wp'){ if(S.cwp){ S.cwp=null; applyCustomWp(); } setWp(v); }
    else if(a==='cwp-pick'){ const f=(await pickFiles('image/*,video/*,.mp4',false))[0]; if(!f) return; if(!/^(image|video)\//.test(f.type)&&!/\.(mp4|webm|mov|png|jpe?g|gif|webp|avif)$/i.test(f.name)) return toast('x','pick an image or video file'); const r=await fsAdd({name:f.name,parent:rootId('Pictures'),blob:f}); if(r){ setCustomWp(r.id); toast('image','wallpaper changed'); } }
    else if(a==='cwp-clear') setCustomWp(null);
    else if(a==='pw'){ const v2=await dialog({title:U.hash?'change password':'set password',fields:[...(U.hash?[{id:'o',label:'current password',type:'password'}]:[]),{id:'n',label:U.hash?'new password (leave empty to remove)':'new password',type:'password'},{id:'c',label:'confirm',type:'password'}],ok:'save'}); if(!v2) return;
      if(U.hash&&!(await checkPw(U,v2.o))) return toast('x','current password is wrong'); if(v2.n!==v2.c) return toast('x','passwords do not match');
      const us=getUsers(), me=us.find(u=>u.name===U.name); me.hash=v2.n?await hashPw(me.salt,v2.n):null; setUsers(us); U=me; toast('check',v2.n?'password updated':'password removed'); render(); }
    else if(a==='acc-new'){ const v2=await dialog({title:'new account',fields:[{id:'n',label:'name'},{id:'p',label:'password (optional)',type:'password'}],ok:'create'}); if(!v2) return; const r=await createUser(v2.n,v2.p); if(typeof r==='string') return toast('x',r); await ensureHome(r.name); toast('user','account created for '+r.name); render(); }
    else if(a==='acc-out') logout();
    else if(a==='acc-del'){ const ok=await dialog({title:'delete account',body:`all files and settings for ${esc(U.name)} will be removed from this device.`,ok:'delete',danger:true}); if(ok){ const n=U.name; logout(); deleteUser(n); } }
    else if(a==='et'){ const ok=await dialog({title:'empty trash',body:'everything in the trash will be permanently deleted.',ok:'empty trash',danger:true}); if(ok) fsRemove(trashed().map(r=>r.id)); }
    else if(a==='wipe'){ const ok=await dialog({title:'erase all files',body:'every file and folder in this account will be deleted permanently.',ok:'erase everything',danger:true}); if(ok){ S.cwp=null; await fsRemove([...FS.keys()]); await ensureHome(U.name,true); applyCustomWp(); toast('trash','all files erased'); } } });
  body.addEventListener('input',e=>{ const r=e.target.closest('[data-range]'); if(!r) return; S.dim=+r.value; r.style.setProperty('--v',r.value/80*100); $('#dimv').style.opacity=S.dim/100; });
  body.addEventListener('change',e=>{ if(e.target.closest('[data-range]')) saveS(); });
  watch(win.el,'settings',render); watch(win.el,'fs',()=>{ if(sec==='storage'||sec==='wallpaper') render(); }); render(); }

/* ================= widgets ================= */
const WID={
  calendar:{n:'calendar',w:268,mount(b){ mountCal(b); }},
  notes:{n:'notes',w:244,mount(b){ b.innerHTML='<textarea placeholder="jot something down" spellcheck="false"></textarea>'; const t=$('textarea',b); t.value=S.notes; t.oninput=()=>{ S.notes=t.value; clearTimeout(t._s); t._s=setTimeout(saveS,400); }; }},
  todo:{n:'to-do',w:252,mount(b){ b.classList.add('todo'); const draw=()=>{ $('.tl2',b).innerHTML=S.todos.length?S.todos.map((t,i)=>`<div class="it ${t.d?'done':''}" data-i="${i}"><span class="ck">${ic('check')}</span><span>${esc(t.t)}</span><button data-del="${i}">${ic('x')}</button></div>`).join(''):'<div class="empty" style="padding:10px 0">all clear</div>'; };
    b.innerHTML='<input type="text" placeholder="add a task" spellcheck="false"><div class="tl2"></div>'; draw(); const inp=$('input',b);
    inp.onkeydown=e=>{ if(e.key==='Enter'&&inp.value.trim()){ S.todos.push({t:inp.value.trim(),d:false}); inp.value=''; saveS(); draw(); } };
    b.onclick=e=>{ const d=e.target.closest('[data-del]'); if(d){ S.todos.splice(+d.dataset.del,1); saveS(); return draw(); } const it=e.target.closest('.it'); if(it){ const t=S.todos[+it.dataset.i]; t.d=!t.d; saveS(); draw(); } }; }},
  battery:{n:'battery',w:228,mount(b){ const draw=()=>{ if(!BAT){ b.innerHTML='<div class="big">n/a</div><div style="color:var(--dim);margin-top:6px">battery info is not available in this browser</div>'; return; }
      b.innerHTML=`<div class="big">${Math.round(BAT.level*100)}<span style="font-size:.4em;opacity:.5">%</span></div><div class="meter" style="margin:10px 0 8px;--lvl:${BAT.level}"><i></i></div><div class="row"><span>${BAT.charging?(BAT.level>=1?'fully charged':'charging'):'on battery'}</span><span>${BAT.charging?(BAT.level>=1?'':fmtT(BAT.chargingTime)):fmtT(BAT.dischargingTime)}</span></div>`; };
    draw(); watch(b,'bat',draw); }},
  storage:{n:'storage',w:228,mount(b){ const draw=async()=>{ const used=fsUsed(), e=await navigator.storage?.estimate?.().catch(()=>null), n=[...FS.values()].filter(r=>!r.dir).length;
      b.innerHTML=`<div class="big" style="font-size:30px">${fmtSize(used)}</div><div class="meter" style="margin:10px 0 8px;--lvl:${e&&e.quota?Math.max(.02,used/e.quota):.02}"><i></i></div><div class="row"><span>${n} file${n===1?'':'s'}</span><span>${e&&e.quota?fmtSize(e.quota)+' free':''}</span></div>`; }; draw(); watch(b,'fs',draw); }},
  stopwatch:{n:'stopwatch',w:228,mount(b){ let run=false, t0=0, acc=0; b.innerHTML=`<div class="big mono" style="font-size:30px;font-family:var(--mono);letter-spacing:-.04em"></div><div class="grp" style="gap:6px;margin-top:12px"><button class="btn sm pri" data-a="go">start</button><button class="btn sm" data-a="rs">reset</button></div>`;
    const disp=$('.big',b), go=$('[data-a=go]',b), cur=()=>acc+(run?performance.now()-t0:0), draw=()=>{ const t=cur(), m=Math.floor(t/60000), s=Math.floor(t/1000)%60, c=Math.floor(t/10)%100; disp.textContent=`${p2(m)}:${p2(s)}.${p2(c)}`; }; draw();
    const iv=setInterval(()=>{ if(!b.isConnected) return clearInterval(iv); if(run) draw(); },40);
    go.onclick=()=>{ if(run){ acc=cur(); run=false; go.textContent='start'; } else { t0=performance.now(); run=true; go.textContent='stop'; } draw(); }; $('[data-a=rs]',b).onclick=()=>{ run=false; acc=0; go.textContent='start'; draw(); }; }}
};
function createWidget(id){ const d=WID[id], cfg=S.widgets[id]||(S.widgets[id]={on:true}); const el=mk('widget glass',`<div class="wh"><span>${d.n}</span><button data-x>${ic('x')}</button></div><div class="wbd"></div>`); el.dataset.w=id; el.style.width=d.w+'px'; $('#widgets').append(el); d.mount($('.wbd',el));
  if(cfg.x==null){ let x=innerWidth-d.w-24, y=48; const others=$$('.widget',$('#widgets')).filter(w=>w!==el); for(const w of others){ const b=w.offsetTop+w.offsetHeight+12; if(Math.abs(w.offsetLeft-x)<60&&b>y) y=b; }
    if(y+el.offsetHeight>innerHeight-100){ y=48; x-=d.w+14; } cfg.x=x; cfg.y=y; saveS(); }
  el.style.left=Math.max(0,Math.min(innerWidth-120,cfg.x))+'px'; el.style.top=Math.max(36,Math.min(innerHeight-100,cfg.y))+'px';
  $('[data-x]',el).onclick=()=>toggleWidget(id);
  let ox,oy,dr=false; el.addEventListener('pointerdown',e=>{ if(e.target.closest('input,textarea,button,.it,.cgrid,.mini')) return; dr=true; ox=e.clientX-el.offsetLeft; oy=e.clientY-el.offsetTop; el.classList.add('drag'); el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove',e=>{ if(!dr) return; el.style.left=Math.max(0,Math.min(innerWidth-80,e.clientX-ox))+'px'; el.style.top=Math.max(36,Math.min(innerHeight-90,e.clientY-oy))+'px'; });
  el.addEventListener('pointerup',()=>{ if(!dr) return; dr=false; el.classList.remove('drag'); cfg.x=el.offsetLeft; cfg.y=el.offsetTop; saveS(); });
  el.addEventListener('contextmenu',e=>{ e.preventDefault(); e.stopPropagation(); showCtx(e.clientX,e.clientY,[{t:'remove widget',i:'x',f:()=>toggleWidget(id)}]); }); }
function syncWidgets(){ if(!S) return; for(const id in WID){ const on=S.widgets[id]?.on, ex=$(`.widget[data-w=${id}]`);
  if(on&&!ex) createWidget(id); else if(!on&&ex){ ex.classList.add('bye'); setTimeout(()=>ex.remove(),300); } } }
function toggleWidget(id){ S.widgets[id]=Object.assign(S.widgets[id]||{},{on:!S.widgets[id]?.on}); if(S.widgets[id].on){ delete S.widgets[id].x; } saveS(); syncWidgets(); emit('settings'); }

/* ================= desktop icons + selection ================= */
let dsel=new Set(); const deskId=()=>rootId('Desktop');
function renderIcons(){ const box=$('#icons'); if(!U){ box.innerHTML=''; return; } const d=deskId(); box.innerHTML=d?kids(d).map(fiHTML).join(''):''; $$('.fi',box).forEach(f=>f.classList.toggle('sel',dsel.has(f.dataset.id))); }
(()=>{ const box=$('#icons'); let sx,sy,rect=null;
  const mark=()=>$$('.fi',box).forEach(f=>f.classList.toggle('sel',dsel.has(f.dataset.id)));
  box.addEventListener('pointerdown',e=>{ const f=e.target.closest('.fi'); if(!f||e.button) return; closePanels(); const id=f.dataset.id; if(e.ctrlKey||e.metaKey) dsel.has(id)?dsel.delete(id):dsel.add(id); else if(!dsel.has(id)) dsel=new Set([id]); mark(); });
  box.addEventListener('dblclick',e=>{ const f=e.target.closest('.fi'); if(f) openItem(FS.get(f.dataset.id)); });
  box.addEventListener('dragstart',e=>{ const f=e.target.closest('.fi'); if(!f) return; if(!dsel.has(f.dataset.id)){ dsel=new Set([f.dataset.id]); mark(); } e.dataTransfer.setData('text/gallium',JSON.stringify([...dsel])); });
  box.addEventListener('contextmenu',e=>{ const f=e.target.closest('.fi'); if(!f) return; e.preventDefault(); e.stopPropagation(); if(!dsel.has(f.dataset.id)){ dsel=new Set([f.dataset.id]); mark(); } showCtx(e.clientX,e.clientY,itemMenu([...dsel])); });
  $('#desk').addEventListener('pointerdown',e=>{ if(!['desk','icons','widgets'].includes(e.target.id)||e.button) return; dsel=new Set(); mark(); sx=e.clientX; sy=e.clientY; rect=document.createElement('div'); rect.id='sel'; document.body.append(rect); });
  addEventListener('pointermove',e=>{ if(!rect) return; const l=Math.min(sx,e.clientX), t=Math.min(sy,e.clientY), w=Math.abs(e.clientX-sx), h=Math.abs(e.clientY-sy); Object.assign(rect.style,{left:l+'px',top:t+'px',width:w+'px',height:h+'px'});
    dsel=new Set($$('.fi',box).filter(f=>{ const b=f.getBoundingClientRect(); return b.left<l+w&&b.right>l&&b.top<t+h&&b.bottom>t; }).map(f=>f.dataset.id)); mark(); });
  addEventListener('pointerup',()=>{ if(!rect) return; const r=rect; rect=null; r.style.opacity=0; r.style.transition='opacity .25s'; setTimeout(()=>r.remove(),260); }); })();
bus.addEventListener('fs',()=>{ if(!U) return; renderIcons(); if(S.cwp){ const r=FS.get(S.cwp); if(!r||r.trash) applyCustomWp(); } });
function dropDest(t){ const f=t.closest('.fi.dir'); if(f) return f.dataset.id; const pl=t.closest('.pl[data-dir]'); if(pl) return pl.dataset.dir==='trash'?'trash':(pl.dataset.dir||null);
  const w=t.closest('.win[data-app=files]'); if(w) return w._cwd; return deskId(); }
let dzT; addEventListener('dragover',e=>{ if(!U||locked) return; e.preventDefault(); const w=e.target.closest?.('.win[data-app=files]'); $$('.dropz').forEach(z=>z.classList.remove('on')); if(w&&!e.dataTransfer.types.includes('text/gallium')) $('.dropz',w).classList.add('on'); clearTimeout(dzT); dzT=setTimeout(()=>$$('.dropz').forEach(z=>z.classList.remove('on')),200); });
addEventListener('drop',async e=>{ e.preventDefault(); $$('.dropz').forEach(z=>z.classList.remove('on')); if(!U||locked) return; const dest=dropDest(e.target), g=e.dataTransfer.getData('text/gallium');
  if(g){ const ids=JSON.parse(g); if(dest==='trash'){ fsTrash(ids); toast('trash','moved to trash'); } else fsMove(ids,dest); } else if(e.dataTransfer.files.length&&dest!=='trash') upload(dest,[...e.dataTransfer.files]); });

/* ================= login / session ================= */
const lg=$('#login'), lb=$('#lbody');
async function ensureHome(name,force){ const was=U; const tmp=U&&U.name===name; if(!tmp) U={name}; 
  if(!tmp){ const recs=await dbUser(name); if(recs.some(r=>!r.parent&&r.dir)){ U=was; return; } const saved=new Map(FS); FS.clear(); recs.forEach(r=>FS.set(r.id,r)); await mkHome(); FS.clear(); saved.forEach((v,k)=>FS.set(k,v)); U=was; emit('fs'); return; }
  if(force||![...FS.values()].some(r=>!r.parent&&r.dir)) await mkHome(); }
async function mkHome(){ for(const n of Object.keys(PLACE)) await fsAdd({name:n,parent:null,dir:true});
  await fsAdd({name:'welcome.txt',parent:rootId('Documents'),blob:new Blob([`welcome to galliumOS, ${U.name}.\n\n- your files live in this browser, stored per account.\n- right-click the desktop or any folder to create, upload, rename and delete.\n- drag files between folders, or drop them in from your computer.\n- open settings to change the wallpaper (mp4 works too), theme, widgets and more.\n- press ctrl+k to search anything.\n`],{type:'text/plain'})}); }
async function enter(u){ U=u; S=loadS(u.name); FS.clear(); (await dbUser(u.name)).forEach(r=>FS.set(r.id,r)); await ensureHome(u.name); dsel=new Set();
  applyAll(); buildQS(); paintQS(); renderIcons(); syncWidgets(); lg.classList.add('off'); $('#desk').classList.add('on'); locked=false; setTimeout(()=>toast('user','signed in as '+u.name),700); }
function logout(){ closeAllWins(); closePanels(); closeCtx(); $('#widgets').innerHTML=''; $('#icons').innerHTML=''; $('#wv').classList.remove('on'); $('#wi').classList.remove('on'); $('#wv').pause(); cwpOn=false; cv.classList.remove('hide');
  U=null; S=null; locked=false; FS.clear(); $('#desk').classList.remove('on'); root.dataset.theme=localStorage.getItem('g.theme')||'dark'; $('#veil').style.opacity=0; $('#dimv').style.opacity=0; $('#cstyle')?.remove(); showLogin('auto'); }
function lockNow(){ if(!U||locked) return; locked=true; closePanels(); closeCtx(); showLogin('pass',U.name); }
function showLogin(view,name){ lg.classList.remove('off'); renderLogin(view,name); }
function renderLogin(view,name){ const us=getUsers(); if(!us.length) view='first'; if(view==='auto') view=us.length===1?'pass':'pick'; if(view==='pass'&&!name) name=us[0]?.name;
  const av=(n,c='')=>`<div class="av ${c}" ${c?`data-u="${esc(n)}"`:''}>${esc(n[0].toUpperCase())}</div>`;
  if(view==='pick') lb.innerHTML=`<div class="lbox"><h2>who is using galliumOS?</h2><div class="ulist">${us.map(u=>`<div>${av(u.name,'btn2')}<span>${esc(u.name)}</span></div>`).join('')}</div><span class="lnk" data-v="new">new account</span></div>`;
  else if(view==='pass'){ const u=us.find(x=>x.name===name)||us[0]; lb.innerHTML=`<div class="lbox">${av(u.name)}<h2>${esc(u.name)}</h2>${u.hash?'<input type="password" placeholder="password" id="lpw" autocomplete="off">':'<small>no password set</small>'}<button class="btn pri" data-act="go" data-u="${esc(u.name)}">${u.hash?'unlock':'sign in'}</button>
    ${locked?'<span class="lnk" data-act="out">sign out</span>':us.length>1?'<span class="lnk" data-v="pick">other accounts</span>':''}${locked?'':'<span class="lnk" data-v="new">new account</span>'}</div>`; setTimeout(()=>$('#lpw')?.focus(),60); }
  else { const first=view==='first'; lb.innerHTML=`<div class="lbox">${first?'<svg class="ic" viewBox="0 0 32 32" style="width:48px;height:48px;stroke-width:1.2"><circle cx="16" cy="16" r="11"/><circle cx="16" cy="16" r="4"/></svg><h2>welcome to galliumOS</h2><small>create your account to get started</small>':'<h2>new account</h2>'}
    <input type="text" id="nn" placeholder="name" autocomplete="off" spellcheck="false" maxlength="24"><input type="password" id="np" placeholder="password (optional)"><input type="password" id="nc2" placeholder="confirm password"><small id="lerr" style="min-height:14px"></small>
    <button class="btn pri" data-act="create">${first?'get started':'create account'}</button>${first?'':'<span class="lnk" data-v="pick">back</span>'}</div>`; setTimeout(()=>$('#nn')?.focus(),60); } }
lb.addEventListener('click',async e=>{ const t=e.target.closest('[data-u],[data-v],[data-act]'); if(!t) return;
  if(t.dataset.v) return renderLogin(t.dataset.v); if(t.classList.contains('av')) return renderLogin('pass',t.dataset.u); const a=t.dataset.act;
  if(a==='out') return logout();
  if(a==='go'){ const u=getUsers().find(x=>x.name===t.dataset.u), inp=$('#lpw'); if(!(await checkPw(u,inp?inp.value:''))){ inp.classList.remove('err'); void inp.offsetWidth; inp.classList.add('err'); inp.value=''; return; }
    if(locked&&U&&U.name===u.name){ locked=false; lg.classList.add('off'); } else { if(U) logout(); await enter(u); } }
  if(a==='create'){ const n=$('#nn').value, p=$('#np').value, err=m=>{ $('#lerr').textContent=m; }; if(p!==$('#nc2').value) return err('passwords do not match'); const r=await createUser(n,p); if(typeof r==='string') return err(r); await enter(r); } });
lb.addEventListener('keydown',e=>{ if(e.key==='Enter') $('[data-act=go],[data-act=create]',lb)?.click(); });
lg.addEventListener('contextmenu',e=>e.preventDefault());

/* ================= spotlight ================= */
const sp=$('#sp'), spi=$('#spi'), spr=$('#spr'); let spSel=0, spList=[];
const cmds=()=>[{t:'files',i:'folder',k:'app',f:()=>launch('files')},{t:'text editor',i:'text',k:'app',f:()=>launch('text')},{t:'settings',i:'gear',k:'app',f:()=>launch('settings')},
  {t:'toggle dark / light',i:'moon',f:()=>setTheme(root.dataset.theme==='dark'?'light':'dark')},{t:'toggle minimal theme',i:'sq',f:()=>setTheme(S.theme==='minimal'?S.last:'minimal')},{t:'next wallpaper',i:'image',f:nextWall},
  {t:'new folder on desktop',i:'folder',f:()=>newFolder(deskId())},{t:'new text file on desktop',i:'text',f:()=>newTextFile(deskId())},{t:'open trash',i:'trash',f:()=>launch('files',{dir:'trash'})},
  {t:'lock screen',i:'lock',k:'ctrl l',f:lockNow},{t:'sign out',i:'logout',f:logout},{t:'restart',i:'refresh',f:restart},{t:'shut down',i:'power',f:shutdown}];
function drawSp(){ const q=spi.value.toLowerCase().trim(); spList=cmds().filter(c=>c.t.includes(q));
  if(q) spList=spList.concat([...FS.values()].filter(r=>!r.trash&&r.name.toLowerCase().includes(q)).slice(0,8).map(r=>({t:r.name,i:kindIcon(r),k:fsPath(r.parent).map(p=>p.name).join('/')||'home',f:()=>openItem(r)})));
  spSel=Math.min(spSel,Math.max(0,spList.length-1)); spr.innerHTML=spList.length?spList.map((c,i)=>`<div class="sp-item ${i===spSel?'sel':''}" data-i="${i}">${ic(c.i)}<span>${esc(c.t)}</span>${c.k?`<span class="k">${esc(c.k)}</span>`:''}</div>`).join(''):'<div class="empty">no results</div>'; spr.querySelector('.sel')?.scrollIntoView({block:'nearest'}); }
function spotlight(){ if(!U||locked) return; closePanels(); closeCtx(); spi.value=''; spSel=0; drawSp(); sp.classList.add('show'); setTimeout(()=>spi.focus(),30); }
const closeSp=()=>{ sp.classList.remove('show'); spi.blur(); };
const runSp=i=>{ const c=spList[i]; if(!c) return; closeSp(); setTimeout(c.f,160); };
spi.oninput=()=>{ spSel=0; drawSp(); };
spi.onkeydown=e=>{ if(e.key==='ArrowDown'){ e.preventDefault(); spSel=Math.min(spList.length-1,spSel+1); drawSp(); } else if(e.key==='ArrowUp'){ e.preventDefault(); spSel=Math.max(0,spSel-1); drawSp(); } else if(e.key==='Enter') runSp(spSel); };
spr.onclick=e=>{ const it=e.target.closest('.sp-item'); if(it) runSp(+it.dataset.i); };
spr.onpointermove=e=>{ const it=e.target.closest('.sp-item'); if(it&&+it.dataset.i!==spSel){ spSel=+it.dataset.i; $$('.sp-item',spr).forEach((n,i)=>n.classList.toggle('sel',i===spSel)); } };
sp.addEventListener('pointerdown',e=>{ if(e.target===sp) closeSp(); });
function nextWall(){ const ks=Object.keys(WP); if(S.cwp){ S.cwp=null; applyCustomWp(); } setWp(ks[(ks.indexOf(S.wp)+1)%ks.length]); toast('image','wallpaper: '+WP[S.wp].n); }
function restart(){ $('#off svg').style.display='none'; $('#off').classList.add('on'); setTimeout(()=>location.reload(),1100); }
function shutdown(){ $('#off svg').style.display=''; $('#off').classList.add('on'); }
$('#pwr').onclick=restart;

/* ================= menus: logo, desktop, bar ================= */
$('#logo').innerHTML=ic('logo')+'<span>gallium</span>';
$('#bellic').innerHTML=ic('bell');
$('#logo').onclick=e=>{ e.stopPropagation(); closePanels(); const r=e.currentTarget.getBoundingClientRect(); showCtx(r.left,r.bottom+6,[{t:'about galliumOS',i:'info',f:()=>launch('settings',{sec:'about'})},{t:'settings',i:'gear',f:()=>launch('settings')},{t:'search',i:'search',k:'ctrl k',f:spotlight},'-',{t:'lock screen',i:'lock',k:'ctrl l',f:lockNow},{t:'sign out',i:'logout',f:logout},{t:'restart',i:'refresh',f:restart},{t:'shut down',i:'power',f:shutdown}]); };
const desktopMenu=()=>{ const d=deskId(); return [...folderMenu(d),'-',{h:'widgets'},...Object.entries(WID).map(([k,v])=>({t:(S.widgets[k]?.on?'hide ':'show ')+v.n,i:'widgets',f:()=>toggleWidget(k)})),'-',
  {t:'next wallpaper',i:'image',f:nextWall},{t:'search',i:'search',k:'ctrl k',f:spotlight},{t:'settings',i:'gear',f:()=>launch('settings')},{t:'lock screen',i:'lock',k:'ctrl l',f:lockNow}]; };
document.addEventListener('contextmenu',e=>{ e.preventDefault(); if(!U||locked) return; closePanels();
  if(e.target.closest('#bar')) return showCtx(e.clientX,e.clientY,[{t:'settings',i:'gear',f:()=>launch('settings')},{t:'toggle dark / light',i:'moon',f:()=>setTheme(root.dataset.theme==='dark'?'light':'dark')}]);
  const w=e.target.closest('.win'); if(w){ const W_=[...WINS].find(x=>x.el===w); return showCtx(e.clientX,e.clientY,[{t:'minimize',i:'min',f:()=>W_.minimize()},{t:'maximize / restore',i:'sq',f:()=>W_.max()},{t:'close',i:'x',f:()=>W_.close()}]); }
  if(e.target.closest('#dock,#login,.dlg')) return; showCtx(e.clientX,e.clientY,desktopMenu()); });

/* ================= keys + cursor ================= */
addEventListener('keydown',e=>{ const mod=e.ctrlKey||e.metaKey, k=e.key.toLowerCase();
  if(!U){ return; } if(mod&&k==='l'){ e.preventDefault(); lockNow(); return; } if(locked) return;
  if(mod&&k==='k'){ e.preventDefault(); spotlight(); return; } if(e.key==='Escape'){ closeCtx(); closePanels(); closeSp(); }
  if(e.target===document.body&&(!focusWin||focusWin.min)&&dsel.size){ const ids=[...dsel];
    if(k==='delete'){ fsTrash(ids); dsel=new Set(); toast('trash','moved to trash'); } else if(k==='f2'&&ids.length===1) renameDlg(FS.get(ids[0])); else if(mod&&(k==='c'||k==='x')){ CLIP.ids=ids; CLIP.cut=k==='x'; } }
  if(e.target===document.body&&mod&&k==='v') paste(deskId()); });
const cur=$('#cur'); let px=-100,py=-100,cx2=-100,cy2=-100;
const HOV='.chip,.tile,.dk,.mi,.tl b,.mini,.sp-item,.nit,.cgrid span:not(.h),button,.pl,.fi,.lnk,.av.btn2,.sw,#pwr,.crumbs span,.ib,.wpg button,.vnav,[data-go]';
addEventListener('pointermove',e=>{ if(e.pointerType==='touch') return; px=e.clientX; py=e.clientY; mx=px/innerWidth; my=py/innerHeight; document.body.classList.toggle('nocur',!!S&&!S.cursor);
  const t=e.target.closest?.('input:not([type=range]):not([type=checkbox]),textarea'), el=e.target.closest?.(HOV+',input[type=range]'); cur.classList.toggle('text',!!t); cur.classList.toggle('hover',!!el&&!t); });
document.addEventListener('mouseleave',()=>document.body.classList.add('nocur'));
addEventListener('pointerdown',()=>cur.classList.add('down')); addEventListener('pointerup',()=>cur.classList.remove('down'));
(function loop(){ cx2+=(px-cx2)*.35; cy2+=(py-cy2)*.35; cur.style.transform=`translate(${cx2}px,${cy2}px)`; requestAnimationFrame(loop); })();
document.addEventListener('dragstart',e=>{ if(!e.target.closest?.('.fi')) e.preventDefault(); });

/* ================= boot ================= */
(async function init(){
  root.dataset.theme=localStorage.getItem('g.theme')||'dark'; ckA=new Ascii($('#ckA')); ckS=new Ascii($('#ckS'));
  buildDock(); buildQS(); paintNet(); drawNotes(); await idb(); size(); requestAnimationFrame(frame);
  tick(); setInterval(tick,1000); setInterval(()=>{ if($('#nc').classList.contains('show')) drawNotes(); },30000);
  if(navigator.getBattery) navigator.getBattery().then(b=>{ paintBattery(b); ['levelchange','chargingchange','chargingtimechange','dischargingtimechange'].forEach(ev=>b.addEventListener(ev,()=>paintBattery(b))); }).catch(()=>paintBattery(null)); else paintBattery(null);
  addEventListener('online',()=>{ paintNet(); toast('wifi','back online'); }); addEventListener('offline',()=>{ paintNet(); toast('wifioff','you are offline'); }); navigator.connection?.addEventListener?.('change',paintNet);
  setTimeout(()=>{ $('#boot').classList.add('done'); showLogin('auto'); },2600);
})();

}

const PAGE = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>galliumOS</title>
<meta name="theme-color" content="#050505">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23111'/%3E%3Ccircle cx='16' cy='16' r='7' fill='none' stroke='%23fff' stroke-width='2.5'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..700&family=Spline+Sans+Mono:wght@300..700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
${BODY}
<script>var __name=function(f){return f};(${client.toString()})();</script>
</body>
</html>`;

export default {
  async fetch() {
    return new Response(PAGE, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      },
    });
  },
};
