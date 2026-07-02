import puppeteer from 'puppeteer-core'

const SHOTS = '/tmp/aurboda-tryout/shots'
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
const errors = []
page.on('console', (msg) => {
  const t = msg.type()
  if (t === 'error' || t === 'warning') errors.push(`[browser ${t}] ${msg.text()}`)
})
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`))
page.on('requestfailed', (req) => errors.push(`[reqfail] ${req.url()} ${req.failure()?.errorText}`))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const visit = async (path, name) => {
  console.log(`▶ ${path}`)
  await page.goto(`http://localhost:8080${path}`, { waitUntil: 'networkidle0' }).catch(() => {})
  await sleep(800) // let charts/queries render
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
}

// Login
await page.goto('http://localhost:8080/login', { waitUntil: 'networkidle0' })
await page.type('input#user', 'qsreddit_demo')
await page.type('input#pass', 'demopassword123!')
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null),
  page.click('button[type="submit"]'),
])

await visit('/', '10-dashboard')
await visit('/timeline', '11-timeline')
await visit('/sleep', '12-sleep')
await visit('/data', '13-data')
await visit('/chart', '14-chart')
await visit('/places', '15-places')
await visit('/correlations', '16-correlations')
await visit('/goals', '17-goals')
await visit('/data-sources', '18-data-sources')
await visit('/settings', '19-settings')
await visit('/admin', '20-admin')

// Check what links exist on Dashboard "+ Add"
await page.goto('http://localhost:8080/', { waitUntil: 'networkidle0' })
await sleep(300)
// follow the "+ Add" sidebar link
const navAdd = await page.evaluate(() => {
  const a = [...document.querySelectorAll('a')].find((el) => el.textContent?.includes('+ Add') || el.textContent?.trim() === 'Add')
  if (a) { return a.href }
  return null
})
console.log('+ Add href:', navAdd)
if (navAdd) {
  await page.goto(navAdd, { waitUntil: 'networkidle0' })
  await sleep(400)
  await page.screenshot({ path: `${SHOTS}/21-add.png`, fullPage: true })
}

console.log('--- console issues during tour ---')
for (const e of errors) console.log(e)

await browser.close()
