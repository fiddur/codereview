// Verify PR #765: quick-log strip stays visible after a meal exists
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

// Go to today's meals page
await page.goto('http://localhost:8080/meals', { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 1500))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/41-meals-initial.png', fullPage: true })

// Inspect: do we see Banana/Yogurt suggestions in the lunch slot strip?
const initial = await page.evaluate(() => {
  const txt = document.body.innerText
  return {
    hasIncludedLabel: /Included:/.test(txt),
    hasAddLabel: /Add:/.test(txt),
    hasBanana: /Banana/.test(txt),
    hasYogurt: /Yogurt/.test(txt),
    hasLunch: /Lunch/.test(txt),
  }
})
console.log('initial state:', JSON.stringify(initial, null, 2))

// Click Banana suggestion chip in the Lunch slot to log it
const clickedBanana = await page.evaluate(() => {
  const chips = Array.from(document.querySelectorAll('.frequent-chip'))
  const banana = chips.find((c) => /Banana/.test(c.textContent || ''))
  if (banana) { banana.click(); return true }
  return false
})
console.log('clicked banana chip:', clickedBanana)
await new Promise((r) => setTimeout(r, 2000))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/42-meals-after-log.png', fullPage: true })

// After logging, expect strip still visible with "Included:" (Banana) and "Add:" (Yogurt only)
const afterLog = await page.evaluate(() => {
  const txt = document.body.innerText
  // count "Banana" vs "Yogurt" occurrences in main content
  return {
    text_dump: txt.slice(0, 2000),
    hasIncludedLabel: /Included:/.test(txt),
    hasAddLabel: /Add:/.test(txt),
    bananaCount: (txt.match(/Banana/g) || []).length,
    yogurtCount: (txt.match(/Yogurt/g) || []).length,
    hasStripStill: document.querySelector('.frequent-meals-strip') !== null,
    hasQuickLogRow: document.querySelector('.quick-log-row') !== null,
  }
})
console.log('after-log state:', JSON.stringify({
  hasIncludedLabel: afterLog.hasIncludedLabel,
  hasAddLabel: afterLog.hasAddLabel,
  bananaCount: afterLog.bananaCount,
  yogurtCount: afterLog.yogurtCount,
  hasStripStill: afterLog.hasStripStill,
  hasQuickLogRow: afterLog.hasQuickLogRow,
}, null, 2))

await browser.close()
