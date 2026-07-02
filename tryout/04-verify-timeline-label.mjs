// Verify PR #752 / issue #750: sleep label across midnight is no longer "ep".
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

await page.goto('http://localhost:8080/timeline', { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 1200))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/30-timeline-label-fixed.png', fullPage: true })

// Pull all visible SVG text inside the activity track so we can assert.
const labels = await page.evaluate(() => {
  const texts = [...document.querySelectorAll('svg text')]
  return texts.map((t) => ({ text: t.textContent, x: t.getBoundingClientRect().x.toFixed(0), w: t.getBoundingClientRect().width.toFixed(0) }))
    .filter((r) => r.text && r.text.length > 0)
})
console.log('SVG labels seen:')
for (const l of labels) console.log(' ', JSON.stringify(l))

await browser.close()
