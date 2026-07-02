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
// click Banana
await page.evaluate(() => {
  const chips = Array.from(document.querySelectorAll('.frequent-chip'))
  const b = chips.find((c) => /Banana/.test(c.textContent || ''))
  if (b) b.click()
})
await new Promise((r) => setTimeout(r, 2500))

// find Lunch slot, dump its HTML
const lunchHtml = await page.evaluate(() => {
  // Find element containing "Lunch" header
  const headers = Array.from(document.querySelectorAll('h2, h3, .slot-header, .meal-slot-header'))
  let slot = null
  for (const h of headers) {
    if (/^Lunch$/i.test((h.textContent || '').trim())) {
      // find slot wrapper
      let el = h
      while (el && el.parentElement && !el.classList.contains('meal-slot-row') && !el.classList.contains('slot')) {
        el = el.parentElement
      }
      slot = el
      break
    }
  }
  if (!slot) {
    const allSlots = document.querySelectorAll('.meal-slot-row, .slot, [class*="slot"]')
    return { found: false, slotsCount: allSlots.length, sample: allSlots[0]?.outerHTML?.slice(0, 2000) }
  }
  return { found: true, html: slot.outerHTML.slice(0, 6000) }
})
console.log(JSON.stringify(lunchHtml, null, 2))
await browser.close()
