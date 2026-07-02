// Verify PR #753 / issue #748: dashboard "Last 7 Days" counts running activities.
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
await new Promise((r) => setTimeout(r, 1000))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/31-dashboard-workouts.png', fullPage: true })

// Extract the Workouts card's number + min total
const summary = await page.evaluate(() => {
  const text = document.body.innerText
  const match = (re) => (text.match(re) || [])[0]
  return {
    workouts_line: match(/[\s\S]{0,30}Workouts[\s\S]{0,40}/),
    avg_sleep_line: match(/[\s\S]{0,30}Avg Sleep[\s\S]{0,40}/),
  }
})
console.log(JSON.stringify(summary, null, 2))

await browser.close()
