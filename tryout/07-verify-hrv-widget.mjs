// Verify PR #755 / issue #747: dashboard HRV widget shows value.
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })

await page.goto('http://localhost:8080/login', { waitUntil: 'networkidle0' })
await page.type('input#user', 'qsreddit_demo')
await page.type('input#pass', 'demopassword123!')
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null),
  page.click('button[type="submit"]'),
])
await new Promise((r) => setTimeout(r, 1500))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/33-dashboard-hrv.png', fullPage: true })

const found = await page.evaluate(() => {
  const txt = document.body.innerText
  return {
    hrv_7day: (txt.match(/HRV \(7-day\)[\s\S]{0,80}/) || [])[0],
    hrv_30day: (txt.match(/HRV \(30-day\)[\s\S]{0,80}/) || [])[0],
  }
})
console.log(JSON.stringify(found, null, 2))

await browser.close()
