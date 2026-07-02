import puppeteer from 'puppeteer-core'
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
await page.goto('http://localhost:8080/login', { waitUntil: 'networkidle0' })
await page.type('input#user', 'qsreddit_demo')
await page.type('input#pass', 'demopassword123!')
await Promise.all([ page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(()=>null), page.click('button[type="submit"]') ])
await page.goto('http://localhost:8080/meals', { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 1500))

// Click Yogurt in "Add:" row (Banana should already be Included from previous test run)
const clicked = await page.evaluate(() => {
  const chips = Array.from(document.querySelectorAll('.frequent-chip'))
  const y = chips.find((c) => /Yogurt/.test(c.textContent || ''))
  if (y) { y.click(); return true }
  return false
})
console.log('clicked yogurt:', clicked)
await new Promise((r) => setTimeout(r, 2500))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/43-meals-after-append.png', fullPage: true })

const result = await page.evaluate(() => {
  const lunchRow = Array.from(document.querySelectorAll('.meal-slot-row')).find((r) => /Lunch/.test(r.textContent || ''))
  if (!lunchRow) return { found: false }
  const included = Array.from(lunchRow.querySelectorAll('.quick-log-row')).find((r) => /Included:/.test(r.textContent || ''))
  const add = Array.from(lunchRow.querySelectorAll('.quick-log-row')).find((r) => /Add:/.test(r.textContent || ''))
  return {
    found: true,
    includedChips: included ? Array.from(included.querySelectorAll('.food-item-chip')).map((c) => c.textContent.trim()) : [],
    addChips: add ? Array.from(add.querySelectorAll('.frequent-chip')).map((c) => c.textContent.trim()) : [],
    hasAdd: !!add,
  }
})
console.log(JSON.stringify(result, null, 2))
await browser.close()
