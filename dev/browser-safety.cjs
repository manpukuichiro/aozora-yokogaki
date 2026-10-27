// 実ブラウザの隔離コンテキストとループバックだけで検証する。公開しない。
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || '_site');
const server = http.createServer((req,res) => {
  const url = new URL(req.url,'http://localhost');
  const relative = decodeURIComponent(url.pathname).replace(/^\/(a|b)\//,'');
  const file = path.resolve(root,relative || 'index.html');
  if (!file.startsWith(root+path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'};
  res.setHeader('Content-Type',types[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext({});
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error' && /Content Security Policy/i.test(m.text())) errors.push(m.text());});
    const base='http://127.0.0.1:'+server.address().port;
    await page.goto(base+'/a/'); await page.locator('#home').waitFor({state:'visible'});
    await page.locator('#home-file-open').focus();
    const chooser=page.waitForEvent('filechooser'); await page.keyboard.press('Enter');
    await (await chooser).setFiles({name:'private-name.txt',mimeType:'text/plain',buffer:Buffer.from('確認作品\n確認著者\n\n本文です。\n第二段落です。')});
    await page.waitForFunction(()=>location.hash.startsWith('#book='));
    assert.equal(new URL(page.url()).search,'');
    assert.match(await page.locator('#text').innerText(),/本文です/);
    await page.reload(); await page.waitForFunction(()=>document.querySelector('#text').textContent.includes('本文です'));
    await page.locator('#home-link').click();
    await page.goto(base+'/b/'); await page.locator('#home').waitFor({state:'visible'});
    assert.equal(await page.locator('#home-shelf-section').isVisible(),false);
    await page.goto(base+'/a/'); await page.locator('#home').waitFor({state:'visible'});
    assert.equal(await page.locator('#home-shelf-section').isVisible(),true);
    // 容量不足等で保存できない場合に、表示中の警告へ到達する。
    await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError');};});
    await page.locator('#settings-toggle').click();
    await page.locator('[data-step="fontSize"][data-dir="1"]').click();
    assert.equal(await page.locator('#storage-warning').isVisible(),true);
    await page.reload(); await page.locator('#home').waitFor({state:'visible'});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(__dirname,'safety-mobile.png'),fullPage:true});
    await page.goto(base+'/a/?text=aozora_000773.txt');
    await page.waitForFunction(()=>document.querySelector('#text').textContent.length>1000);
    await page.screenshot({path:path.join(__dirname,'safety-reader.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS: keyboard import, hash URL, reload, path isolation, save failure notice, narrow layout, bundled text, CSP/JS errors');
  } finally { if(browser) await browser.close(); server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
