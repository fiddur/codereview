// Verify PR #757 / issue #746: "0.0" → "No data" on dashboard & /sleep
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: true,
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
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/39-dashboard-placeholder.png', fullPage: true })

const dashHits = await page.evaluate(() => {
  const txt = document.body.innerText
  return {
    sleep_score: (txt.match(/Sleep Score[\s\S]{0,40}/) || [])[0],
    readiness: (txt.match(/Readiness Score[\s\S]{0,40}/) || [])[0],
    zone2: (txt.match(/Zone 2 \(Weekly\)[\s\S]{0,60}/) || [])[0],
  }
})
console.log('dashboard:', JSON.stringify(dashHits, null, 2))

await page.goto('http://localhost:8080/sleep', { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 1000))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/40-sleep-placeholder.png', fullPage: true })

const sleepHits = await page.evaluate(() => {
  const txt = document.body.innerText
  return {
    sleep_score: (txt.match(/Sleep Score[\s\S]{0,40}/) || [])[0],
    efficiency: (txt.match(/Efficiency[\s\S]{0,40}/) || [])[0],
    latency: (txt.match(/Latency[\s\S]{0,40}/) || [])[0],
    duration: (txt.match(/Duration[\s\S]{0,40}/) || [])[0],
  }
})
console.log('/sleep:', JSON.stringify(sleepHits, null, 2))

await browser.close()
