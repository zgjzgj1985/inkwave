// A phone that has EVER picked a quality tier must still get the touch defaults for everything it did not choose.
import puppeteer from 'puppeteer-core';
import { chromePath, gpuArgs } from './chrome.mjs';
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const run = async (stored, label) => {
  const b = await puppeteer.launch({ executablePath: chromePath(), headless: 'new',
    args: gpuArgs(['--window-size=915,412']), defaultViewport: { width: 915, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
  const p = await b.newPage();
  await p.evaluateOnNewDocument((s) => { try { localStorage.setItem('inkwave.settings', JSON.stringify(s)); } catch (e) {} }, stored);
  await p.goto('http://localhost:8492/?nofullscreen', { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 40; i++) { await sleep(1000); if (await p.evaluate(() => !!window.__inkwave?.settings).catch(() => false)) break; }
  const s = await p.evaluate(() => { const st = window.__inkwave.settings; return { touch: window.__inkwave.touchMode, quality: st.quality, shadows: st.shadows, qc: st.qualityChosen, sc: st.shadowsChosen }; });
  console.log(`  ${label.padEnd(42)} touch=${s.touch} quality=${s.quality} shadows=${s.shadows} chosen(q/s)=${s.qc}/${s.sc}`);
  await b.close();
  return s;
};
// The bug: picking a quality (even low) used to drag shadows back on.
const a = await run({ touchControls: 'on', quality: 'low', qualityChosen: true, shadows: true }, 'phone that picked "low" in settings');
console.log(`  -> shadows must be false here: ${a.shadows === false ? 'PASS' : 'FAIL'}`);
const c = await run({ touchControls: 'on', quality: 'low', qualityChosen: true, shadows: true, shadowsChosen: true }, 'phone that picked BOTH low and shadows on');
console.log(`  -> a deliberate shadows pick must survive: ${c.shadows === true ? 'PASS' : 'FAIL'}`);
const d = await run({ touchControls: 'on', quality: 'high', qualityChosen: true, shadows: true }, 'phone that picked "high" quality');
console.log(`  -> quality pick honoured: ${d.quality === 'high' ? 'PASS' : 'FAIL'}`);
