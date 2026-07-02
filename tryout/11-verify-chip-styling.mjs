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
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/44-meals-pr766.png', fullPage: true })

// Inspect chip styling: food-item-chip should be inline-flex with pill border-radius
const chipStyle = await page.evaluate(() => {
  const chip = document.querySelector('.food-item-chip')
  if (!chip) return { found: false }
  const cs = getComputedStyle(chip)
  return {
    found: true,
    text: chip.textContent.trim(),
    display: cs.display,
    borderRadius: cs.borderRadius,
    fontSize: cs.fontSize,
    height: chip.getBoundingClientRect().height,
  }
})
const freqStyle = await page.evaluate(() => {
  const chip = document.querySelector('.frequent-chip')
  if (!chip) return { found: false }
  return { found: true, height: chip.getBoundingClientRect().height }
})
console.log('food-item-chip:', JSON.stringify(chipStyle, null, 2))
console.log('frequent-chip:', JSON.stringify(freqStyle, null, 2))
await browser.close()
