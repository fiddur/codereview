import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

await page.goto('http://localhost:8080/login', { waitUntil: 'networkidle0' })
await page.type('input#user', 'qsreddit_demo')
await page.type('input#pass', 'demopassword123!')
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null),
  page.click('button[type="submit"]'),
])
await page.goto('http://localhost:8080/places', { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 1500))

// Click "Named" tab
const tabHit = await page.evaluate(() => {
  const els = [...document.querySelectorAll('button, a, label, span, div')]
  const tab = els.find((e) => (e.textContent || '').trim() === 'Named')
  if (tab) { (tab.closest('button,label,a') || tab).click(); return tab.tagName }
  return null
})
console.log('Named tab clicked via', tabHit)
await new Promise((r) => setTimeout(r, 800))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/37-places-named-tab.png', fullPage: true })

// Find Home in the *main content area* (not sidebar)
const homeHit = await page.evaluate(() => {
  // restrict to the places main column
  const main = document.querySelector('main, .places-page, [class*="places"]') || document.body
  const candidates = [...main.querySelectorAll('button, li, .place, .place-card, a')]
  for (const el of candidates) {
    const txt = (el.textContent || '').trim()
    if (/^Home\b/.test(txt) && !/^Home$/i.test(el.getAttribute('href') || '')) {
      const target = el.closest('button, li, .place, .place-card') || el
      target.click()
      return { txt, tag: el.tagName, outer: el.outerHTML.slice(0,160) }
    }
  }
  return null
})
console.log('Home clicked:', homeHit)
await new Promise((r) => setTimeout(r, 1000))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/38-places-modal.png', fullPage: true })

const checks = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input[type="checkbox"]')]
  return inputs.map((i) => {
    const lab = i.closest('label') || (i.id ? document.querySelector(`label[for="${i.id}"]`) : null)
    return { id: i.id, name: i.name, checked: i.checked, label: lab?.textContent?.trim() }
  })
})
console.log('checkboxes:', JSON.stringify(checks, null, 2))

await browser.close()
