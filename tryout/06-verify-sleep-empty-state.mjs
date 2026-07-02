// Verify PR #754 / issue #749: Sleep Score Trend empty-state wording.
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
await page.goto('http://localhost:8080/sleep', { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 1000))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/32-sleep-empty-state.png', fullPage: true })

const captures = await page.evaluate(() => {
  // Pull text of the Score Trend section + any link href visible nearby
  const sections = [...document.querySelectorAll('h2, h3')].filter((h) => /score trend/i.test(h.textContent || ''))
  const fromSection = sections.map((s) => {
    const card = s.closest('section, .card, div')
    return { heading: s.textContent, text: card?.innerText, links: [...(card?.querySelectorAll('a') || [])].map((a) => ({ text: a.textContent, href: a.getAttribute('href') })) }
  })
  return fromSection
})
console.log(JSON.stringify(captures, null, 2))

await browser.close()
