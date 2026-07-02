import puppeteer from 'puppeteer-core'
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1400, height: 1000 })
await page.goto('http://localhost:8080/login', { waitUntil: 'networkidle0' })
await page.type('input#user', 'qsreddit_demo')
await page.type('input#pass', 'demopassword123!')
await Promise.all([ page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(()=>null), page.click('button[type="submit"]') ])
// Visit meals overview tab (likely /meals with tab switch or /meals/overview)
await page.goto('http://localhost:8080/meals', { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 1500))
// Try clicking "Overview" tab if present
const switched = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button, a'))
  const o = btns.find((b) => /^Overview$/i.test((b.textContent || '').trim()))
  if (o) { o.click(); return true }
  return false
})
console.log('switched to overview:', switched)
await new Promise((r) => setTimeout(r, 1500))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/45-meals-overview-wide.png', fullPage: true })

const wideState = await page.evaluate(() => {
  const root = document.querySelector('.meals-overview')
  if (!root) return { found: false }
  const headers = Array.from(document.querySelectorAll('.overview-table thead th[data-window]')).map((th) => ({
    win: th.getAttribute('data-window'),
    active: th.getAttribute('data-active'),
    display: getComputedStyle(th).display,
  }))
  const markers = Array.from(document.querySelectorAll('.ref-range-marker-label')).map((l) => l.textContent)
  return {
    found: true,
    headers: headers.slice(0, 8),
    markerLabels: markers.slice(0, 8),
    hasDateNav: !!document.querySelector('.date-nav, [class*="date-nav" i]'),
  }
})
console.log('wide:', JSON.stringify(wideState, null, 2))

// Narrow viewport
await page.setViewport({ width: 600, height: 900 })
await new Promise((r) => setTimeout(r, 800))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/46-meals-overview-narrow.png', fullPage: true })
const narrowState = await page.evaluate(() => {
  const visible = Array.from(document.querySelectorAll('.overview-table thead th[data-window]'))
    .filter((th) => getComputedStyle(th).display !== 'none')
    .map((th) => th.getAttribute('data-window'))
  return {
    selectorVisible: getComputedStyle(document.querySelector('.overview-window-control') || document.body).display !== 'none',
    visibleWindowHeaders: visible,
  }
})
console.log('narrow:', JSON.stringify(narrowState, null, 2))
await browser.close()
