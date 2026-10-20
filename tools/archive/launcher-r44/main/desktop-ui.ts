import { BrowserWindow } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export async function runDesktopUi(directory: string) {
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const content = window.webContents;
  const evaluate = (script: string) => content.executeJavaScript(script, true);
  const wait = async (script: string) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (await evaluate(script)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error("UI acceptance deadline: " + script + " | " + (await evaluate("document.body.innerText.slice(0,1500)")));
  };
  const navigate = async (index: number) => { await evaluate("document.querySelectorAll('nav button')[" + index + "].click()"); await new Promise(resolve => setTimeout(resolve, 30)); };
  const choose = async (scenario: string) => {
    await navigate(0);
    await evaluate("(() => { const select=document.querySelector('#demo-scenario');select.value=" + JSON.stringify(scenario) + ";select.dispatchEvent(new Event('change',{bubbles:true})); })();");
    await wait("window.__launcherFixture.currentScenario === " + JSON.stringify(scenario));
    await wait("!!document.querySelector('.demo-banner')");
  };
  const input = async (selector: string, value: string) => {
    await evaluate("(() => { const node=document.querySelector(" + JSON.stringify(selector) + ");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node," + JSON.stringify(value) + ");node.dispatchEvent(new Event('input',{bubbles:true})); })();");
  };
  const clickText = (text: string) => evaluate("(() => {const node=[...document.querySelectorAll('button')].find(b=>b.textContent.toLowerCase().includes(" + JSON.stringify(text.toLowerCase()) + "));if(!node)throw new Error('Missing button: '+" + JSON.stringify(text) + ");node.click();})();");
  const cases: string[] = [];
  try {
    await window.loadURL("app://local/acceptance/index.html");
    await wait("!!window.__launcherFixture && !!document.querySelector('#demo-scenario')");
    assert.equal(await evaluate("document.querySelectorAll('nav button:not(.nav-hidden)').length"), 3);
    await evaluate("window.__launcherFixture.execute({requestId:'fixture-locale',type:'settings.update',payload:{expectedRevision:1,patch:{language:'en'}}})");
    await wait("document.documentElement.lang === 'en'");
    assert.equal(await evaluate("document.querySelectorAll('#demo-scenario option').length"), 10);
    assert.match(await evaluate("document.querySelector('#demo-scenario option').textContent"), /First run/i);
    const scenarios = ["first_run","login_required","signed_in_route_unsupported","connection_ready_no_sessions","turn_generating_tools","cancel_requested","config_conflict_or_model_unavailable","runtime_disconnected","browser_ui_changed_context_too_large","outcome_unknown_write"];
    for (const scenario of scenarios) {
      await choose(scenario);
      const surface = await evaluate("window.__launcherFixture.getSnapshot()");
      assert.equal(surface.mode, "demo");
      assert.ok(await evaluate("document.querySelector('.demo-banner').innerText.includes('Demo')"));
      if (scenario === "first_run") {
        assert.equal(surface.account.state, "unknown"); await navigate(1);
        await wait("document.querySelector('.onboarding-view').innerText.toLowerCase().includes('not signed in') && document.querySelector('[data-action=native-e2e]').disabled");
      }
      if (scenario === "login_required") { await navigate(1); await wait("document.body.innerText.toLowerCase().includes('action required')"); }
      if (scenario === "signed_in_route_unsupported") {
        assert.equal(surface.account.state, "signed_in"); assert.equal(surface.integration.state, "unsupported");
        await wait("[...document.querySelectorAll('.overview-view .badge')].some(node=>node.textContent==='unsupported') && [...document.querySelectorAll('.overview-view .badge')].some(node=>node.textContent==='signed_in')");
        await navigate(1); await wait("document.querySelector('[data-action=native-e2e]').disabled && document.querySelector('.onboarding-view').innerText.toLowerCase().includes('signed in')");
      }
      if (scenario === "connection_ready_no_sessions") { await navigate(2); await wait("document.body.innerText.includes('No active sessions')"); }
      if (scenario === "turn_generating_tools") {
        await navigate(2); await wait("document.body.innerText.toLowerCase().includes('tool_running')");
        await clickText("Cancel Turn"); await wait("document.body.innerText.includes('Cancellation requested')");
        await evaluate("window.__launcherFixture.finishCancel(true)");
        await wait("document.body.innerText.toLowerCase().includes('cancel_confirmed')");
        await choose(scenario); await navigate(2); await clickText("Cancel Turn");
        await wait("document.body.innerText.includes('Cancellation requested')");
        await evaluate("window.__launcherFixture.finishCancel(false)");
        await wait("document.body.innerText.includes('SERVICE_UNAVAILABLE') && [...document.querySelectorAll('button')].some(b=>b.textContent.includes('Cancel Turn'))");
      }
      if (scenario === "cancel_requested") { await navigate(2); await wait("document.body.innerText.includes('Cancellation requested')"); assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Cancel Turn'))"), false); }
      if (scenario === "config_conflict_or_model_unavailable") {
        assert.equal(surface.integration.state, "conflict"); await navigate(4);
        assert.equal(await evaluate("document.querySelector('#settings-model').disabled"), true);
      }
      if (scenario === "runtime_disconnected") {
        await wait("!!document.querySelector('.disconnect-banner')");
        assert.equal(await evaluate("document.querySelector('.view-controls').disabled"), true);
        await evaluate("window.__launcherFixture.recover()"); await clickText("Try Reconnect");
        await wait("!document.querySelector('.disconnect-banner') && !document.querySelector('.view-controls').disabled");
      }
      if (scenario === "browser_ui_changed_context_too_large") { assert.equal(surface.browser.state, "failed"); await navigate(2); await wait("document.body.innerText.includes('CONTEXT_TOO_LARGE')"); }
      if (scenario === "outcome_unknown_write") {
        await navigate(2); await wait("document.body.innerText.includes('outcome_unknown')");
        assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>/retry all/i.test(b.textContent))"), false);
        await clickText("View Activity"); await wait("document.querySelector('#activity-session')?.value === 'syn-ws-1'");
      }
      cases.push(scenario);
    }
    await choose("connection_ready_no_sessions"); await navigate(4);
    await evaluate("window.__launcherFixture.failures.settings=true");
    await evaluate("(() => {const select=document.querySelector('#settings-theme');select.value='dark';select.dispatchEvent(new Event('change',{bubbles:true}));})();");
    await evaluate("document.querySelector('[data-action=settings-save]').click()");
    await wait("document.body.innerText.includes('SERVICE_UNAVAILABLE')");
    assert.equal(await evaluate("document.querySelector('#settings-theme').value"), "dark");
    await evaluate("window.__launcherFixture.failures.settings=false;document.querySelector('[data-action=settings-discard]').click()");
    await evaluate("window.__launcherFixture.activities=Array.from({length:60},(_,i)=>({id:'fixture-row-'+i,at:new Date().toISOString(),severity:i%2?'warning':'info',category:'fixture',summary:'OWNED_ACTIVITY_'+i,sessionId:i%2?'fast':'slow',correlationId:'owned-correlation-'+i}))");
    await navigate(3); await wait("document.querySelectorAll('tbody tr').length===50");
    await clickText("Load More"); await wait("document.querySelectorAll('tbody tr').length===60");
    await evaluate("(() => {const select=document.querySelector('#activity-severity');select.value='warning';select.dispatchEvent(new Event('change',{bubbles:true}));})();");
    await wait("document.querySelectorAll('tbody tr').length===30");
    await evaluate("(() => {const select=document.querySelector('#activity-severity');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));})();");
    await input("#activity-session", "slow");
    await wait("window.__launcherFixture.activityQueries.includes('slow')");
    await input("#activity-session", "fast");
    await wait("window.__launcherFixture.activityQueries.includes('fast')");
    await wait("document.querySelectorAll('tbody tr').length===30");
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await evaluate("document.querySelector('#activity-session').value"), "fast");
    assert.equal(await evaluate("[...document.querySelectorAll('tbody tr')].every(row=>Number(row.querySelector('td:nth-child(4)').textContent.replace('OWNED_ACTIVITY_',''))%2===1)"), true);
    await evaluate("window.__launcherFixture.failures.activity=true"); await clickText("Reload");
    await wait("!!document.querySelector('[role=alert]') && document.body.innerText.includes('SERVICE_UNAVAILABLE')");
    await evaluate("window.__launcherFixture.failures.activity=false"); await clickText("Reload");
    await wait("!document.querySelector('[role=alert]')");
    await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('owned fixture denied clipboard'))}})");
    await clickText("Copy"); await wait("document.body.innerText.includes('Could not copy correlation ID')");
    await evaluate("window.__launcherFixture.failures.export=true"); await clickText("Export Safe Log");
    await wait("document.body.innerText.includes('CANCELLED')");
    await choose("turn_generating_tools"); await evaluate("window.__launcherFixture.longWorkspace()");
    await navigate(2);
    const layouts = [];
    for (const [width,height] of [[1280,800],[1024,720],[800,600]]) {
      window.setContentSize(width!,height!);
      await wait("innerWidth==="+width+" && innerHeight==="+height);
      const layout = await evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth,content:document.querySelector('.app-content').getBoundingClientRect().width})");
      assert.ok(layout.scroll<=layout.width); layouts.push(layout);
    }
    await navigate(4);
    const surfaceContrast: any[] = [];
    for (const storedTheme of ["light","dark"]) {
      const prefs = await evaluate("window.__launcherFixture.getSnapshot()");
      await evaluate("window.__launcherFixture.execute({requestId:" + JSON.stringify("fixture-contrast-"+storedTheme) + ",type:'settings.update',payload:{expectedRevision:" + prefs.settings.revision + ",patch:{theme:" + JSON.stringify(storedTheme) + "}}})");
      await wait("document.documentElement.getAttribute('data-theme') === 'light'");
      for (const scenario of ["login_required","signed_in_route_unsupported","connection_ready_no_sessions","turn_generating_tools"]) {
        await choose(scenario);
        for (const view of [0,1,2,4]) {
          await navigate(view);
          await new Promise(resolve=>setTimeout(resolve,200)); // measure settled CSS rather than an in-flight color transition
          await evaluate("document.getAnimations().forEach(animation => animation.finish())");
          const pairs = await evaluate(`(() => {
            const rgba = text => (text.match(/[\\d.]+/g)||[]).map(Number);
            const background = node => { for(let current=node;current;current=current.parentElement){const color=rgba(getComputedStyle(current).backgroundColor);if(color.length>=3&&(color.length===3||color[3]>0.99))return color.slice(0,3);}return [255,255,255]; };
            const luminance = color => color.map(v=>v/255).map(v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
            return [...document.querySelectorAll('button,select,input,label,.badge,.alert,.demo-banner span')].filter(node=>node.getBoundingClientRect().height>0&&!node.matches(':disabled')).map(node=>{
              const style=getComputedStyle(node),fg=rgba(style.color).slice(0,3),bg=background(node);
              let opacity=1;for(let current=node;current;current=current.parentElement)opacity*=Number(getComputedStyle(current).opacity);
              const ink=fg.map((v,i)=>v*opacity+bg[i]*(1-opacity)),a=luminance(ink),b=luminance(bg);
              return {tag:node.tagName,classes:node.className,text:node.textContent.slice(0,60),color:style.color,background:getComputedStyle(node).backgroundColor,resolvedBackground:bg,opacity,ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};
            });
          })()`);
          for(const pair of pairs){assert.ok(pair.ratio>=4.5,"light "+JSON.stringify(pair));surfaceContrast.push({theme:"light",storedTheme,scenario,view,...pair});}
          if(scenario==="turn_generating_tools" && view===2){
            const point=await evaluate("(() => {const node=document.querySelector('button.danger');node.scrollIntoView({block:'center'});const rect=node.getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};})()");
            content.sendInputEvent({type:"mouseMove",...point});
            await wait("document.querySelector('button.danger').matches(':hover')");
            await evaluate("document.getAnimations().forEach(animation=>animation.finish())");
            const hover=await evaluate(`(() => {
              const node=document.querySelector('button.danger'),style=getComputedStyle(node);
              const luminance=text=>(text.match(/[\\d.]+/g)||[]).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
              const a=luminance(style.color),b=luminance(style.backgroundColor);
              return {text:node.textContent,color:style.color,background:style.backgroundColor,ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05),hover:true};
            })()`);
            assert.ok(hover.ratio>=4.5,"light danger hover "+JSON.stringify(hover));surfaceContrast.push({theme:"light",storedTheme,scenario,view,...hover});
            content.sendInputEvent({type:"mouseMove",x:0,y:0});
            await wait("!document.querySelector('button.danger').matches(':hover')");
            await evaluate("document.getAnimations().forEach(animation=>animation.finish())");
            window.showInactive(); // ensure the visible compositor repaints after the hover state changed
            await new Promise(resolve=>setTimeout(resolve,100));
            await content.capturePage(); await new Promise(resolve=>setTimeout(resolve,100));
            fs.writeFileSync(path.join(directory,"launcher-fixture-tools-"+(storedTheme==="dark"?"stored-dark-light":storedTheme)+".png"),(await content.capturePage()).toPNG());
            window.hide();
          }
        }
      }
    }
    await choose("connection_ready_no_sessions");await navigate(4);
    content.debugger.attach("1.3");
    await content.debugger.sendCommand("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"},{name:"prefers-reduced-motion",value:"reduce"}]});
    const preference = await evaluate("window.__launcherFixture.getSnapshot()");
    await evaluate("window.__launcherFixture.execute({requestId:'fixture-system-theme',type:'settings.update',payload:{expectedRevision:" + preference.settings.revision + ",patch:{theme:'system'}}})");
    await wait("document.documentElement.getAttribute('data-theme')==='light' && matchMedia('(prefers-color-scheme: dark)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches");
    assert.equal(await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()"), "#ffffff");
    const motion = await evaluate("[...document.querySelectorAll('button,select,input')].map(node=>({tag:node.tagName,transition:getComputedStyle(node).transitionDuration,animation:getComputedStyle(node).animationDuration}))");
    const durations = (value: string) => value.split(',').map(part => parseFloat(part) * (part.trim().endsWith('ms') ? 1 : 1000));
    assert.ok(motion.length>0);
    for(const node of motion) for(const duration of [...durations(node.transition),...durations(node.animation)]) assert.ok(duration<=0.011,"Reduced motion was not applied: "+JSON.stringify(node));
    await navigate(0);
    window.show(); window.focus(); content.focus();
    await wait("document.hasFocus()");
    // Focus the first navigation item as the starting point; Tab/Enter must then work through Chromium input.
    await evaluate("document.querySelector('nav button').focus()");
    content.sendInputEvent({type:"keyDown",keyCode:"Tab"});content.sendInputEvent({type:"keyUp",keyCode:"Tab"});
    await wait("document.activeElement===document.querySelectorAll('nav button')[2] && document.activeElement.matches(':focus-visible')");
    const keyboard = await evaluate("({tag:document.activeElement.tagName,text:document.activeElement.textContent,shadow:getComputedStyle(document.activeElement).boxShadow,outline:getComputedStyle(document.activeElement).outlineStyle})");
    assert.equal(keyboard.tag,"BUTTON"); assert.ok(keyboard.shadow!=="none" || keyboard.outline!=="none","Focused control has no visible focus indicator");
    content.sendInputEvent({type:"keyDown",keyCode:"Enter"});content.sendInputEvent({type:"char",keyCode:"\r"});content.sendInputEvent({type:"keyUp",keyCode:"Enter"});
    await wait("document.body.innerText.includes('Sessions & Tasks') && document.querySelectorAll('nav button')[2].classList.contains('active')");
    await navigate(4);
    assert.ok(await evaluate("document.querySelectorAll('select,input').length>=4"));
    assert.equal(await evaluate("[...document.querySelectorAll('select,input')].every(node=>!!document.querySelector('label[for='+node.id+']'))"), true);
    fs.writeFileSync(path.join(directory,"desktop-ui.json"),JSON.stringify({fixtureOnly:true,scenarios:cases,englishScenarioLabels:true,cancelConfirmed:true,cancelFailed:true,offlineReconnect:true,settingsWriteFailureDraft:true,activityPagination:true,activityFiltersAndRace:true,activityFailureRecovery:true,clipboardFailure:true,exportCancellation:true,longTextLayouts:layouts,surfaceContrast,systemDark:true,reducedMotion:motion,keyboardFocus:keyboard,keyboardNavigationActivated:true,formLabels:true},null,2));
  } finally { if(content.debugger.isAttached())content.debugger.detach();window.close(); }
}
