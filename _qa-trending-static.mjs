import { chromium } from './qa-support.mjs';
const b = await chromium.launch({headless:true});
const p = await b.newPage({viewport:{width:390,height:844}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto('http://127.0.0.1:18880/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(8000);
const home = await p.evaluate(()=>{
  const cards=[...document.querySelectorAll('#trending-list .trend-card')];
  return {
    hidden:document.querySelector('#trending')?.hidden,
    cards:cards.length,
    first:cards[0]?.innerText.replace(/\n/g,' / '),
    ranks:cards.slice(0,5).map(c=>c.querySelector('.trend-rank')?.textContent),
    note:document.querySelector('#trending-updated')?.textContent,
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
  };
});
// 点第一张热门卡，确认跳到搜索并带查询词
await p.click('#trending-list .trend-card').catch(e=>errs.push('click:'+e.message));
await p.waitForTimeout(2000);
const after = await p.evaluate(()=>({hash:location.hash, query:document.querySelector('#query')?.value, view:document.querySelector('#home-view')?.hidden}));
console.log(JSON.stringify({home,after,errs},null,2));
await b.close();
